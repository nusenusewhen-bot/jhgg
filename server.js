const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const { generateLTCAddress } = require('./wallet');
const { getBalance, getLTCToUSD, sendExcessToOwner } = require('./blockchain');
const { startSelfBot, stopSelfBot } = require('./selfbot');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, 'database.db');
const db = new Database(dbPath);

const app = express();

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const CALLBACK_URL = process.env.CALLBACK_URL;
const OWNER_LTC_ADDRESS = process.env.OWNER_LTC_ADDRESS; // Your address to receive excess
const TARGET_USD = 1.50; // $1.50 target
const TOLERANCE_USD = 0.10; // +/- $0.10 tolerance

// Generate redeem keys KPUR1 to KPUR99
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
    excess_sent_to_owner INTEGER DEFAULT 0
  );
  
  CREATE TABLE IF NOT EXISTS bot_configs (
    user_id TEXT PRIMARY KEY,
    token TEXT,
    channels TEXT,
    message TEXT,
    active INTEGER DEFAULT 0
  );
  
  CREATE TABLE IF NOT EXISTS used_redeem_keys (
    key TEXT PRIMARY KEY,
    user_id TEXT,
    used_at INTEGER
  );
  
  CREATE TABLE IF NOT EXISTS monitored_addresses (
    address TEXT PRIMARY KEY,
    user_id TEXT,
    expected_usd REAL,
    created_at INTEGER,
    last_checked INTEGER,
    status TEXT DEFAULT 'monitoring'
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

// Auto-monitor all pending addresses every 30 seconds
setInterval(async () => {
    const pendingAddresses = db.prepare(`
        SELECT * FROM monitored_addresses 
        WHERE status = 'monitoring'
    `).all();
    
    for (const monitor of pendingAddresses) {
        try {
            const pending = db.prepare('SELECT * FROM pending_credits WHERE address = ?').get(monitor.address);
            if (!pending) continue;
            
            const { balance } = await getBalance(monitor.address);
            const ltcPrice = await getLTCToUSD();
            const balanceUSD = balance * ltcPrice;
            
            // Check if within tolerance ($1.50 +/- $0.10 = $1.40 to $1.60)
            const minAcceptable = TARGET_USD - TOLERANCE_USD; // $1.40
            const maxAcceptable = TARGET_USD + TOLERANCE_USD; // $1.60
            
            if (balanceUSD >= minAcceptable) {
                let excessSent = 0;
                
                // If over $1.60, send excess to owner
                if (balanceUSD > maxAcceptable && OWNER_LTC_ADDRESS) {
                    const excessLTC = (balanceUSD - TARGET_USD) / ltcPrice;
                    try {
                        await sendExcessToOwner(pending.private_key, monitor.address, excessLTC, OWNER_LTC_ADDRESS);
                        excessSent = 1;
                        console.log(`[MONITOR] Excess ${excessLTC} LTC sent to owner from ${monitor.address}`);
                    } catch (e) {
                        console.error('[MONITOR] Failed to send excess:', e);
                    }
                }
                
                // Grant access
                db.prepare('UPDATE pending_credits SET status = ?, paid_at = ?, amount_received_ltc = ?, amount_received_usd = ?, excess_sent_to_owner = ? WHERE id = ?')
                    .run('completed', Date.now(), balance, balanceUSD, excessSent, pending.id);
                
                db.prepare('INSERT OR REPLACE INTO user_credits (user_id, auto_adv_purchased, purchased_at) VALUES (?, 1, ?)')
                    .run(pending.user_id, Date.now());
                
                db.prepare('UPDATE monitored_addresses SET status = ? WHERE address = ?')
                    .run('completed', monitor.address);
                
                console.log(`[MONITOR] Payment confirmed for ${pending.user_id}: $${balanceUSD.toFixed(2)}`);
            }
            
            db.prepare('UPDATE monitored_addresses SET last_checked = ? WHERE address = ?')
                .run(Date.now(), monitor.address);
                
        } catch (e) {
            console.error('[MONITOR] Error checking', monitor.address, e.message);
        }
    }
}, 30000); // Check every 30 seconds

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
        res.json({ 
            id: req.user.id,
            username: req.user.username,
            global_name: req.user.global_name,
            avatar: req.user.avatar,
            credits: data.credits, 
            purchased: data.auto_adv_purchased === 1 
        });
    } catch(e) {
        console.error('[API USER ERROR]', e);
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

        const { address, privateKey } = generateLTCAddress();
        const ltcPrice = await getLTCToUSD();
        const expectedLTC = TARGET_USD / ltcPrice;

        const insert = db.prepare(`
            INSERT INTO pending_credits 
            (user_id, address, private_key, expected_usd, expected_ltc, status, created_at) 
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        insert.run(userId, address, privateKey, TARGET_USD, expectedLTC, 'pending_purchase', Date.now());

        // Add to monitoring
        db.prepare(`
            INSERT INTO monitored_addresses (address, user_id, expected_usd, created_at, last_checked)
            VALUES (?, ?, ?, ?, ?)
        `).run(address, userId, TARGET_USD, Date.now(), Date.now());

        res.json({ 
            success: true, 
            address, 
            amountUSD: TARGET_USD,
            amountLTC: expectedLTC,
            tolerance: TOLERANCE_USD,
            message: `Send $${TARGET_USD.toFixed(2)} worth of LTC (approx ${expectedLTC.toFixed(6)} LTC). Acceptable range: $${(TARGET_USD - TOLERANCE_USD).toFixed(2)} - $${(TARGET_USD + TOLERANCE_USD).toFixed(2)}`
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
        
        // Check if valid format
        if (!VALID_REDEEM_KEYS.has(upperKey)) {
            return res.json({ success: false, error: 'Invalid redeem key' });
        }
        
        // Check if already used
        const used = db.prepare('SELECT * FROM used_redeem_keys WHERE key = ?').get(upperKey);
        if (used) {
            return res.json({ success: false, error: 'Key already redeemed' });
        }
        
        // Check if user already has access
        const existing = db.prepare('SELECT auto_adv_purchased FROM user_credits WHERE user_id = ?').get(userId);
        if (existing && existing.auto_adv_purchased === 1) {
            return res.json({ success: false, error: 'You already have access' });
        }
        
        // Grant access
        db.prepare('INSERT OR REPLACE INTO user_credits (user_id, auto_adv_purchased, purchased_at, redeem_key_used) VALUES (?, 1, ?, ?)')
            .run(userId, Date.now(), upperKey);
        
        db.prepare('INSERT INTO used_redeem_keys (key, user_id, used_at) VALUES (?, ?, ?)')
            .run(upperKey, userId, Date.now());
        
        console.log(`[REDEEM] ${upperKey} used by ${userId}`);
        
        res.json({ 
            success: true, 
            message: 'Access granted! Key redeemed successfully.' 
        });
    } catch (err) {
        console.error('[REDEEM ERROR]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/credits/check', ensureAuthAPI, async (req, res) => {
    try {
        const userId = req.user.id;
        const pending = db.prepare('SELECT * FROM pending_credits WHERE user_id = ? AND status = ?').get(userId, 'pending_purchase');

        if (!pending) {
            // Check if already completed
            const userData = db.prepare('SELECT auto_adv_purchased FROM user_credits WHERE user_id = ?').get(userId);
            if (userData && userData.auto_adv_purchased === 1) {
                return res.json({ success: true, status: 'completed' });
            }
            return res.json({ success: false, error: 'No pending payment' });
        }

        const { balance } = await getBalance(pending.address);
        const ltcPrice = await getLTCToUSD();
        const balanceUSD = balance * ltcPrice;
        
        const minAcceptable = TARGET_USD - TOLERANCE_USD;

        if (balanceUSD >= minAcceptable) {
            return res.json({ 
                success: true, 
                status: 'detected',
                receivedUSD: balanceUSD,
                receivedLTC: balance
            });
        }
        
        res.json({ 
            success: false, 
            status: 'waiting',
            receivedUSD: balanceUSD,
            receivedLTC: balance,
            requiredUSD: TARGET_USD,
            requiredLTC: pending.expected_ltc
        });
    } catch (err) {
        console.error('[CHECK ERROR]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/logout/request', ensureAuthAPI, (req, res) => {
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    pendingLogouts.set(req.user.id, code);
    res.json({ success: true });
});

app.post('/api/logout/verify', ensureAuthAPI, (req, res) => {
    const { code } = req.body;
    const stored = pendingLogouts.get(req.user.id);
    
    if (stored === code) {
        pendingLogouts.delete(req.user.id);
        req.logout(() => {
            res.json({ success: true });
        });
    } else {
        res.json({ success: false, error: 'Invalid code' });
    }
});

app.post('/api/bot/start', ensureAuthAPI, ensurePurchasedAPI, async (req, res) => {
    try {
        const { token, channels, message } = req.body;
        
        if (!token || !channels || !message) {
            return res.status(400).json({ success: false, error: 'Missing fields' });
        }
        
        db.prepare('INSERT OR REPLACE INTO bot_configs (user_id, token, channels, message, active) VALUES (?, ?, ?, ?, 1)')
            .run(req.user.id, token, channels, message);
        
        await startSelfBot(req.user.id, token, channels.split(','), message);
        
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/bot/stop', ensureAuthAPI, (req, res) => {
    stopSelfBot(req.user.id);
    db.prepare('UPDATE bot_configs SET active = 0 WHERE user_id = ?').run(req.user.id);
    res.json({ success: true });
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
    res.status(500).send('Server error: ' + err.message);
});

module.exports = app;
