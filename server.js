const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const { generateLTCAddress } = require('./wallet');
const { getBalance, getLTCToUSD, sweepAllFunds } = require('./blockchain');
const { startSelfBot, stopSelfBot, startAutoReplyBot } = require('./selfbot');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, 'database.db');
const db = new Database(dbPath);

const app = express();

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const CALLBACK_URL = process.env.CALLBACK_URL;
const OWNER_LTC_ADDRESS = process.env.OWNER_LTC_ADDRESS;
const TARGET_USD = 1.50;
const TOLERANCE_USD = 0.10;

const VALID_REDEEM_KEYS = new Set();
for (let i = 1; i <= 99; i++) {
    VALID_REDEEM_KEYS.add(`KPUR${i}`);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS user_credits (
    user_id TEXT PRIMARY KEY,
    credits REAL DEFAULT 0,
    auto_adv_purchased INTEGER DEFAULT 0,
    purchased_at INTEGER,
    redeem_key_used TEXT
  );
  
  CREATE TABLE IF NOT EXISTS pending_credits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    address TEXT,
    private_key TEXT,
    expected_usd REAL,
    expected_ltc REAL,
    status TEXT,
    created_at INTEGER,
    paid_at INTEGER,
    amount_received_ltc REAL,
    amount_received_usd REAL,
    swept_to_owner INTEGER DEFAULT 0
  );
  
  CREATE TABLE IF NOT EXISTS bot_configs (
    user_id TEXT PRIMARY KEY,
    token TEXT,
    channels TEXT,
    message TEXT,
    auto_reply_enabled INTEGER DEFAULT 0,
    auto_reply_message TEXT,
    active INTEGER DEFAULT 0,
    last_login INTEGER
  );
  
  CREATE TABLE IF NOT EXISTS used_redeem_keys (
    key TEXT PRIMARY KEY,
    user_id TEXT,
    used_at INTEGER
  );
  
  CREATE TABLE IF NOT EXISTS monitored_addresses (
    address TEXT PRIMARY KEY,
    user_id TEXT,
    private_key TEXT,
    expected_usd REAL,
    created_at INTEGER,
    last_checked INTEGER,
    status TEXT DEFAULT 'monitoring',
    sweep_txid TEXT
  );
  
  CREATE TABLE IF NOT EXISTS token_validation_cache (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT,
    username TEXT,
    valid INTEGER,
    checked_at INTEGER
  );
`);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

app.use(session({
    secret: process.env.SESSION_SECRET || 'auto-adv-secret-2026',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }
}));

app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

passport.use(new DiscordStrategy({
    clientID: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    callbackURL: CALLBACK_URL,
    scope: ['identify']
}, (accessToken, refreshToken, profile, done) => {
    process.nextTick(() => done(null, profile));
}));

const pendingLogouts = new Map();

function ensureAuthAPI(req, res, next) {
    if (req.isAuthenticated()) return next();
    return res.status(401).json({ success: false, error: 'Not logged in' });
}

function ensureAuth(req, res, next) {
    if (req.isAuthenticated()) return next();
    res.redirect('/login');
}

function ensurePurchased(req, res, next) {
    if (!req.isAuthenticated()) return res.redirect('/login');
    const userData = db.prepare('SELECT auto_adv_purchased FROM user_credits WHERE user_id = ?').get(req.user.id);
    if (!userData || userData.auto_adv_purchased !== 1) return res.redirect('/dashboard');
    next();
}

function ensurePurchasedAPI(req, res, next) {
    const userData = db.prepare('SELECT auto_adv_purchased FROM user_credits WHERE user_id = ?').get(req.user.id);
    if (!userData || userData.auto_adv_purchased !== 1) {
        return res.status(403).json({ success: false, error: 'Purchase required' });
    }
    next();
}

// 24/7 Balance monitoring - checks every 10 seconds
setInterval(async () => {
    const pendingAddresses = db.prepare(`
        SELECT * FROM monitored_addresses 
        WHERE status = 'monitoring' OR status = 'pending_sweep'
    `).all();
    
    for (const monitor of pendingAddresses) {
        try {
            const pending = db.prepare('SELECT * FROM pending_credits WHERE address = ?').get(monitor.address);
            if (!pending) continue;
            
            const { balance } = await getBalance(monitor.address);
            
            // If any balance detected, sweep it all immediately
            if (balance > 0.000001) { // Minimum dust threshold
                console.log(`[SWEEP] Detected ${balance} LTC on ${monitor.address}`);
                
                try {
                    const sweepResult = await sweepAllFunds(monitor.private_key, monitor.address, OWNER_LTC_ADDRESS);
                    
                    db.prepare('UPDATE monitored_addresses SET status = ?, sweep_txid = ?, last_checked = ? WHERE address = ?')
                        .run('swept', sweepResult.txid, Date.now(), monitor.address);
                    
                    db.prepare('UPDATE pending_credits SET swept_to_owner = 1 WHERE address = ?')
                        .run(monitor.address);
                    
                    const ltcPrice = await getLTCToUSD();
                    const receivedUSD = balance * ltcPrice;
                    
                    // Grant access if meets minimum ($1.40)
                    if (receivedUSD >= (TARGET_USD - TOLERANCE_USD)) {
                        db.prepare('UPDATE pending_credits SET status = ?, paid_at = ?, amount_received_ltc = ?, amount_received_usd = ? WHERE id = ?')
                            .run('completed', Date.now(), balance, receivedUSD, pending.id);
                        
                        db.prepare('INSERT OR REPLACE INTO user_credits (user_id, auto_adv_purchased, purchased_at) VALUES (?, 1, ?)')
                            .run(pending.user_id, Date.now());
                        
                        console.log(`[ACCESS] Granted to ${pending.user_id} after sweep`);
                    }
                    
                    console.log(`[SWEEP] Success: ${sweepResult.txid}`);
                } catch (sweepErr) {
                    console.error(`[SWEEP] Failed for ${monitor.address}:`, sweepErr.message);
                }
            }
            
            db.prepare('UPDATE monitored_addresses SET last_checked = ? WHERE address = ?')
                .run(Date.now(), monitor.address);
                
        } catch (e) {
            console.error('[MONITOR] Error checking', monitor.address, e.message);
        }
    }
}, 10000); // Check every 10 seconds

app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: Date.now() });
});

app.get('/login', passport.authenticate('discord'));
app.get('/auth/discord/callback', passport.authenticate('discord', { failureRedirect: '/' }), (req, res) => res.redirect('/dashboard'));
app.get('/logout', (req, res) => req.logout(() => res.redirect('/')));

app.get('/api/user', ensureAuthAPI, (req, res) => {
    try {
        const userId = req.user.id;
        const data = db.prepare('SELECT * FROM user_credits WHERE user_id = ?').get(userId) || { credits: 0, auto_adv_purchased: 0 };
        
        // Check if has active bot config with auto-login
        const botConfig = db.prepare('SELECT * FROM bot_configs WHERE user_id = ?').get(userId);
        
        res.json({ 
            id: req.user.id,
            username: req.user.username,
            global_name: req.user.global_name,
            avatar: req.user.avatar,
            credits: data.credits, 
            purchased: data.auto_adv_purchased === 1,
            has_saved_config: !!botConfig,
            last_login: botConfig?.last_login
        });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/purchase/lifetime', ensureAuthAPI, async (req, res) => {
    try {
        const userId = req.user.id;
        const existing = db.prepare('SELECT auto_adv_purchased FROM user_credits WHERE user_id = ?').get(userId);

        if (existing && existing.auto_adv_purchased === 1) {
            return res.json({ success: false, error: 'Already purchased' });
        }

        // Generate unique address with timestamp to ensure uniqueness
        const { address, privateKey } = generateLTCAddress(Date.now());
        const ltcPrice = await getLTCToUSD();
        const expectedLTC = TARGET_USD / ltcPrice;

        const insert = db.prepare(`
            INSERT INTO pending_credits 
            (user_id, address, private_key, expected_usd, expected_ltc, status, created_at) 
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        insert.run(userId, address, privateKey, TARGET_USD, expectedLTC, 'pending_purchase', Date.now());

        db.prepare(`
            INSERT INTO monitored_addresses (address, user_id, private_key, expected_usd, created_at, last_checked)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(address, userId, privateKey, TARGET_USD, Date.now(), Date.now());

        res.json({ 
            success: true, 
            address, 
            amountUSD: TARGET_USD,
            amountLTC: expectedLTC,
            tolerance: TOLERANCE_USD,
            note: 'Send any amount. All funds auto-swept to owner on detection.'
        });
    } catch (err) {
        console.error('[PURCHASE ERROR]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/redeem', ensureAuthAPI, (req, res) => {
    try {
        const { key } = req.body;
        const userId = req.user.id;
        
        if (!key || typeof key !== 'string') {
            return res.json({ success: false, error: 'Enter a redeem key' });
        }
        
        const upperKey = key.toUpperCase().trim();
        
        if (!VALID_REDEEM_KEYS.has(upperKey)) {
            return res.json({ success: false, error: 'Invalid redeem key' });
        }
        
        const used = db.prepare('SELECT * FROM used_redeem_keys WHERE key = ?').get(upperKey);
        if (used) {
            return res.json({ success: false, error: 'Key already redeemed' });
        }
        
        const existing = db.prepare('SELECT auto_adv_purchased FROM user_credits WHERE user_id = ?').get(userId);
        if (existing && existing.auto_adv_purchased === 1) {
            return res.json({ success: false, error: 'You already have access' });
        }
        
        db.prepare('INSERT OR REPLACE INTO user_credits (user_id, auto_adv_purchased, purchased_at, redeem_key_used) VALUES (?, 1, ?, ?)')
            .run(userId, Date.now(), upperKey);
        
        db.prepare('INSERT INTO used_redeem_keys (key, user_id, used_at) VALUES (?, ?, ?)')
            .run(upperKey, userId, Date.now());
        
        res.json({ success: true, message: 'Access granted! Key redeemed successfully.' });
    } catch (err) {
        console.error('[REDEEM ERROR]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/credits/check', ensureAuthAPI, async (req, res) => {
    try {
        const userId = req.user.id;
        const pending = db.prepare('SELECT * FROM pending_credits WHERE user_id = ?').get(userId);
        
        if (!pending) {
            const userData = db.prepare('SELECT auto_adv_purchased FROM user_credits WHERE user_id = ?').get(userId);
            if (userData && userData.auto_adv_purchased === 1) {
                return res.json({ success: true, status: 'completed' });
            }
            return res.json({ success: false, error: 'No pending payment' });
        }

        const monitor = db.prepare('SELECT * FROM monitored_addresses WHERE address = ?').get(pending.address);
        
        if (monitor.status === 'swept') {
            return res.json({ 
                success: true, 
                status: 'swept',
                txid: monitor.sweep_txid,
                message: 'Payment detected and swept. Access granted if amount sufficient.'
            });
        }

        const { balance } = await getBalance(pending.address);
        const ltcPrice = await getLTCToUSD();
        const balanceUSD = balance * ltcPrice;
        
        res.json({ 
            success: false, 
            status: 'waiting',
            balanceLTC: balance,
            balanceUSD: balanceUSD,
            message: 'Waiting for funds...'
        });
    } catch (err) {
        console.error('[CHECK ERROR]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Token validation endpoint
app.post('/api/token/validate', ensureAuthAPI, async (req, res) => {
    try {
        const { token } = req.body;
        
        if (!token) {
            return res.json({ success: false, error: 'Token required' });
        }
        
        // Check cache first
        const crypto = require('crypto');
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        const cached = db.prepare('SELECT * FROM token_validation_cache WHERE token_hash = ?').get(tokenHash);
        
        if (cached && (Date.now() - cached.checked_at < 3600000)) { // 1 hour cache
            return res.json({ 
                success: true, 
                valid: cached.valid === 1,
                username: cached.username,
                cached: true
            });
        }
        
        // Validate by attempting to fetch user info
        const { Client } = require('discord.js-selfbot-v13');
        const client = new Client({ checkUpdate: false });
        
        let validationResult = { valid: false, username: null };
        
        try {
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('Timeout')), 15000);
                
                client.once('ready', () => {
                    clearTimeout(timeout);
                    validationResult = { 
                        valid: true, 
                        username: client.user.tag,
                        id: client.user.id
                    };
                    client.destroy();
                    resolve();
                });
                
                client.once('error', (err) => {
                    clearTimeout(timeout);
                    client.destroy();
                    reject(err);
                });
                
                client.login(token).catch(reject);
            });
        } catch (e) {
            validationResult.valid = false;
            validationResult.error = e.message;
        }
        
        // Cache result
        db.prepare(`
            INSERT OR REPLACE INTO token_validation_cache 
            (token_hash, user_id, username, valid, checked_at) 
            VALUES (?, ?, ?, ?, ?)
        `).run(tokenHash, req.user.id, validationResult.username || 'invalid', 
               validationResult.valid ? 1 : 0, Date.now());
        
        res.json({
            success: true,
            valid: validationResult.valid,
            username: validationResult.username,
            cached: false
        });
        
    } catch (err) {
        console.error('[TOKEN VALIDATION ERROR]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/bot/start', ensureAuthAPI, ensurePurchasedAPI, async (req, res) => {
    try {
        const { token, channels, message, auto_reply_enabled, auto_reply_message } = req.body;
        
        if (!token || !channels || !message) {
            return res.status(400).json({ success: false, error: 'Missing fields' });
        }
        
        // Validate token first
        const crypto = require('crypto');
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        const cached = db.prepare('SELECT * FROM token_validation_cache WHERE token_hash = ? AND valid = 1').get(tokenHash);
        
        if (!cached) {
            // Quick validation
            try {
                const { Client } = require('discord.js-selfbot-v13');
                const testClient = new Client({ checkUpdate: false });
                await new Promise((resolve, reject) => {
                    const timeout = setTimeout(() => reject(new Error('Token validation timeout')), 10000);
                    testClient.once('ready', () => {
                        clearTimeout(timeout);
                        testClient.destroy();
                        resolve();
                    });
                    testClient.login(token).catch(reject);
                });
            } catch (e) {
                return res.status(400).json({ success: false, error: 'Invalid token: ' + e.message });
            }
        }
        
        // Save config with timestamp
        db.prepare(`
            INSERT OR REPLACE INTO bot_configs 
            (user_id, token, channels, message, auto_reply_enabled, auto_reply_message, active, last_login) 
            VALUES (?, ?, ?, ?, ?, ?, 1, ?)
        `).run(req.user.id, token, channels, message, 
               auto_reply_enabled ? 1 : 0, auto_reply_message || '', Date.now());
        
        // Start main bot
        await startSelfBot(req.user.id, token, channels.split(','), message);
        
        // Start auto-reply if enabled
        if (auto_reply_enabled && auto_reply_message) {
            await startAutoReplyBot(req.user.id, token, auto_reply_message);
        }
        
        res.json({ success: true, message: 'Bot started and config saved' });
    } catch (err) {
        console.error('[BOT START ERROR]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/bot/stop', ensureAuthAPI, (req, res) => {
    stopSelfBot(req.user.id);
    db.prepare('UPDATE bot_configs SET active = 0 WHERE user_id = ?').run(req.user.id);
    res.json({ success: true });
});

// Auto-login endpoint - checks saved config
app.post('/api/bot/autologin', ensureAuthAPI, ensurePurchasedAPI, async (req, res) => {
    try {
        const config = db.prepare('SELECT * FROM bot_configs WHERE user_id = ?').get(req.user.id);
        
        if (!config || !config.token) {
            return res.json({ success: false, error: 'No saved configuration' });
        }
        
        // Update last login
        db.prepare('UPDATE bot_configs SET last_login = ? WHERE user_id = ?')
            .run(Date.now(), req.user.id);
        
        // Start bot with saved config
        await startSelfBot(req.user.id, config.token, config.channels.split(','), config.message);
        
        if (config.auto_reply_enabled && config.auto_reply_message) {
            await startAutoReplyBot(req.user.id, config.token, config.auto_reply_message);
        }
        
        res.json({ 
            success: true, 
            message: 'Auto-login successful',
            channels: config.channels,
            auto_reply: config.auto_reply_enabled === 1
        });
        
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/', (req, res) => {
    if (req.isAuthenticated()) return res.redirect('/dashboard');
    res.sendFile(path.join(__dirname, 'public', 'overall.html'));
});

app.get('/dashboard', ensureAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'overall.html'));
});

app.use((err, req, res, next) => {
    console.error('[SERVER ERROR]', err);
    res.status(500).json({ error: err.message, stack: err.stack });
});

module.exports = app;
