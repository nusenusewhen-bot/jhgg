const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const { generateLTCAddress } = require('./wallet');
const { getBalance } = require('./blockchain');
const { Client: SelfbotClient } = require('discord.js-selfbot-v13');

const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });

const db = new Database('./data.db');
const app = express();

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const CALLBACK_URL = process.env.CALLBACK_URL;

app.use(cors());                    // ← This fixes network error
app.use(express.json());
app.use(express.static(publicDir));

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

function ensureAuth(req, res, next) {
    if (req.isAuthenticated()) return next();
    res.redirect('/login');
}

function ensurePurchased(req, res, next) {
    if (!req.isAuthenticated()) return res.redirect('/login');
    const userData = db.prepare('SELECT auto_adv_purchased FROM user_credits WHERE user_id = ?').get(req.user.id);
    if (!userData || userData.auto_adv_purchased !== 1) {
        return res.redirect('/dashboard');
    }
    next();
}

// ====================== ROUTES ======================

app.get('/health', (req, res) => res.send('OK'));

app.get('/login', passport.authenticate('discord'));

app.get('/auth/discord/callback', passport.authenticate('discord', { failureRedirect: '/' }), (req, res) => res.redirect('/dashboard'));

app.get('/logout', (req, res) => req.logout(() => res.redirect('/')));

// Test route to check if API works
app.get('/api/test', (req, res) => res.json({ message: 'API is working!' }));

// Lifetime purchase - $1.50
app.post('/api/purchase/lifetime', ensureAuth, (req, res) => {
    console.log('✅ /api/purchase/lifetime called'); // debug log
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

// Check payment
app.post('/api/credits/check', ensureAuth, async (req, res) => {
    console.log('✅ /api/credits/check called');
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

// All pages use overall.html
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
