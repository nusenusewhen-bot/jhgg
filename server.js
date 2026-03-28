const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const { generateLTCAddress } = require('./wallet');
const { getBalance } = require('./blockchain');
const { startSelfBot, stopSelfBot } = require('./selfbot');

const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });

const db = new Database('./data.db');
const app = express();

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const CALLBACK_URL = process.env.CALLBACK_URL;

// Initialize database tables
db.exec(`
  CREATE TABLE IF NOT EXISTS user_credits (
    user_id TEXT PRIMARY KEY,
    credits REAL DEFAULT 0,
    auto_adv_purchased INTEGER DEFAULT 0,
    purchased_at INTEGER
  );
  
  CREATE TABLE IF NOT EXISTS pending_credits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    address TEXT,
    private_key TEXT,
    expected_amount REAL,
    credits_to_add REAL,
    status TEXT,
    created_at INTEGER,
    paid_at INTEGER
  );
  
  CREATE TABLE IF NOT EXISTS bot_configs (
    user_id TEXT PRIMARY KEY,
    token TEXT,
    channels TEXT,
    message TEXT,
    active INTEGER DEFAULT 0
  );
`);

app.use(express.json());
app.use(express.static(publicDir));

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

app.get('/health', (req, res) => res.status(200).send('OK'));

app.get('/login', passport.authenticate('discord'));
app.get('/auth/discord/callback', passport.authenticate('discord', { failureRedirect: '/' }), (req, res) => res.redirect('/dashboard'));
app.get('/logout', (req, res) => req.logout(() => res.redirect('/')));

app.get('/api/user', ensureAuthAPI, (req, res) => {
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
});

app.post('/api/purchase/lifetime', ensureAuthAPI, (req, res) => {
    try {
        const userId = req.user.id;
        const existing = db.prepare('SELECT auto_adv_purchased FROM user_credits WHERE user_id = ?').get(userId);

        if (existing && existing.auto_adv_purchased === 1) {
            return res.json({ success: false, error: 'Already purchased' });
        }

        const { address, privateKey } = generateLTCAddress();

        db.prepare('INSERT INTO pending_credits (user_id, address, private_key, expected_amount, credits_to_add, status, created_at)')
            .run(userId, address, privateKey, 0.000015, 0, 'pending_purchase', Date.now());

        res.json({ success: true, address, amount: 0.000015 });
    } catch (err) {
        console.error('[PURCHASE ERROR]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/credits/check', ensureAuthAPI, async (req, res) => {
    try {
        const userId = req.user.id;
        const pending = db.prepare('SELECT * FROM pending_credits WHERE user_id = ? AND (status = "pending" OR status = "pending_purchase")').get(userId);

        if (!pending) return res.json({ success: false, error: 'No pending payment' });

        const { balance } = await getBalance(pending.address);

        if (balance >= pending.expected_amount * 0.9) {
            db.prepare('UPDATE pending_credits SET status = ?, paid_at = ? WHERE id = ?').run('completed', Date.now(), pending.id);

            if (pending.status === 'pending_purchase') {
                db.prepare('INSERT OR REPLACE INTO user_credits (user_id, auto_adv_purchased, purchased_at) VALUES (?, 1, ?)').run(userId, Date.now());
            }
            return res.json({ success: true });
        }
        res.json({ success: false });
    } catch (err) {
        console.error('[CHECK ERROR]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/logout/request', ensureAuthAPI, (req, res) => {
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    pendingLogouts.set(req.user.id, code);
    console.log(`[LOGOUT] Code for ${req.user.id}: ${code}`);
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
    res.sendFile(path.join(publicDir, 'overall.html'));
});

app.get('/dashboard', ensureAuth, (req, res) => {
    res.sendFile(path.join(publicDir, 'overall.html'));
});

app.get('/purchase', ensureAuth, (req, res) => res.redirect('/dashboard'));
app.get('/configure', ensureAuth, (req, res) => res.redirect('/dashboard'));
app.get('/credits', ensureAuth, (req, res) => res.redirect('/dashboard'));

app.use((err, req, res, next) => {
    console.error('[SERVER ERROR]', err);
    res.status(500).send('Server error');
});

module.exports = app;
