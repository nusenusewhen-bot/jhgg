const WebSocket = require('ws');
const axios = require('axios');
const express = require('express');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { HttpProxyAgent } = require('http-proxy-agent');
const path = require('path');
const fs = require('fs');
const http = require('http');

const PORT = process.env.PORT || 3000;
const PREFIX = '$';
const CONFIG_FILE = './bot_configs.json';

// Cluster mode for max performance
const cluster = require('cluster');
const numCPUs = require('os').cpus().length;

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

// Connection pool for max throughput
const axiosInstance = axios.create({
    timeout: 8000,
    maxRedirects: 0,
    httpAgent: new http.Agent({ keepAlive: true, maxSockets: 50 }),
    validateStatus: () => true
});

// Load all tokens
const TOKENS = [];
let idx = 1;
while (process.env[`DISCORD_TOKEN${idx === 1 ? '' : idx}`]) {
    TOKENS.push({
        id: idx,
        token: process.env[`DISCORD_TOKEN${idx === 1 ? '' : idx}`].trim(),
        ws: null,
        heartbeat: null,
        running: false,
        userId: null,
        username: null,
        lastMessage: 0,
        messageQueue: [],
        config: savedConfigs[idx] || {
            serverId: '',
            channelId: '',
            message: '',
            delay: 3000,
            enabled: false,
            spamming: false,
            burstMode: false
        }
    });
    idx++;
}

const SUPER_PROPS = {
    os: "Windows",
    browser: "Chrome",
    device: "",
    system_locale: "en-US",
    browser_user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    browser_version: "121.0.0.0",
    os_version: "10",
    release_channel: "stable",
    client_build_number: 250836,
    client_event_source: null
};

function getHeaders(token) {
    const timestamp = Date.now();
    return {
        'Authorization': token,
        'Content-Type': 'application/json',
        'User-Agent': SUPER_PROPS.browser_user_agent,
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'X-Super-Properties': Buffer.from(JSON.stringify(SUPER_PROPS)).toString('base64'),
        'X-Discord-Locale': 'en-US',
        'X-Discord-Timezone': 'America/New_York',
        'X-Debug-Options': 'bugReporterEnabled',
        'Origin': 'https://discord.com',
        'Referer': 'https://discord.com/channels/@me',
        'Sec-Ch-Ua': '"Not A(Brand";v="99", "Google Chrome";v="121", "Chromium";v="121"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'X-Request-Id': `${timestamp}-${Math.random().toString(36).substring(2, 15)}`,
        'X-Context-Properties': Buffer.from(JSON.stringify({ location: 'Chat Input' })).toString('base64')
    };
}

// High-speed message sender with queue system
async function sendMessage(bot, channelId, content, priority = false) {
    if (!channelId || !content) return false;
    
    const now = Date.now();
    const minDelay = bot.config.burstMode ? 800 : bot.config.delay;
    
    if (!priority && now - bot.lastMessage < minDelay) {
        bot.messageQueue.push({ channelId, content });
        return false;
    }
    
    bot.lastMessage = now;
    
    try {
        const res = await axiosInstance.post(
            `https://discord.com/api/v9/channels/${channelId}/messages`,
            {
                content,
                nonce: `${Date.now()}${Math.random().toString(36).substring(2, 8)}`,
                tts: false,
                flags: 0
            },
            { headers: getHeaders(bot.token) }
        );
        
        if (res.status === 200) {
            console.log(`[Bot ${bot.id}] ✓ ${channelId}`);
            return true;
        }
        
        if (res.status === 429) {
            const retry = parseInt(res.headers['retry-after']) || 5000;
            console.log(`[Bot ${bot.id}] Rate limited ${retry}ms`);
            setTimeout(() => sendMessage(bot, channelId, content, true), retry);
        }
    } catch (e) {
        if (e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT') {
            setTimeout(() => sendMessage(bot, channelId, content, true), 1000);
        }
    }
    return false;
}

// Process queue
function processQueue(bot) {
    if (bot.messageQueue.length > 0 && !bot.config.spamming) {
        const msg = bot.messageQueue.shift();
        sendMessage(bot, msg.channelId, msg.content, true);
    }
}

function startSpamming(bot) {
    if (!bot.config.channelId || !bot.config.message) return;
    
    const loop = async () => {
        if (!bot.config.spamming || !bot.running) return;
        
        await sendMessage(bot, bot.config.channelId, bot.config.message);
        processQueue(bot);
        
        const jitter = bot.config.burstMode ? 0 : Math.random() * 1000;
        const delay = bot.config.burstMode ? 800 : bot.config.delay;
        
        setTimeout(loop, delay + jitter);
    };
    
    loop();
}

function stopSpamming(bot) {
    bot.config.spamming = false;
    saveToDisk();
}

function connectBot(bot) {
    if (bot.running) return;
    
    const ws = new WebSocket('wss://gateway.discord.gg/?v=9&encoding=json', {
        headers: {
            'User-Agent': SUPER_PROPS.browser_user_agent,
            'Origin': 'https://discord.com'
        },
        handshakeTimeout: 30000,
        perMessageDeflate: false
    });
    
    bot.ws = ws;
    
    ws.on('open', () => console.log(`[Bot ${bot.id}] Connected`));
    
    ws.on('message', (data) => {
        try {
            const payload = JSON.parse(data);
            const { op, d, s, t } = payload;
            
            if (op === 10) {
                bot.heartbeat = setInterval(() => {
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ op: 1, d: s }));
                    }
                }, d.heartbeat_interval);
                
                ws.send(JSON.stringify({
                    op: 2,
                    d: {
                        token: bot.token,
                        capabilities: 30717,
                        properties: SUPER_PROPS,
                        presence: {
                            status: "online",
                            since: 0,
                            activities: [{
                                name: "Spotify",
                                type: 2,
                                state: "Playing",
                                details: "High Performance Mode"
                            }],
                            afk: false
                        },
                        compress: false,
                        client_state: {
                            guild_versions: {},
                            highest_last_message_id: "0",
                            read_state_version: 0,
                            user_guild_settings_version: -1
                        },
                        intents: (1 << 0) | (1 << 1) | (1 << 9) | (1 << 12)
                    }
                }));
            }
            
            if (t === 'READY') {
                bot.userId = d.user.id;
                bot.username = d.user.username;
                bot.running = true;
                console.log(`[Bot ${bot.id}] Ready: ${d.user.username}`);
                
                if (bot.config.enabled && bot.config.spamming) {
                    startSpamming(bot);
                }
            }
            
            if (t === 'MESSAGE_CREATE' && d.author.id === bot.userId) {
                const cmd = d.content.trim().toLowerCase();
                if (!cmd.startsWith(PREFIX)) return;
                
                const args = cmd.slice(PREFIX.length).trim().split(' ');
                const command = args.shift();
                
                switch(command) {
                    case 'spam':
                        if (args[0] === 'stop') {
                            stopSpamming(bot);
                            sendMessage(bot, d.channel_id, '🔴 Stopped', true);
                        } else {
                            bot.config.channelId = d.channel_id;
                            bot.config.message = args.join(' ') || bot.config.message;
                            bot.config.spamming = true;
                            saveToDisk();
                            startSpamming(bot);
                            sendMessage(bot, d.channel_id, '🟢 Started', true);
                        }
                        break;
                    case 'burst':
                        bot.config.burstMode = !bot.config.burstMode;
                        sendMessage(bot, d.channel_id, `⚡ Burst: ${bot.config.burstMode ? 'ON' : 'OFF'}`, true);
                        break;
                    case 'delay':
                        const newDelay = parseInt(args[0]);
                        if (newDelay) {
                            bot.config.delay = newDelay;
                            saveToDisk();
                            sendMessage(bot, d.channel_id, `⏱️ Delay: ${newDelay}ms`, true);
                        }
                        break;
                }
            }
        } catch (e) {}
    });
    
    ws.on('close', (code) => {
        clearInterval(bot.heartbeat);
        bot.running = false;
        console.log(`[Bot ${bot.id}] Disconnected (${code})`);
        setTimeout(() => connectBot(bot), 3000);
    });
    
    ws.on('error', (err) => {
        console.log(`[Bot ${bot.id}] Error: ${err.message}`);
    });
}

// Web server
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

app.get('/api/bots', (req, res) => {
    res.json(TOKENS.map(t => ({
        id: t.id,
        username: t.username || `Bot ${t.id}`,
        connected: t.running,
        config: t.config,
        queueSize: t.messageQueue.length
    })));
});

app.post('/api/bot/:id/configure', (req, res) => {
    const bot = TOKENS.find(t => t.id === parseInt(req.params.id));
    if (!bot) return res.status(404).json({ error: 'Not found' });
    
    const { serverId, channelId, message, delay, enabled, burstMode } = req.body;
    
    if (serverId !== undefined) bot.config.serverId = serverId;
    if (channelId !== undefined) bot.config.channelId = channelId;
    if (message !== undefined) bot.config.message = message;
    if (delay !== undefined) bot.config.delay = Math.max(800, parseInt(delay) || 3000);
    if (enabled !== undefined) bot.config.enabled = enabled;
    if (burstMode !== undefined) bot.config.burstMode = burstMode;
    
    saveToDisk();
    res.json({ success: true, config: bot.config });
});

app.post('/api/bot/:id/spam/start', (req, res) => {
    const bot = TOKENS.find(t => t.id === parseInt(req.params.id));
    if (!bot?.running) return res.status(400).json({ error: 'Not connected' });
    
    bot.config.spamming = true;
    saveToDisk();
    startSpamming(bot);
    res.json({ success: true });
});

app.post('/api/bot/:id/spam/stop', (req, res) => {
    const bot = TOKENS.find(t => t.id === parseInt(req.params.id));
    if (!bot) return res.status(404).json({ error: 'Not found' });
    
    stopSpamming(bot);
    res.json({ success: true });
});

app.post('/api/bot/:id/sendnow', (req, res) => {
    const bot = TOKENS.find(t => t.id === parseInt(req.params.id));
    if (!bot?.running) return res.status(400).json({ error: 'Not connected' });
    
    const { message, channelId } = req.body;
    sendMessage(bot, channelId || bot.config.channelId, message || bot.config.message, true);
    res.json({ success: true });
});

const server = http.createServer(app);
server.listen(PORT, () => {
    console.log(`⚡ High-Performance Spammer v4.0`);
    console.log(`🌐 Dashboard: http://localhost:${PORT}`);
    console.log(`🤖 Loading ${TOKENS.length} bot(s)...`);
    TOKENS.forEach(connectBot);
});
