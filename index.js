const WebSocket = require('ws');
const axios = require('axios');
const express = require('express');
const { HttpsProxyAgent } = require('https-proxy-agent');
const bodyParser = require('body-parser');
const path = require('path');

// ==================== CONFIG ====================
const PORT = process.env.PORT || 3000;
const PREFIX = process.env.COMMAND_PREFIX || '$';
const TARGET_PARENT_ID = process.env.TARGET_PARENT_ID || '1420535190500933713';

// Token management - supports unlimited tokens via env
const TOKENS = [];
let tokenIndex = 1;
while (process.env[`DISCORD_TOKEN${tokenIndex === 1 ? '' : tokenIndex}`]) {
    TOKENS.push({
        id: tokenIndex,
        token: process.env[`DISCORD_TOKEN${tokenIndex === 1 ? '' : tokenIndex}`].trim(),
        ws: null,
        heartbeat: null,
        running: false,
        userId: null,
        username: null,
        config: {
            enabled: false,
            serverId: null,
            channelId: null,
            message: null,
            delay: 5000,
            spamming: false,
            spamInterval: null
        }
    });
    tokenIndex++;
}

// ==================== WEB DASHBOARD ====================
const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// API Endpoints
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
    bot.config.serverId = serverId || bot.config.serverId;
    bot.config.channelId = channelId || bot.config.channelId;
    bot.config.message = message || bot.config.message;
    bot.config.delay = delay || 5000;
    bot.config.enabled = enabled !== undefined ? enabled : bot.config.enabled;
    
    res.json({ success: true, config: bot.config });
});

app.post('/api/bot/:id/spam/start', (req, res) => {
    const bot = TOKENS.find(t => t.id === parseInt(req.params.id));
    if (!bot || !bot.running) return res.status(400).json({ error: 'Bot not connected' });
    if (!bot.config.channelId || !bot.config.message) {
        return res.status(400).json({ error: 'Configure channel and message first' });
    }
    
    startSpamming(bot);
    res.json({ success: true, message: 'Spamming started' });
});

app.post('/api/bot/:id/spam/stop', (req, res) => {
    const bot = TOKENS.find(t => t.id === parseInt(req.params.id));
    if (!bot) return res.status(404).json({ error: 'Bot not found' });
    
    stopSpamming(bot);
    res.json({ success: true, message: 'Spamming stopped' });
});

app.post('/api/bot/:id/send', (req, res) => {
    const bot = TOKENS.find(t => t.id === parseInt(req.params.id));
    if (!bot || !bot.running) return res.status(400).json({ error: 'Bot not connected' });
    
    const { message, channelId } = req.body;
    sendMessage(bot, channelId || bot.config.channelId, message || bot.config.message);
    res.json({ success: true });
});

// ==================== DISCORD SELF BOT CORE ====================
const SUPER_PROPERTIES = {
    "os": "Windows",
    "browser": "Chrome",
    "device": "",
    "system_locale": "en-US",
    "browser_user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "browser_version": "120.0.0.0",
    "os_version": "10",
    "release_channel": "stable",
    "client_build_number": 242635,
    "client_event_source": null
};

function getHeaders(token) {
    const timestamp = Date.now();
    return {
        'Authorization': token,
        'Content-Type': 'application/json',
        'User-Agent': SUPER_PROPERTIES.browser_user_agent,
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'X-Super-Properties': Buffer.from(JSON.stringify(SUPER_PROPERTIES)).toString('base64'),
        'X-Discord-Locale': 'en-US',
        'Origin': 'https://discord.com',
        'Referer': 'https://discord.com/channels/@me',
        'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'X-Request-Id': `${timestamp}-${Math.random().toString(36).substring(2, 15)}`
    };
}

async function sendMessage(bot, channelId, content, delay = 1000) {
    if (!channelId || !content) return false;
    
    await new Promise(r => setTimeout(r, delay));
    
    try {
        const res = await axios.post(
            `https://discord.com/api/v9/channels/${channelId}/messages`,
            { 
                content, 
                nonce: Date.now().toString(),
                tts: false 
            },
            { 
                headers: getHeaders(bot.token),
                timeout: 5000,
                validateStatus: () => true
            }
        );
        
        if (res.status === 200) {
            console.log(`[Bot ${bot.id}] Sent to ${channelId}`);
            return true;
        } else if (res.status === 429) {
            const retry = parseInt(res.headers['retry-after']) || 5000;
            console.log(`[Bot ${bot.id}] Rate limited, retrying in ${retry}ms`);
            setTimeout(() => sendMessage(bot, channelId, content, 0), retry);
        }
    } catch (e) {
        console.log(`[Bot ${bot.id}] Error: ${e.message}`);
    }
    return false;
}

function startSpamming(bot) {
    if (bot.config.spamming) return;
    bot.config.spamming = true;
    
    const spamLoop = async () => {
        if (!bot.config.spamming || !bot.running) return;
        
        await sendMessage(bot, bot.config.channelId, bot.config.message, 0);
        
        // Random delay between messages (jitter to avoid detection)
        const jitter = Math.floor(Math.random() * 1000);
        bot.config.spamInterval = setTimeout(spamLoop, bot.config.delay + jitter);
    };
    
    spamLoop();
    console.log(`[Bot ${bot.id}] Spamming started in ${bot.config.channelId}`);
}

function stopSpamming(bot) {
    bot.config.spamming = false;
    if (bot.config.spamInterval) {
        clearTimeout(bot.config.spamInterval);
        bot.config.spamInterval = null;
    }
    console.log(`[Bot ${bot.id}] Spamming stopped`);
}

function connectBot(bot) {
    if (bot.running) return;
    
    const ws = new WebSocket('wss://gateway.discord.gg/?v=9&encoding=json', {
        headers: { 
            'User-Agent': SUPER_PROPERTIES.browser_user_agent,
            'Origin': 'https://discord.com'
        },
        handshakeTimeout: 30000
    });
    
    bot.ws = ws;
    
    ws.on('open', () => {
        console.log(`[Bot ${bot.id}] WebSocket connected`);
    });
    
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
                        properties: SUPER_PROPERTIES,
                        presence: { 
                            status: "online", 
                            since: 0, 
                            activities: [], 
                            afk: false 
                        },
                        compress: false,
                        client_state: {
                            guild_versions: {},
                            highest_last_message_id: "0",
                            read_state_version: 0,
                            user_guild_settings_version: -1,
                            user_settings_version: -1,
                            private_channels_version: "0"
                        },
                        intents: (1 << 0) | (1 << 1) | (1 << 9) | (1 << 12)
                    }
                }));
            }
            
            if (op === 0) {
                if (t === 'READY') {
                    bot.userId = d.user.id;
                    bot.username = d.user.username;
                    bot.running = true;
                    console.log(`[Bot ${bot.id}] Ready as ${d.user.username}`);
                    
                    // Auto-start if configured
                    if (bot.config.enabled && bot.config.channelId) {
                        startSpamming(bot);
                    }
                }
                
                // Command handler
                if (t === 'MESSAGE_CREATE' && d.author.id === bot.userId) {
                    const cmd = d.content.trim().toLowerCase();
                    if (!cmd.startsWith(PREFIX)) return;
                    
                    const args = cmd.slice(PREFIX.length).trim().split(' ');
                    const command = args.shift();
                    const channelId = d.channel_id;
                    
                    switch(command) {
                        case 'spam':
                            if (args[0] === 'stop') {
                                stopSpamming(bot);
                                sendMessage(bot, channelId, '🔴 Spamming stopped', 500);
                            } else {
                                bot.config.channelId = channelId;
                                bot.config.message = args.join(' ') || 'Spam message';
                                startSpamming(bot);
                                sendMessage(bot, channelId, '🟢 Spamming started', 500);
                            }
                            break;
                        case 'say':
                            sendMessage(bot, channelId, args.join(' '), 500);
                            break;
                        case 'status':
                            const status = `🟢 Connected: ${bot.running}\n📍 Channel: ${bot.config.channelId}\n⏱️ Delay: ${bot.config.delay}ms\n▶️ Spamming: ${bot.config.spamming}`;
                            sendMessage(bot, channelId, status, 500);
                            break;
                    }
                }
            }
            
            if (op === 9) {
                console.log(`[Bot ${bot.id}] Invalid session`);
            }
        } catch (e) {
            console.log(`[Bot ${bot.id}] Error:`, e.message);
        }
    });
    
    ws.on('close', (code) => {
        clearInterval(bot.heartbeat);
        bot.running = false;
        stopSpamming(bot);
        if (code !== 4004) setTimeout(() => connectBot(bot), 5000);
    });
    
    ws.on('error', (err) => {
        console.log(`[Bot ${bot.id}] WS Error:`, err.message);
    });
}

// ==================== INIT ====================
app.listen(PORT, () => {
    console.log(`🌐 Dashboard running on port ${PORT}`);
    
    if (TOKENS.length === 0) {
        console.log('⚠️ No tokens found. Set DISCORD_TOKEN, DISCORD_TOKEN2, etc.');
        return;
    }
    
    console.log(`🔌 Connecting ${TOKENS.length} bot(s)...`);
    TOKENS.forEach(bot => connectBot(bot));
});
