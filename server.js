const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const axios = require('axios');

// Crash protection
process.on('uncaughtException', (err) => console.error('[FATAL]', err.message));
process.on('unhandledRejection', (reason) => console.error('[FATAL]', reason));

// Setup data directory
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
    try { fs.mkdirSync(dataDir, { recursive: true }); } catch(e) {}
}

// SQLite database (pure JS, no native build issues)
const dbPath = path.join(dataDir, 'database.db');
const db = new sqlite3.Database(dbPath);

// Promisify methods
db.runAsync = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
        if (err) reject(err);
        else resolve({ lastID: this.lastID, changes: this.changes });
    });
});

db.getAsync = (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
    });
});

db.allAsync = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
    });
});

// Initialize tables
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS user_credits (
        user_id TEXT PRIMARY KEY,
        auto_adv_purchased INTEGER DEFAULT 0,
        purchased_at INTEGER,
        redeem_key_used TEXT
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS pending_credits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        address TEXT UNIQUE,
        private_key TEXT,
        expected_usd REAL DEFAULT 1.50,
        status TEXT DEFAULT 'monitoring',
        created_at INTEGER,
        paid_at INTEGER,
        amount_received_ltc REAL
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS bot_configs (
        user_id TEXT PRIMARY KEY,
        token TEXT,
        channels TEXT,
        message TEXT,
        delay_seconds INTEGER DEFAULT 30,
        auto_reply_enabled INTEGER DEFAULT 0,
        auto_reply_text TEXT,
        active INTEGER DEFAULT 0
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS used_redeem_keys (
        key TEXT PRIMARY KEY,
        user_id TEXT,
        used_at INTEGER
    )`);
});

const app = express();

// HEALTH CHECK FIRST
app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// Session
app.use(session({
    secret: process.env.SESSION_SECRET || 'secret-key-2026',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

// Passport
app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const CALLBACK_URL = process.env.CALLBACK_URL;
const OWNER_LTC_ADDRESS = process.env.OWNER_LTC_ADDRESS;
const TARGET_USD = 1.50;
const TOLERANCE_USD = 0.10;

if (CLIENT_ID && CLIENT_SECRET) {
    passport.use(new DiscordStrategy({
        clientID: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        callbackURL: CALLBACK_URL,
        scope: ['identify']
    }, (accessToken, refreshToken, profile, done) => {
        process.nextTick(() => done(null, profile));
    }));
}

const VALID_REDEEM_KEYS = new Set();
for (let i = 1; i <= 99; i++) VALID_REDEEM_KEYS.add(`KPUR${i}`);

const pendingLogouts = new Map();

function ensureAuthAPI(req, res, next) {
    if (req.isAuthenticated()) return next();
    return res.status(401).json({ success: false, error: 'Not logged in' });
}

async function ensurePurchasedAPI(req, res, next) {
    try {
        const row = await db.getAsync('SELECT auto_adv_purchased FROM user_credits WHERE user_id = ?', [req.user.id]);
        if (!row || row.auto_adv_purchased !== 1) {
            return res.status(403).json({ success: false, error: 'Purchase required' });
        }
        next();
    } catch(e) {
        return res.status(500).json({ error: 'DB error' });
    }
}

// Routes
app.get('/login', passport.authenticate('discord'));
app.get('/auth/discord/callback', passport.authenticate('discord', { failureRedirect: '/' }), (req, res) => res.redirect('/'));
app.get('/logout', (req, res) => req.logout(() => res.redirect('/')));

app.get('/api/user', ensureAuthAPI, async (req, res) => {
    try {
        const row = await db.getAsync('SELECT * FROM user_credits WHERE user_id = ?', [req.user.id]);
        res.json({ 
            id: req.user.id,
            username: req.user.username,
            global_name: req.user.global_name,
            avatar: req.user.avatar,
            purchased: row ? row.auto_adv_purchased === 1 : false
        });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/purchase/lifetime', ensureAuthAPI, async (req, res) => {
    try {
        const userId = req.user.id;
        const existing = await db.getAsync('SELECT auto_adv_purchased FROM user_credits WHERE user_id = ?', [userId]);
        if (existing && existing.auto_adv_purchased === 1) {
            return res.json({ success: false, error: 'Already purchased' });
        }

        const { generateLTCAddress } = require('./wallet');
        const { address, privateKey } = generateLTCAddress();

        await db.runAsync(
            'INSERT INTO pending_credits (user_id, address, private_key, expected_usd, created_at) VALUES (?, ?, ?, ?, ?)',
            [userId, address, privateKey, TARGET_USD, Date.now()]
        );

        res.json({ success: true, address, amountUSD: TARGET_USD });
    } catch (err) {
        console.error('[PURCHASE ERROR]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/redeem', ensureAuthAPI, async (req, res) => {
    try {
        const { key } = req.body;
        const userId = req.user.id;
        
        if (!key) return res.json({ success: false, error: 'Enter a key' });
        const upperKey = key.toUpperCase().trim();
        
        if (!VALID_REDEEM_KEYS.has(upperKey)) return res.json({ success: false, error: 'Invalid key' });
        
        const used = await db.getAsync('SELECT * FROM used_redeem_keys WHERE key = ?', [upperKey]);
        if (used) return res.json({ success: false, error: 'Key used' });
        
        const existing = await db.getAsync('SELECT auto_adv_purchased FROM user_credits WHERE user_id = ?', [userId]);
        if (existing && existing.auto_adv_purchased === 1) return res.json({ success: false, error: 'Already have access' });
        
        await db.runAsync(
            'INSERT OR REPLACE INTO user_credits (user_id, auto_adv_purchased, purchased_at, redeem_key_used) VALUES (?, 1, ?, ?)',
            [userId, Date.now(), upperKey]
        );
        
        await db.runAsync('INSERT INTO used_redeem_keys (key, user_id, used_at) VALUES (?, ?, ?)', [upperKey, userId, Date.now()]);
        
        res.json({ success: true, message: 'Access granted!' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/bot/start', ensureAuthAPI, ensurePurchasedAPI, async (req, res) => {
    try {
        const { token, channels, message, delay, autoReplyEnabled, autoReplyText } = req.body;
        
        if (!token || !channels || !message) {
            return res.status(400).json({ success: false, error: 'Missing fields' });
        }
        
        const channelList = channels.split(',').map(c => c.trim()).filter(c => /^\d+$/.test(c));
        if (channelList.length === 0) {
            return res.json({ success: false, error: 'Invalid channel IDs' });
        }
        
        const { validateToken, startSelfBot } = require('./selfbot');
        const validation = await validateToken(token);
        if (!validation.valid) return res.json({ success: false, error: 'Invalid token' });
        
        const delaySeconds = parseInt(delay) || 30;
        const autoReply = autoReplyEnabled ? 1 : 0;
        
        await db.runAsync(
            `INSERT OR REPLACE INTO bot_configs (user_id, token, channels, message, delay_seconds, auto_reply_enabled, auto_reply_text, active) 
             VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
            [req.user.id, token, channels, message, delaySeconds, autoReply, autoReplyText || '']
        );
        
        await startSelfBot(req.user.id, token, channelList, message, delaySeconds * 1000, autoReply, autoReplyText);
        
        res.json({ success: true, username: validation.username });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/bot/stop', ensureAuthAPI, async (req, res) => {
    try {
        const { stopSelfBot } = require('./selfbot');
        stopSelfBot(req.user.id);
        await db.runAsync('UPDATE bot_configs SET active = 0 WHERE user_id = ?', [req.user.id]);
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

// Static files
app.get('/', (req, res) => {
    if (req.isAuthenticated()) return res.redirect('/dashboard');
    res.sendFile(path.join(__dirname, 'public', 'overall.html'));
});

app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'overall.html'));
});

// Error handler
app.use((err, req, res, next) => {
    console.error('[SERVER ERROR]', err);
    res.status(500).json({ error: err.message });
});

module.exports = app;
