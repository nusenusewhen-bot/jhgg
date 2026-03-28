const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const { generateLTCAddress } = require('./wallet');
const { getBalance } = require('./blockchain');

const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });

const db = new Database('./data.db');
const app = express();

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const CALLBACK_URL = process.env.CALLBACK_URL;

let botClient = null;
module.exports.setBotClient = (client) => { botClient = client; };

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

function ensureAuthAPI(req, res, next) {
    if (req.isAuthenticated()) return next();
    return res.status(401).json({ success: false, error: 'Not logged in' });
}

function ensureAuth(req, res, next) {
    if (req.isAuthenticated()) return next();
    res.redirect('/login');
}

app.get('/health', (req, res) => res.status(200).send('OK'));
app.get('/login', passport.authenticate('discord'));
app.get('/auth/discord/callback', passport.authenticate('discord', { failureRedirect: '/' }), (req, res) => res.redirect('/dashboard'));
app.get('/logout', (req, res) => req.logout(() => res.redirect('/')));

// UPDATED: Returns user profile info
app.get('/api/user', ensureAuthAPI, (req, res) => {
    const userId = req.user.id;
    const data = db.prepare('SELECT * FROM user_credits WHERE user_id = ?').get(userId) || { credits: 0, auto_adv_purchased: 0 };
    
    res.json({ 
        id: req.user.id,
        username: req.user.username,
        discriminator: req.user.discriminator,
        avatar: req.user.avatar,
        global_name: req.user.global_name,
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

// Logout verification via bot
app.post('/api/logout/request', ensureAuthAPI, async (req, res) => {
    try {
        const userId = req.user.id;
        if (!botClient) return res.status(500).json({ success: false, error: 'Bot not ready' });
        const code = Math.random().toString(36).substring(2, 8).toUpperCase();
        db.prepare('INSERT OR REPLACE INTO pending_logouts (user_id, code, created_at) VALUES (?, ?, ?)').run(userId, code, Date.now());
        try {
            const user = await botClient.users.fetch(userId);
            const embed = {
                title: '🔒 Logout Verification',
                description: `You requested to logout from Auto Adv Dashboard.\n\n**Verification Code:** \`${code}\`\n\nEnter this code on the website to complete logout.\nExpires in 5 minutes.`,
                color: 0x10b981,
                timestamp: new Date().toISOString()
            };
            await user.send({ embeds: [embed] });
            res.json({ success: true, message: 'Check your Discord DMs for verification code' });
        } catch (dmErr) {
            res.status(400).json({ success: false, error: 'Cannot send DM. Enable DMs from server members.' });
        }
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/logout/verify', ensureAuthAPI, (req, res) => {
    try {
        const userId = req.user.id;
        const { code } = req.body;
        const pending = db.prepare('SELECT * FROM pending_logouts WHERE user_id = ?').get(userId);
        if (!pending) return res.json({ success: false, error: 'No pending logout request' });
        if (Date.now() - pending.created_at > 300000) {
            db.prepare('DELETE FROM pending_logouts WHERE user_id = ?').run(userId);
            return res.json({ success: false, error: 'Code expired. Request new one.' });
        }
        if (pending.code !== code.toUpperCase()) return res.json({ success: false, error: 'Invalid code' });
        db.prepare('DELETE FROM pending_logouts WHERE user_id = ?').run(userId);
        req.logout(() => res.json({ success: true }));
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/', (req, res) => {
    if (req.isAuthenticated()) return res.redirect('/dashboard');
    res.sendFile(path.join(publicDir, 'overall.html'));
});
app.get('/dashboard', ensureAuth, (req, res) => res.sendFile(path.join(publicDir, 'overall.html')));

app.use((err, req, res, next) => {
    console.error('[SERVER ERROR]', err);
    res.status(500).send('Server error');
});

module.exports = app;
