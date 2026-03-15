const WebSocket = require('ws');
const axios = require('axios');
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const PREFIX = '$';
const CONFIG_FILE = './bot_configs.json';

// Load or create config file
let savedConfigs = {};
if (fs.existsSync(CONFIG_FILE)) {
    try {
        savedConfigs = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch (e) {
        savedConfigs = {};
    }
}

function saveToDisk() {
    const data = {};
    TOKENS.forEach(bot => {
        data[bot.id] = bot.config;
    });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2));
}

// Load tokens
const TOKENS = [];
let i = 1;
while (process.env[`DISCORD_TOKEN${i === 1 ? '' : i}`]) {
    TOKENS.push({
        id: i,
        token: process.env[`DISCORD_TOKEN${i === 1 ? '' : i}`].trim(),
        ws: null,
        heartbeat: null,
        running: false,
        userId: null,
        username: null,
        config: savedConfigs[i] || {
            serverId: '',
            channelId: '',
            message: '',
            delay: 5000,
            enabled: false,
            spamming: false
        }
    });
    i++;
}

const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// CORS fix for Railway
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// API routes
app.get('/api/bots', (req, res) => {
    res.json(TOKENS.map(t => ({
        id: t.id,
        username: t.username || `Bot ${t.id}`,
        connected: t.running,
        config: t.config
    })));
});

app.post('/api/bot/:id/configure', (req, res) => {
    const bot = TOKENS.find(t => t.id === parseInt(req.params.id));
    if (!bot) return res.status(404).json({ error: 'Bot not found' });
    
    const { serverId, channelId, message, delay, enabled } = req.body;
    
    if (serverId !== undefined) bot.config.serverId = serverId;
    if (channelId !== undefined) bot.config.channelId = channelId;
    if (message !== undefined) bot.config.message = message;
    if (delay !== undefined) bot.config.delay = parseInt(delay) || 5000;
    if (enabled !== undefined) bot.config.enabled = enabled;
    
    saveToDisk();
    res.json({ success: true, config: bot.config });
});

app.post('/api/bot/:id/spam/start', (req, res) => {
    const bot = TOKENS.find(t => t.id === parseInt(req.params.id));
    if (!bot || !bot.running) return res.status(400).json({ error: 'Bot not connected' });
    if (!bot.config.channelId || !bot.config.message) {
        return res.status(400).json({ error: 'Missing channel or message' });
    }
    
    bot.config.spamming = true;
    bot.config.enabled = true;
    saveToDisk();
    startSpamming(bot);
    res.json({ success: true, message: 'Spamming started' });
});

app.post('/api/bot/:id/spam/stop', (req, res) => {
    const bot = TOKENS.find(t => t.id === parseInt(req.params.id));
    if (!bot) return res.status(404).json({ error: 'Bot not found' });
    
    bot.config.spamming = false;
    saveToDisk();
    stopSpamming(bot);
    res.json({ success: true, message: 'Spamming stopped' });
});

// Discord WS logic
const SUPER_PROPS = {
    os: "Windows",
    browser: "Chrome",
    device: "",
    system_locale: "en-US",
    browser_user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.0.36",
    browser_version: "120.0.0.0",
    os_version: "10",
    release_channel: "stable",
    client_build_number: 242635
};

function getHeaders(token) {
    return {
        'Authorization': token,
        'Content-Type': 'application/json',
        'User-Agent': SUPER_PROPS.browser_user_agent,
        'Accept': '*/*',
        'X-Super-Properties': Buffer.from(JSON.stringify(SUPER_PROPS)).toString('base64'),
        'Origin': 'https://discord.com'
    };
}

async function sendMessage(bot, channelId, content) {
    try {
        const res = await axios.post(
            `https://discord.com/api/v9/channels/${channelId}/messages`,
            { content, nonce: Date.now().toString() },
            { headers: getHeaders(bot.token), timeout: 5000, validateStatus: () => true }
        );
        if (res.status === 200) {
            console.log(`[Bot ${bot.id}] Sent`);
            return true;
        }
        if (res.status === 429) {
            setTimeout(() => sendMessage(bot, channelId, content), res.headers['retry-after'] || 5000);
        }
    } catch (e) {
        console.log(`[Bot ${bot.id}] Error: ${e.message}`);
    }
    return false;
}

function startSpamming(bot) {
    if (!bot.config.channelId || !bot.config.message) return;
    const loop = async () => {
        if (!bot.config.spamming || !bot.running) return;
        await sendMessage(bot, bot.config.channelId, bot.config.message);
        setTimeout(loop, bot.config.delay + Math.random() * 1000);
    };
    loop();
}

function stopSpamming(bot) {
    bot.config.spamming = false;
}

function connectBot(bot) {
    if (bot.running) return;
    const ws = new WebSocket('wss://gateway.discord.gg/?v=9&encoding=json', {
        headers: { 'User-Agent': SUPER_PROPS.browser_user_agent }
    });
    
    bot.ws = ws;
    
    ws.on('open', () => console.log(`[Bot ${bot.id}] WS Open`));
    
    ws.on('message', (data) => {
        try {
            const { op, d, s, t } = JSON.parse(data);
            
            if (op === 10) {
                bot.heartbeat = setInterval(() => {
                    if (ws.readyState === 1) ws.send(JSON.stringify({ op: 1, d: s }));
                }, d.heartbeat_interval);
                
                ws.send(JSON.stringify({
                    op: 2,
                    d: {
                        token: bot.token,
                        capabilities: 30717,
                        properties: SUPER_PROPS,
                        presence: { status: "online", since: 0, activities: [], afk: false },
                        compress: false,
                        client_state: {},
                        intents: (1 << 0) | (1 << 1) | (1 << 9)
                    }
                }));
            }
            
            if (t === 'READY') {
                bot.userId = d.user.id;
                bot.username = d.user.username;
                bot.running = true;
                console.log(`[Bot ${bot.id}] Ready: ${d.user.username}`);
                if (bot.config.enabled && bot.config.spamming) startSpamming(bot);
            }
            
            if (t === 'MESSAGE_CREATE' && d.author.id === bot.userId) {
                const cmd = d.content.trim().toLowerCase();
                if (!cmd.startsWith(PREFIX)) return;
                const args = cmd.slice(PREFIX.length).trim().split(' ');
                
                if (args[0] === 'spam') {
                    if (args[1] === 'stop') {
                        stopSpamming(bot);
                        sendMessage(bot, d.channel_id, '🔴 Stopped');
                    } else {
                        bot.config.channelId = d.channel_id;
                        bot.config.message = args.slice(1).join(' ') || bot.config.message;
                        bot.config.spamming = true;
                        saveToDisk();
                        startSpamming(bot);
                        sendMessage(bot, d.channel_id, '🟢 Started');
                    }
                }
            }
        } catch (e) {}
    });
    
    ws.on('close', () => {
        clearInterval(bot.heartbeat);
        bot.running = false;
        setTimeout(() => connectBot(bot), 5000);
    });
}

app.listen(PORT, () => {
    console.log(`Dashboard: http://localhost:${PORT}`);
    TOKENS.forEach(connectBot);
});
