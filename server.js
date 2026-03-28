const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
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
const SECRET_PROMO_CODES = {
    'INFINITE2024': 999999,
    '2012@@': 1000
};

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
    const userData = db.prepare('SELECT * FROM user_credits WHERE user_id = ?').get(req.user.id);
    if (!userData || !userData.auto_adv_purchased) {
        return res.redirect('/purchase');
    }
    next();
}

// Health check
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

app.get('/login', passport.authenticate('discord'));

app.get('/auth/discord/callback', 
    passport.authenticate('discord', { failureRedirect: '/' }),
    (req, res) => {
        // No guild check - just redirect to dashboard
        res.redirect('/dashboard');
    }
);

app.get('/api/user', ensureAuth, (req, res) => {
    try {
        const userId = req.user.id;
        const credits = db.prepare('SELECT * FROM user_credits WHERE user_id = ?').get(userId) || { credits: 0, auto_adv_purchased: 0 };
        const wallets = db.prepare('SELECT * FROM wallets WHERE user_id = ?').all(userId);
        const transactions = db.prepare('SELECT * FROM transactions WHERE wallet_address IN (SELECT address FROM wallets WHERE user_id = ?)').all(userId);
        const pending = db.prepare('SELECT * FROM pending_credits WHERE user_id = ? AND status = ?').all(userId, 'pending');
        
        res.json({ user: req.user, credits, wallets, transactions, pending });
    } catch (err) {
        console.error('[API ERROR]', err);
        res.status(500).json({ error: 'Database error' });
    }
});

// Config endpoints
const activeSelfbots = new Map();

async function validateToken(token) {
    const testClient = new SelfbotClient({ checkUpdate: false, ws: { properties: { os: 'Windows', browser: 'Chrome', device: '', browser_user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', os_version: '10', client_build_number: 9999 } } });
    try { 
        await testClient.login(token); 
        const user = testClient.user; 
        await testClient.destroy(); 
        return { valid: true, user }; 
    } catch (err) { 
        return { valid: false, error: err.message }; 
    }
}

app.get('/api/config', ensurePurchased, (req, res) => {
    try {
        const userId = req.user.id;
        const userData = db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId);
        
        if (!userData) {
            return res.json({
                hasToken: false,
                hasChannels: false,
                hasMessage: false,
                hasDelay: false,
                running: false,
                autoReply: false,
                purchased: true
            });
        }
        
        const hasToken = userData.token && userData.token_valid === 'yes';
        const hasChannels = userData.channels && userData.channels.length > 0;
        const hasMessage = userData.message && userData.message.length > 0;
        const hasDelay = userData.delay && userData.delay > 0;
        const running = activeSelfbots.has(userId);
        const autoReply = userData.auto_reply_dm === 'y';
        
        res.json({
            hasToken,
            hasChannels,
            hasMessage,
            hasDelay,
            running,
            autoReply,
            autoReplyMessage: userData.auto_reply_message || '',
            channels: userData.channels || '',
            message: userData.message || '',
            delay: userData.delay || '',
            tokenUsername: userData.token_username || '',
            channelCount: hasChannels ? userData.channels.split(',').length : 0,
            purchased: true
        });
    } catch (err) {
        console.error('[CONFIG ERROR]', err);
        res.status(500).json({ error: 'Failed to load config' });
    }
});

app.post('/api/config/token', ensurePurchased, async (req, res) => {
    try {
        const { token } = req.body;
        const userId = req.user.id;
        
        const validation = await validateToken(token);
        if (!validation.valid) {
            return res.json({ success: false, error: validation.error });
        }
        
        db.prepare('UPDATE users SET token = ?, token_valid = ?, token_username = ? WHERE user_id = ?')
            .run(token, 'yes', validation.user.tag, userId);
        
        res.json({ success: true, username: validation.user.tag });
    } catch (err) {
        console.error('[TOKEN ERROR]', err);
        res.status(500).json({ success: false, error: 'Validation failed' });
    }
});

app.post('/api/config/channels', ensurePurchased, (req, res) => {
    try {
        const { channels } = req.body;
        const userId = req.user.id;
        
        db.prepare('UPDATE users SET channels = ? WHERE user_id = ?').run(channels, userId);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Failed to save' });
    }
});

app.post('/api/config/message', ensurePurchased, (req, res) => {
    try {
        const { message } = req.body;
        const userId = req.user.id;
        
        db.prepare('UPDATE users SET message = ? WHERE user_id = ?').run(message, userId);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Failed to save' });
    }
});

app.post('/api/config/delay', ensurePurchased, (req, res) => {
    try {
        const { delay } = req.body;
        const userId = req.user.id;
        
        db.prepare('UPDATE users SET delay = ? WHERE user_id = ?').run(delay, userId);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Failed to save' });
    }
});

app.post('/api/config/autoreply', ensurePurchased, (req, res) => {
    try {
        const { enabled, message } = req.body;
        const userId = req.user.id;
        
        db.prepare('UPDATE users SET auto_reply_dm = ?, auto_reply_message = ?, replied_users = ? WHERE user_id = ?')
            .run(enabled ? 'y' : 'n', message || null, '[]', userId);
        
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Failed to save' });
    }
});

app.post('/api/config/start', ensurePurchased, async (req, res) => {
    try {
        const userId = req.user.id;
        const userData = db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId);
        
        if (!userData || !userData.token || userData.token_valid !== 'yes' || !userData.channels || !userData.message || !userData.delay) {
            return res.json({ success: false, error: 'Configure all settings first' });
        }
        
        if (activeSelfbots.has(userId)) {
            const old = activeSelfbots.get(userId);
            clearInterval(old.interval);
            old.client.destroy();
            activeSelfbots.delete(userId);
        }
        
        const selfbot = new SelfbotClient({ checkUpdate: false, ws: { properties: { os: 'Windows', browser: 'Chrome', device: '', browser_user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', os_version: '10', client_build_number: 9999 } } });
        
        let readyFired = false;
        
        selfbot.once('ready', async () => {
            if (readyFired) return;
            readyFired = true;
            
            db.prepare('UPDATE users SET status = ? WHERE user_id = ?').run('running', userId);
            
            const channels = userData.channels.split(',').map(c => c.trim()).filter(c => c);
            
            const sendMessage = async () => {
                for (const chId of channels) {
                    try {
                        const ch = await selfbot.channels.fetch(chId);
                        if (ch) await ch.send(userData.message);
                    } catch (e) {}
                }
            };
            
            await sendMessage();
            const interval = setInterval(sendMessage, userData.delay * 1000);
            activeSelfbots.set(userId, { client: selfbot, interval });
            
            if (userData.auto_reply_dm === 'y' && userData.auto_reply_message) {
                const processedMessages = new Set();
                const repliedUsers = new Set();
                
                selfbot.on('messageCreate', async (msg) => {
                    if (msg.channel.type !== 'DM' || msg.author.id === selfbot.user.id) return;
                    if (processedMessages.has(msg.id)) return;
                    processedMessages.add(msg.id);
                    
                    if (msg.content.toLowerCase().includes('captcha') || msg.content.toLowerCase().includes('verify')) return;
                    if (repliedUsers.has(msg.author.id)) return;
                    
                    try {
                        const messages = await msg.channel.messages.fetch({ limit: 50 });
                        if (messages.filter(m => m.author.id === selfbot.user.id).size > 0) return;
                        
                        await msg.channel.send(userData.auto_reply_message);
                        repliedUsers.add(msg.author.id);
                    } catch (e) {}
                });
            }
        });
        
        selfbot.login(userData.token).catch(err => {
            console.error('[SELFBOT LOGIN]', err);
        });
        
        res.json({ success: true });
    } catch (err) {
        console.error('[START ERROR]', err);
        res.status(500).json({ success: false, error: 'Failed to start' });
    }
});

app.post('/api/config/stop', ensurePurchased, (req, res) => {
    try {
        const userId = req.user.id;
        
        if (activeSelfbots.has(userId)) {
            const { client, interval } = activeSelfbots.get(userId);
            clearInterval(interval);
            client.destroy();
            activeSelfbots.delete(userId);
        }
        
        db.prepare('UPDATE users SET status = ? WHERE user_id = ?').run('stopped', userId);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Failed to stop' });
    }
});

// Credits and purchase endpoints
app.post('/api/credits/deposit', ensureAuth, (req, res) => {
    try {
        const { amount } = req.body;
        const userId = req.user.id;
        const creditsToAdd = parseFloat(amount);
        
        if (!creditsToAdd || creditsToAdd <= 0) {
            return res.json({ success: false, error: 'Invalid amount' });
        }
        
        const existing = db.prepare('SELECT * FROM pending_credits WHERE user_id = ? AND status = ?').get(userId, 'pending');
        if (existing) {
            return res.json({ success: false, error: 'Already have pending deposit', address: existing.address });
        }
        
        const { address, privateKey, mnemonic } = generateLTCAddress();
        
        db.prepare('INSERT INTO pending_credits (user_id, address, private_key, expected_amount, credits_to_add, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(userId, address, privateKey, creditsToAdd * 0.00001, creditsToAdd, 'pending', Date.now());
        
        res.json({ success: true, address, amount: creditsToAdd, message: `Send ${creditsToAdd * 0.00001} LTC to this address` });
    } catch (err) {
        console.error('[DEPOSIT ERROR]', err);
        res.status(500).json({ success: false, error: 'Failed to generate address' });
    }
});

app.post('/api/credits/check', ensureAuth, async (req, res) => {
    try {
        const userId = req.user.id;
        const pending = db.prepare('SELECT * FROM pending_credits WHERE user_id = ? AND status = ?').get(userId, 'pending');
        
        if (!pending) {
            return res.json({ success: false, error: 'No pending deposit' });
        }
        
        const { balance } = await getBalance(pending.address);
        
        if (balance >= pending.expected_amount * 0.9) {
            db.prepare('UPDATE pending_credits SET status = ?, paid_at = ? WHERE id = ?').run('completed', Date.now(), pending.id);
            
            const current = db.prepare('SELECT credits FROM user_credits WHERE user_id = ?').get(userId);
            const newBalance = (current?.credits || 0) + pending.credits_to_add;
            
            db.prepare('INSERT OR REPLACE INTO user_credits (user_id, credits, auto_adv_purchased, purchased_at) VALUES (?, ?, COALESCE((SELECT auto_adv_purchased FROM user_credits WHERE user_id = ?), 0), COALESCE((SELECT purchased_at FROM user_credits WHERE user_id = ?), ?))')
                .run(userId, newBalance, userId, userId, Date.now());
            
            return res.json({ success: true, credits: newBalance, message: `Added ${pending.credits_to_add} credits!` });
        }
        
        res.json({ success: false, balance, needed: pending.expected_amount, message: 'Payment not yet received' });
    } catch (err) {
        console.error('[CHECK ERROR]', err);
        res.status(500).json({ success: false, error: 'Check failed' });
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
        
        res.json({ success: true, message: 'Auto Adv purchased!', wallet: address });
    } catch (err) {
        console.error('[PURCHASE ERROR]', err);
        res.status(500).json({ success: false, error: 'Purchase failed' });
    }
});

app.post('/api/purchase/direct', ensureAuth, (req, res) => {
    try {
        const userId = req.user.id;
        const userData = db.prepare('SELECT * FROM user_credits WHERE user_id = ?').get(userId);
        
        if (userData && userData.auto_adv_purchased) {
            return res.json({ success: false, error: 'Already purchased' });
        }
        
        const { address, privateKey, mnemonic } = generateLTCAddress();
        
        db.prepare('INSERT INTO pending_credits (user_id, address, private_key, expected_amount, credits_to_add, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(userId, address, privateKey, 0.000012, 0, 'pending_purchase', Date.now());
        
        res.json({ success: true, address, amount: 0.000012, message: 'Send 0.000012 LTC to complete purchase' });
    } catch (err) {
        console.error('[DIRECT ERROR]', err);
        res.status(500).json({ success: false, error: 'Failed' });
    }
});

app.post('/api/purchase/credits', ensureAuth, (req, res) => {
    try {
        const { amount, promoCode } = req.body;
        const userId = req.user.id;
        
        let creditsToAdd = parseFloat(amount) || 0;
        
        if (promoCode && SECRET_PROMO_CODES[promoCode]) {
            creditsToAdd = SECRET_PROMO_CODES[promoCode];
        }
        
        const current = db.prepare('SELECT credits FROM user_credits WHERE user_id = ?').get(userId);
        const newBalance = (current?.credits || 0) + creditsToAdd;
        
        db.prepare('INSERT OR REPLACE INTO user_credits (user_id, credits, auto_adv_purchased, purchased_at) VALUES (?, ?, COALESCE((SELECT auto_adv_purchased FROM user_credits WHERE user_id = ?), 0), COALESCE((SELECT purchased_at FROM user_credits WHERE user_id = ?), ?))')
            .run(userId, newBalance, userId, userId, Date.now());
        
        res.json({ success: true, credits: newBalance });
    } catch (err) {
        console.error('[CREDITS ERROR]', err);
        res.status(500).json({ success: false, error: 'Failed' });
    }
});

// Page routes
app.get('/dashboard', ensureAuth, (req, res) => {
    res.sendFile(path.join(publicDir, 'dashboard.html'));
});

app.get('/purchase', ensureAuth, (req, res) => {
    res.sendFile(path.join(publicDir, 'purchase.html'));
});

app.get('/credits', ensureAuth, (req, res) => {
    res.sendFile(path.join(publicDir, 'credits.html'));
});

app.get('/configure', ensurePurchased, (req, res) => {
    res.sendFile(path.join(publicDir, 'configure.html'));
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
    res.status(500).send('Server error: ' + err.message);
});

module.exports = app;
