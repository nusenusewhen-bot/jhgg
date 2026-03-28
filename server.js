const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { generateLTCAddress } = require('./wallet');

const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) {
    fs.mkdirSync(publicDir, { recursive: true });
}

const db = new Database('./data.db');
const app = express();

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const CALLBACK_URL = process.env.CALLBACK_URL;
const SECRET_PROMO_CODE = 'INFINITE2024';

app.use(express.json());
app.use(express.static(publicDir));
app.use(session({
    secret: process.env.SESSION_SECRET || 'fallback-secret',
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
    scope: ['identify', 'guilds', 'bot']
}, (accessToken, refreshToken, profile, done) => {
    process.nextTick(() => done(null, profile));
}));

function ensureAuth(req, res, next) {
    if (req.isAuthenticated()) return next();
    res.redirect('/login');
}

// HEALTH CHECK - Required for Railway
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

app.get('/login', passport.authenticate('discord'));

app.get('/auth/discord/callback', 
    passport.authenticate('discord', { failureRedirect: '/' }),
    (req, res) => {
        const guildId = process.env.GUILD_ID;
        const hasBot = req.user.guilds && req.user.guilds.some(g => g.id === guildId);
        if (!hasBot && guildId) {
            return res.redirect(`https://discord.com/oauth2/authorize?client_id=${CLIENT_ID}&scope=bot&permissions=8&guild_id=${guildId}`);
        }
        res.redirect('/dashboard');
    }
);

app.get('/api/user', ensureAuth, (req, res) => {
    try {
        const userId = req.user.id;
        const credits = db.prepare('SELECT * FROM user_credits WHERE user_id = ?').get(userId) || { credits: 0, auto_adv_purchased: 0 };
        const wallets = db.prepare('SELECT * FROM wallets WHERE user_id = ?').all(userId);
        const transactions = db.prepare('SELECT * FROM transactions WHERE wallet_address IN (SELECT address FROM wallets WHERE user_id = ?)').all(userId);
        
        res.json({ user: req.user, credits, wallets, transactions });
    } catch (err) {
        console.error('[API ERROR]', err);
        res.status(500).json({ error: 'Database error' });
    }
});

app.post('/api/purchase/auto-adv', ensureAuth, (req, res) => {
    try {
        const userId = req.user.id;
        const userData = db.prepare('SELECT * FROM user_credits WHERE user_id = ?').get(userId);
        
        if (userData && userData.auto_adv_purchased) {
            return res.json({ success: false, error: 'Already purchased' });
        }
        
        if (!userData || userData.credits < 1.2) {
            return res.json({ success: false, error: 'Insufficient credits (need $1.20)' });
        }
        
        db.prepare('INSERT OR REPLACE INTO user_credits (user_id, credits, auto_adv_purchased, purchased_at) VALUES (?, ?, ?, ?)')
            .run(userId, (userData?.credits || 0) - 1.2, 1, Date.now());
        
        const { address, privateKey, mnemonic } = generateLTCAddress();
        db.prepare('INSERT INTO wallets (user_id, address, private_key, mnemonic, created_at, last_checked) VALUES (?, ?, ?, ?, ?, ?)')
            .run(userId, address, privateKey, mnemonic, Date.now(), Date.now());
        
        res.json({ success: true, message: 'Auto Adv purchased! Check your dashboard.', wallet: address });
    } catch (err) {
        console.error('[PURCHASE ERROR]', err);
        res.status(500).json({ success: false, error: 'Purchase failed' });
    }
});

app.post('/api/purchase/credits', ensureAuth, (req, res) => {
    try {
        const { amount, promoCode } = req.body;
        const userId = req.user.id;
        
        let creditsToAdd = parseFloat(amount) || 0;
        if (promoCode === SECRET_PROMO_CODE) creditsToAdd = 999999;
        
        const current = db.prepare('SELECT credits FROM user_credits WHERE user_id = ?').get(userId);
        const newBalance = (current?.credits || 0) + creditsToAdd;
        
        db.prepare('INSERT OR REPLACE INTO user_credits (user_id, credits, auto_adv_purchased, purchased_at) VALUES (?, ?, COALESCE((SELECT auto_adv_purchased FROM user_credits WHERE user_id = ?), 0), COALESCE((SELECT purchased_at FROM user_credits WHERE user_id = ?), ?))')
            .run(userId, newBalance, userId, userId, Date.now());
        
        res.json({ success: true, credits: newBalance });
    } catch (err) {
        console.error('[CREDITS ERROR]', err);
        res.status(500).json({ success: false, error: 'Failed to add credits' });
    }
});

app.get('/dashboard', ensureAuth, (req, res) => {
    res.sendFile(path.join(publicDir, 'dashboard.html'));
});

app.get('/purchase', ensureAuth, (req, res) => {
    res.sendFile(path.join(publicDir, 'purchase.html'));
});

app.get('/tos', (req, res) => {
    res.sendFile(path.join(publicDir, 'tos.html'));
});

app.get('/logout', (req, res) => {
    req.logout(() => res.redirect('/'));
});

app.get('/', (req, res) => {
    if (req.isAuthenticated()) return res.redirect('/dashboard');
    res.send(`<!DOCTYPE html>
<html>
<head>
    <title>Auto Adv</title>
    <style>
        *{margin:0;padding:0;box-sizing:border-box;font-family:Segoe UI,sans-serif}
        body{background:#1a1a1a;color:#fff;display:flex;justify-content:center;align-items:center;height:100vh;flex-direction:column}
        .btn{background:#00ff88;color:#000;border:none;padding:20px 50px;font-size:20px;border-radius:5px;cursor:pointer;font-weight:bold;text-decoration:none;margin:10px}
        .btn:hover{background:#00cc6a}
        h1{margin-bottom:30px}
    </style>
</head>
<body>
    <h1>Auto Advertisement Manager</h1>
    <a href="/login" class="btn">Login with Discord</a>
</body>
</html>`);
});

app.use((err, req, res, next) => {
    console.error('[EXPRESS ERROR]', err);
    res.status(500).send('Server error');
});

module.exports = app;
