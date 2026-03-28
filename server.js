const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

const { generateLTCAddress, createTransaction } = require('./wallet');
const { startSelfBot, stopSelfBot, validateToken } = require('./selfbot');

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
for (let i = 1; i <= 99; i++) VALID_REDEEM_KEYS.add(`KPUR${i}`);

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
    address TEXT UNIQUE,
    private_key TEXT,
    expected_usd REAL,
    status TEXT DEFAULT 'monitoring',
    created_at INTEGER,
    paid_at INTEGER,
    amount_received_ltc REAL,
    sweep_txid TEXT
  );
  
  CREATE TABLE IF NOT EXISTS bot_configs (
    user_id TEXT PRIMARY KEY,
    token TEXT,
    channels TEXT,
    message TEXT,
    auto_reply TEXT,
    active INTEGER DEFAULT 0,
    last_login INTEGER
  );
  
  CREATE TABLE IF NOT EXISTS used_redeem_keys (
    key TEXT PRIMARY KEY,
    user_id TEXT,
    used_at INTEGER
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
    cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 }
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

function ensurePurchasedAPI(req, res, next) {
    const userData = db.prepare('SELECT auto_adv_purchased FROM user_credits WHERE user_id = ?').get(req.user.id);
    if (!userData || userData.auto_adv_purchased !== 1) {
        return res.status(403).json({ success: false, error: 'Purchase required' });
    }
    next();
}

// Check balance using litecoinspace.org
async function checkAddressBalance(address) {
    try {
        const res = await axios.get(`https://litecoinspace.org/api/address/${address}`, {
            timeout: 15000,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const funded = res.data.chain_stats?.funded_txo_sum || 0;
        const spent = res.data.chain_stats?.spent_txo_sum || 0;
        return (funded - spent) / 100000000;
    } catch (e) {
        console.error('[BALANCE CHECK] Failed for', address, e.message);
        return 0;
    }
}

// Sweep all funds to owner
async function sweepAllFunds(address, privateKey, userId) {
    try {
        const balance = await checkAddressBalance(address);
        if (balance <= 0) return null;
        
        console.log(`[SWEEP] Found ${balance} LTC in ${address}, sweeping...`);
        
        const txid = await createTransaction(privateKey, address, OWNER_LTC_ADDRESS, balance);
        
        db.prepare('UPDATE pending_credits SET amount_received_ltc = ?, sweep_txid = ? WHERE address = ?')
            .run(balance, txid, address);
        
        // Grant access if meets minimum ($1.40)
        const ltcPrice = await getLTCToUSD();
        const usdValue = balance * ltcPrice;
        
        if (usdValue >= (TARGET_USD - TOLERANCE_USD)) {
            db.prepare('UPDATE pending_credits SET status = ?, paid_at = ? WHERE address = ?')
                .run('completed', Date.now(), address);
            
            db.prepare('INSERT OR REPLACE INTO user_credits (user_id, auto_adv_purchased, purchased_at) VALUES (?, 1, ?)')
                .run(userId, Date.now());
            
            console.log(`[SWEEP] Access granted to ${userId}`);
        }
        
        return txid;
    } catch (e) {
        console.error('[SWEEP] Failed:', e);
        return null;
    }
}

// 24/7 Monitoring loop - runs forever
function startMonitoring() {
    console.log('[MONITOR] 24/7 monitoring started');
    
    async function monitorLoop() {
        while (true) {
            try {
                const pending = db.prepare('SELECT * FROM pending_credits WHERE status = ?').all('monitoring');
                
                for (const row of pending) {
                    try {
                        const balance = await checkAddressBalance(row.address);
                        
                        if (balance > 0) {
                            console.log(`[MONITOR] Balance detected: ${balance} LTC in ${row.address}`);
                            await sweepAllFunds(row.address, row.private_key, row.user_id);
                        }
                    } catch (e) {
                        console.error('[MONITOR] Error:', e.message);
                    }
                }
                
                await new Promise(r => setTimeout(r, 10000)); // Check every 10 seconds
            } catch (e) {
                console.error('[MONITOR] Loop error:', e);
                await new Promise(r => setTimeout(r, 5000));
            }
        }
    }
    
    monitorLoop();
}

// Start monitoring immediately
startMonitoring();

let cachedPrice = 85;
async function getLTCToUSD() {
    try {
        const res = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=litecoin&vs_currencies=usd', { timeout: 5000 });
        cachedPrice = res.data.litecoin.usd;
    } catch (e) {}
    return cachedPrice;
}

app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

app.get('/login', passport.authenticate('discord'));
app.get('/auth/discord/callback', passport.authenticate('discord', { failureRedirect: '/' }), (req, res) => res.redirect('/dashboard'));
app.get('/logout', (req, res) => req.logout(() => res.redirect('/')));

app.get('/api/user', ensureAuthAPI, (req, res) => {
    try {
        const data = db.prepare('SELECT * FROM user_credits WHERE user_id = ?').get(req.user.id) || { credits: 0, auto_adv_purchased: 0 };
        res.json({ 
            id: req.user.id,
            username: req.user.username,
            global_name: req.user.global_name,
            avatar: req.user.avatar,
            credits: data.credits, 
            purchased: data.auto_adv_purchased === 1 
        });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/purchase/lifetime', ensureAuthAPI, async (req, res) => {
    try {
        const userId = req.user.id;
        const existing = db.prepare('SELECT auto_adv_purchased FROM user_credits WHERE user_id = ?').get(userId);
        if (existing?.auto_adv_purchased === 1) return res.json({ success: false, error: 'Already purchased' });

        const { address, privateKey } = generateLTCAddress();

        db.prepare(`
            INSERT INTO pending_credits (user_id, address, private_key, expected_usd, created_at) 
            VALUES (?, ?, ?, ?, ?)
        `).run(userId, address, privateKey, TARGET_USD, Date.now());

        res.json({ 
            success: true, 
            address, 
            amountUSD: TARGET_USD
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
        
        if (!key) return res.json({ success: false, error: 'Enter a key' });
        
        const upperKey = key.toUpperCase().trim();
        
        if (!VALID_REDEEM_KEYS.has(upperKey)) return res.json({ success: false, error: 'Invalid key' });
        if (db.prepare('SELECT * FROM used_redeem_keys WHERE key = ?').get(upperKey)) return res.json({ success: false, error: 'Key used' });
        
        const existing = db.prepare('SELECT auto_adv_purchased FROM user_credits WHERE user_id = ?').get(userId);
        if (existing?.auto_adv_purchased === 1) return res.json({ success: false, error: 'Already have access' });
        
        db.prepare('INSERT OR REPLACE INTO user_credits (user_id, auto_adv_purchased, purchased_at, redeem_key_used) VALUES (?, 1, ?, ?)')
            .run(userId, Date.now(), upperKey);
        
        db.prepare('INSERT INTO used_redeem_keys (key, user_id, used_at) VALUES (?, ?, ?)')
            .run(upperKey, userId, Date.now());
        
        res.json({ success: true, message: 'Access granted!' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/bot/start', ensureAuthAPI, ensurePurchasedAPI, async (req, res) => {
    try {
        const { token, channels, message, autoReply } = req.body;
        
        if (!token || !channels || !message) return res.status(400).json({ success: false, error: 'Missing fields' });
        
        const validation = await validateToken(token);
        if (!validation.valid) return res.json({ success: false, error: 'Invalid Discord token' });
        
        db.prepare('INSERT OR REPLACE INTO bot_configs (user_id, token, channels, message, auto_reply, active, last_login) VALUES (?, ?, ?, ?, ?, 1, ?)')
            .run(req.user.id, token, channels, message, autoReply || '', Date.now());
        
        await startSelfBot(req.user.id, token, channels.split(','), message, autoReply);
        
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/bot/stop', ensureAuthAPI, (req, res) => {
    try {
        stopSelfBot(req.user.id);
        db.prepare('UPDATE bot_configs SET active = 0 WHERE user_id = ?').run(req.user.id);
        res.json({ success: true });
    } catch (err) {
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
        req.logout(() => res.json({ success: true }));
    } else {
        res.json({ success: false, error: 'Invalid code' });
    }
});

app.get('/', (req, res) => {
    if (req.isAuthenticated()) return res.redirect('/dashboard');
    res.sendFile(path.join(__dirname, 'public', 'overall.html'));
});

app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'overall.html'));
});

app.use((err, req, res, next) => {
    console.error('[SERVER ERROR]', err);
    res.status(500).json({ error: err.message });
});

module.exports = app;
