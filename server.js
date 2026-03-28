const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const path = require('path');
const fs = require('fs');
const axios = require('axios');

// Database setup
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

class SimpleDB {
    constructor() {
        this.file = path.join(dataDir, 'db.json');
        this.data = { users: {}, pending: {}, configs: {}, usedKeys: {}, globalIndex: 0, serverJoins: {} };
        this.load();
    }
    
    load() {
        try {
            if (fs.existsSync(this.file)) {
                this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            }
        } catch(e) { console.error('[DB] Load error:', e.message); }
    }
    
    save() {
        try {
            fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
        } catch(e) { console.error('[DB] Save error:', e.message); }
    }
    
    getUser(id) {
        return this.data.users[id] || { auto_adv_purchased: 0 };
    }
    
    setUser(id, data) {
        this.data.users[id] = { ...this.getUser(id), ...data };
        this.save();
    }
    
    getNextGlobalIndex() {
        this.data.globalIndex = (this.data.globalIndex || 0) + 1;
        this.save();
        return this.data.globalIndex;
    }
    
    addPending(userId, address, privateKey, expectedUSD, index) {
        this.data.pending[address] = {
            user_id: userId,
            address,
            private_key: privateKey,
            expected_usd: expectedUSD,
            status: 'monitoring',
            created_at: Date.now(),
            index: index
        };
        this.save();
        return this.data.pending[address];
    }
    
    getPending(address) {
        return this.data.pending[address];
    }
    
    getAllPending() {
        return Object.values(this.data.pending).filter(p => p.status === 'monitoring');
    }
    
    updatePending(address, updates) {
        if (this.data.pending[address]) {
            this.data.pending[address] = { ...this.data.pending[address], ...updates };
            this.save();
        }
    }
    
    useKey(key, userId) {
        this.data.usedKeys[key] = { user_id: userId, used_at: Date.now() };
        this.save();
    }
    
    isKeyUsed(key) {
        return !!this.data.usedKeys[key];
    }
    
    getConfigs(userId) {
        return this.data.configs[userId] || [];
    }
    
    getConfig(userId, configId = 'default') {
        const configs = this.getConfigs(userId);
        return configs.find(c => c.id === configId) || configs[0] || null;
    }
    
    setConfig(userId, config, configId = 'default') {
        if (!this.data.configs[userId]) {
            this.data.configs[userId] = [];
        }
        const existingIndex = this.data.configs[userId].findIndex(c => c.id === configId);
        const configData = { ...config, id: configId, updated_at: Date.now() };
        
        if (existingIndex >= 0) {
            this.data.configs[userId][existingIndex] = configData;
        } else {
            this.data.configs[userId].push(configData);
        }
        this.save();
    }
    
    deleteConfig(userId, configId) {
        if (this.data.configs[userId]) {
            this.data.configs[userId] = this.data.configs[userId].filter(c => c.id !== configId);
            this.save();
        }
    }
    
    getActiveConfigs(userId) {
        const configs = this.getConfigs(userId);
        return configs.filter(c => c.active === 1);
    }
    
    // Server join tracking
    addServerJoin(userId, inviteCode, configId) {
        const joinId = `${userId}_${Date.now()}`;
        this.data.serverJoins[joinId] = {
            user_id: userId,
            invite_code: inviteCode,
            config_id: configId,
            status: 'pending',
            created_at: Date.now()
        };
        this.save();
        return joinId;
    }
    
    getServerJoins(userId) {
        return Object.values(this.data.serverJoins).filter(j => j.user_id === userId);
    }
}

const db = new SimpleDB();

const app = express();

// Crash protection
process.on('uncaughtException', (err) => console.error('[FATAL]', err.message));
process.on('unhandledRejection', (reason) => console.error('[FATAL]', reason));

// Health check
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

// Session - extended for longer persistence
app.use(session({
    secret: process.env.SESSION_SECRET || 'secret-key-2026',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 30 * 24 * 60 * 60 * 1000 },
    rolling: true
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
const WALLET_MNEMONIC = process.env.WALLET_MNEMONIC;
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

// Generate KRUP1-KRUP99 keys
const VALID_REDEEM_KEYS = new Set();
for (let i = 1; i <= 99; i++) {
    VALID_REDEEM_KEYS.add(`KRUP${i}`);
    VALID_REDEEM_KEYS.add(`KPUR${i}`); // Keep old format too
}

const pendingLogouts = new Map();

function ensureAuthAPI(req, res, next) {
    if (req.isAuthenticated()) return next();
    return res.status(401).json({ success: false, error: 'Not logged in' });
}

function ensurePurchasedAPI(req, res, next) {
    const user = db.getUser(req.user.id);
    if (user.auto_adv_purchased !== 1) {
        return res.status(403).json({ success: false, error: 'Purchase required' });
    }
    next();
}

// Auto-sweep functionality
let walletModule = null;
try {
    walletModule = require('./wallet');
    console.log('[WALLET] Loaded successfully');
} catch(e) {
    console.error('[WALLET] Failed to load:', e.message);
}

async function checkAndSweep() {
    if (!walletModule || !OWNER_LTC_ADDRESS || !WALLET_MNEMONIC) {
        console.log('[SWEEP] Skipped - missing deps');
        return;
    }
    
    const pending = db.getAllPending();
    console.log(`[SWEEP] Checking ${pending.length} addresses`);
    
    for (const p of pending) {
        try {
            const balance = await walletModule.checkAddressBalance(p.address);
            console.log(`[SWEEP] ${p.address}: ${balance} LTC`);
            
            if (balance > 0) {
                console.log(`[SWEEP] Found balance! Sweeping...`);
                const txid = await walletModule.createTransaction(p.private_key, p.address, OWNER_LTC_ADDRESS);
                
                if (txid) {
                    console.log(`[SWEEP] SUCCESS: ${txid}`);
                    
                    const ltcPrice = await getLTCToUSD();
                    const usdValue = balance * ltcPrice;
                    
                    if (usdValue >= (TARGET_USD - TOLERANCE_USD)) {
                        db.setUser(p.user_id, { auto_adv_purchased: 1, purchased_at: Date.now() });
                        db.updatePending(p.address, { status: 'completed', paid_at: Date.now(), amount_received_ltc: balance });
                    }
                }
            }
        } catch (e) {
            console.error(`[SWEEP] Error for ${p.address}:`, e.message);
        }
    }
}

let cachedPrice = 85;
async function getLTCToUSD() {
    try {
        const res = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=litecoin&vs_currencies=usd', { timeout: 5000 });
        cachedPrice = res.data.litecoin.usd;
    } catch (e) {}
    return cachedPrice;
}

if (walletModule && OWNER_LTC_ADDRESS && WALLET_MNEMONIC) {
    console.log('[AUTO-SWEEP] Starting 10-second interval');
    setInterval(checkAndSweep, 10000);
    setTimeout(checkAndSweep, 5000);
}

// Routes
app.get('/login', passport.authenticate('discord'));
app.get('/auth/discord/callback', passport.authenticate('discord', { failureRedirect: '/' }), (req, res) => res.redirect('/'));
app.get('/logout', (req, res) => req.logout(() => res.redirect('/')));

app.get('/api/user', ensureAuthAPI, (req, res) => {
    const user = db.getUser(req.user.id);
    res.json({ 
        id: req.user.id,
        username: req.user.username,
        global_name: req.user.global_name,
        avatar: req.user.avatar,
        purchased: user.auto_adv_purchased === 1 
    });
});

// Generate unique address using global index
app.post('/api/purchase/lifetime', ensureAuthAPI, (req, res) => {
    try {
        const userId = req.user.id;
        const user = db.getUser(userId);
        
        if (user.auto_adv_purchased === 1) {
            return res.json({ success: false, error: 'Already purchased' });
        }

        if (!walletModule) {
            return res.status(500).json({ success: false, error: 'Wallet module not loaded' });
        }

        const globalIndex = db.getNextGlobalIndex();
        const { address, privateKey } = walletModule.generateLTCAddress(globalIndex);
        db.addPending(userId, address, privateKey, TARGET_USD, globalIndex);

        res.json({ success: true, address, amountUSD: TARGET_USD, index: globalIndex });
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
        if (db.isKeyUsed(upperKey)) return res.json({ success: false, error: 'Key used' });
        
        const user = db.getUser(userId);
        if (user.auto_adv_purchased === 1) return res.json({ success: false, error: 'Already have access' });
        
        db.setUser(userId, { auto_adv_purchased: 1, purchased_at: Date.now(), redeem_key_used: upperKey });
        db.useKey(upperKey, userId);
        
        res.json({ success: true, message: 'Access granted!' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Get all saved configs
app.get('/api/bot/configs', ensureAuthAPI, ensurePurchasedAPI, (req, res) => {
    const configs = db.getConfigs(req.user.id);
    res.json({ success: true, configs });
});

// Start bot with config saving
app.post('/api/bot/start', ensureAuthAPI, ensurePurchasedAPI, async (req, res) => {
    try {
        const { token, channels, message, delay, autoReplyEnabled, autoReplyText, configId = 'default', joinServer, serverInvite } = req.body;
        
        if (!token || !channels || !message) {
            return res.status(400).json({ success: false, error: 'Missing fields' });
        }
        
        const channelList = channels.split(',').map(c => c.trim()).filter(c => /^\d+$/.test(c));
        if (channelList.length === 0) {
            return res.json({ success: false, error: 'Invalid channel IDs' });
        }
        
        let selfbotModule;
        try {
            selfbotModule = require('./selfbot');
        } catch(e) {
            return res.status(500).json({ success: false, error: 'Selfbot module not loaded' });
        }
        
        const validation = await selfbotModule.validateToken(token);
        if (!validation.valid) return res.json({ success: false, error: 'Invalid token' });
        
        const delay delaySeconds = parseInt(delay) || 30;
        const autoReply = autoReplyEnabled ? 1 : 0;
        
        // Handle server join request
        let joinStatus = null;
        if (joinServer && serverInvite) {
            joinStatus = await selfbotModule.joinServer(token, serverInvite);
            if (joinStatus.success) {
                db.addServerJoin(req.user.id, serverInvite, configId);
            }
        }
        
        db.setConfig(req.user.id, {
            token, channels, message, 
            delay_seconds: delaySeconds, 
            auto_reply_enabled: autoReply, 
            auto_reply_text: autoReplyText || '',
            active: 1,
            username: validation.username,
            server_joined: joinStatus?.success || false
        }, configId);
        
        await selfbotModule.startSelfBot(req.user.id, token, channelList, message, delaySeconds * 1000, autoReply, autoReplyText, configId);
        
        res.json({ 
            success: true, 
            username: validation.username, 
            configId,
            serverJoined: joinStatus?.success || false,
            serverJoinMessage: joinStatus?.message || null
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Stop specific config
app.post('/api/bot/stop', ensureAuthAPI, (req, res) => {
    try {
        const { configId = 'default' } = req.body;
        let selfbotModule;
        try {
            selfbotModule = require('./selfbot');
        } catch(e) {
            return res.status(500).json({ success: false, error: 'Selfbot module not loaded' });
        }
        
        selfbotModule.stopSelfBot(req.user.id, configId);
        const config = db.getConfig(req.user.id, configId);
        if (config) {
            config.active = 0;
            db.setConfig(req.user.id, config, configId);
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Delete config
app.post('/api/bot/delete', ensureAuthAPI, (req, res) => {
    try {
        const { configId } = req.body;
        db.deleteConfig(req.user.id, configId);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Server join endpoint
app.post('/api/server/join', ensureAuthAPI, ensurePurchasedAPI, async (req, res) => {
    try {
        const { inviteCode, configId = 'default' } = req.body;
        
        if (!inviteCode) {
            return res.json({ success: false, error: 'Invite code required' });
        }
        
        const config = db.getConfig(req.user.id, configId);
        if (!config || !config.token) {
            return res.json({ success: false, error: 'No bot configured' });
        }
        
        let selfbotModule;
        try {
            selfbotModule = require('./selfbot');
        } catch(e) {
            return res.status(500).json({ success: false, error: 'Selfbot module not loaded' });
        }
        
        const result = await selfbotModule.joinServer(config.token, inviteCode);
        
        if (result.success) {
            db.addServerJoin(req.user.id, inviteCode, configId);
        }
        
        res.json(result);
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
