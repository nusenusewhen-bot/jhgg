const WebSocket = require('ws');
const axios = require('axios');
const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');

const PORT = process.env.PORT || 3000;
const CONFIG_FILE = './bot_configs.json';

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
        sessionId: null,
        resumeGatewayUrl: null,
        lastSequence: null,
        reconnectAttempts: 0,
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

function getHeaders(token) {
    return {
        'Authorization': token,
        'Content-Type': 'application/json',
        'User-Agent': SUPER_PROPS.browser_user_agent,
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'X-Super-Properties': Buffer.from(JSON.stringify(SUPER_PROPS)).toString('base64'),
        'X-Discord-Locale': 'en-US',
        'X-Discord-Timezone': 'America/New_York',
        'Origin': 'https://discord.com',
        'Referer': 'https://discord.com/channels/@me',
        'Sec-Ch-Ua': '"Not A(Brand";v="99", "Google Chrome";v="121", "Chromium";v="121"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin'
    };
}

async function sendMessage(bot, channelId, content, priority = false) {
    if (!channelId || !content) return false;
    
    try {
        const res = await axios.post(
            `https://discord.com/api/v9/channels/${channelId}/messages`,
            {
                content,
                nonce: `${Date.now()}${Math.random().toString(36).substring(2, 10)}`,
                tts: false
            },
            { 
                headers: getHeaders(bot.token),
                timeout: 10000,
                validateStatus: () => true
            }
        );
        
        if (res.status === 200) {
            console.log(`[Bot ${bot.id}] Sent`);
            return true;
        }
        
        if (res.status === 429) {
            const retry = parseInt(res.headers['retry-after']) || 5000;
            setTimeout(() => sendMessage(bot, channelId, content, true), retry);
        } else if (res.status === 401) {
            console.log(`[Bot ${bot.id}] Invalid token`);
            bot.running = false;
        }
    } catch (e) {
        console.log(`[Bot ${bot.id}] Error: ${e.message}`);
    }
    return false;
}

function startSpamming(bot) {
    if (!bot.config.channelId || !bot.config.message || !bot.running) return;
    
    const loop = async () => {
        if (!bot.config.spamming || !bot.running) return;
        
        await sendMessage(bot, bot.config.channelId, bot.config.message);
        
        const delay = bot.config.burstMode ? 800 : bot.config.delay;
        setTimeout(loop, delay + Math.random() * 500);
    };
    
    loop();
}

function connectBot(bot, isResume = false) {
    return new Promise((resolve) => {
        if (bot.ws && (bot.ws.readyState === WebSocket.OPEN || bot.ws.readyState === WebSocket.CONNECTING)) {
            console.log(`[Bot ${bot.id}] Already connecting`);
            resolve();
            return;
        }

        if (bot.ws) {
            try {
                bot.ws.terminate();
            } catch (e) {}
            bot.ws = null;
        }

        const gatewayUrl = isResume && bot.resumeGatewayUrl && bot.sessionId
            ? `${bot.resumeGatewayUrl}/?v=9&encoding=json`
            : 'wss://gateway.discord.gg/?v=9&encoding=json';

        console.log(`[Bot ${bot.id}] Connecting...`);

        const ws = new WebSocket(gatewayUrl, {
            headers: {
                'User-Agent': SUPER_PROPS.browser_user_agent,
                'Origin': 'https://discord.com'
            },
            handshakeTimeout: 30000
        });
        
        bot.ws = ws;
        let resolved = false;
        
        const cleanup = () => {
            clearInterval(bot.heartbeat);
            if (!resolved) {
                resolved = true;
                resolve();
            }
        };
        
        ws.on('open', () => {
            console.log(`[Bot ${bot.id}] Socket opened`);
            bot.reconnectAttempts = 0;
            
            if (isResume && bot.sessionId) {
                ws.send(JSON.stringify({
                    op: 6,
                    d: {
                        token: bot.token,
                        session_id: bot.sessionId,
                        seq: bot.lastSequence || 0
                    }
                }));
            }
        });
        
        ws.on('message', (data) => {
            try {
                const payload = JSON.parse(data);
                const { op, d, s, t } = payload;
                
                if (s !== null) bot.lastSequence = s;
                
                if (op === 10) {
                    bot.heartbeat = setInterval(() => {
                        if (ws.readyState === WebSocket.OPEN) {
                            ws.send(JSON.stringify({ op: 1, d: bot.lastSequence }));
                        }
                    }, d.heartbeat_interval);
                    
                    if (!isResume || !bot.sessionId) {
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
                                        details: "Online"
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
                }
                
                if (op === 11) {
                    // Heartbeat ACK
                }
                
                if (op === 7) {
                    console.log(`[Bot ${bot.id}] Reconnect requested`);
                    ws.close(4000, "Reconnect requested");
                    return;
                }
                
                if (op === 9) {
                    console.log(`[Bot ${bot.id}] Invalid session`);
                    bot.sessionId = null;
                    bot.resumeGatewayUrl = null;
                    ws.close();
                    return;
                }
                
                if (t === 'READY') {
                    bot.userId = d.user.id;
                    bot.username = d.user.username;
                    bot.sessionId = d.session_id;
                    bot.resumeGatewayUrl = d.resume_gateway_url;
                    bot.running = true;
                    console.log(`[Bot ${bot.id}] READY: ${d.user.username}`);
                    
                    if (bot.config.enabled && bot.config.spamming) {
                        startSpamming(bot);
                    }
                    
                    if (!resolved) {
                        resolved = true;
                        resolve();
                    }
                }
                
                if (t === 'RESUMED') {
                    console.log(`[Bot ${bot.id}] Resumed`);
                    bot.running = true;
                    if (!resolved) {
                        resolved = true;
                        resolve();
                    }
                }
                
            } catch (e) {
                console.log(`[Bot ${bot.id}] Parse error: ${e.message}`);
            }
        });
        
        ws.on('close', (code, reason) => {
            console.log(`[Bot ${bot.id}] Closed: ${code}`);
            bot.running = false;
            cleanup();
            
            const delay = Math.min(5000 * (bot.reconnectAttempts + 1), 60000);
            bot.reconnectAttempts++;
            
            setTimeout(() => {
                const shouldResume = code < 4000 && bot.sessionId && bot.resumeGatewayUrl;
                connectBot(bot, shouldResume);
            }, delay);
        });
        
        ws.on('error', (err) => {
            console.log(`[Bot ${bot.id}] Error: ${err.message}`);
            cleanup();
        });
    });
}

async function connectAllBots() {
    console.log(`Starting ${TOKENS.length} bot(s)...`);
    
    for (let i = 0; i < TOKENS.length; i++) {
        const bot = TOKENS[i];
        connectBot(bot);
        if (i < TOKENS.length - 1) {
            await new Promise(r => setTimeout(r, 2500));
        }
    }
    
    console.log('All bots started');
}

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
        connected: t.running && t.ws?.readyState === WebSocket.OPEN,
        config: t.config
    })));
});

app.post('/api/bot/:id/configure', (req, res) => {
    const bot = TOKENS.find(t => t.id === parseInt(req.params.id));
    if (!bot) return res.status(404).json({ error: 'Not found' });
    
    const { serverId, channelId, message, delay, enabled, burstMode, spamming } = req.body;
    
    if (serverId !== undefined) bot.config.serverId = serverId;
    if (channelId !== undefined) bot.config.channelId = channelId;
    if (message !== undefined) bot.config.message = message;
    if (delay !== undefined) bot.config.delay = Math.max(800, parseInt(delay) || 3000);
    if (enabled !== undefined) bot.config.enabled = enabled;
    if (burstMode !== undefined) bot.config.burstMode = burstMode;
    if (spamming !== undefined) bot.config.spamming = spamming;
    
    saveToDisk();
    res.json({ success: true, config: bot.config });
});

app.post('/api/bot/:id/spam/start', (req, res) => {
    const bot = TOKENS.find(t => t.id === parseInt(req.params.id));
    if (!bot?.running) return res.status(400).json({ error: 'Not connected' });
    
    bot.config.spamming = true;
    bot.config.enabled = true;
    saveToDisk();
    startSpamming(bot);
    res.json({ success: true });
});

app.post('/api/bot/:id/spam/stop', (req, res) => {
    const bot = TOKENS.find(t => t.id === parseInt(req.params.id));
    if (!bot) return res.status(404).json({ error: 'Not found' });
    
    bot.config.spamming = false;
    saveToDisk();
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
    console.log(`Spammer v4.2 - Port ${PORT}`);
    connectAllBots();
});
