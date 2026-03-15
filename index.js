const WebSocket = require('ws');
const axios = require('axios');
const express = require('express');
const { HttpsProxyAgent } = require('https-proxy-agent');
const bodyParser = require('body-parser');
const path = require('path');
const db = require('./database');

const PORT = process.env.PORT || 3000;
const PREFIX = process.env.COMMAND_PREFIX || '$';

// Load saved configs from DB
function loadConfig(botId) {
    const row = db.prepare('SELECT * FROM bot_configs WHERE bot_id = ?').get(botId);
    return row ? {
        serverId: row.server_id,
        channelId: row.channel_id,
        message: row.message,
        delay: row.delay,
        enabled: !!row.enabled,
        spamming: !!row.spamming
    } : { delay: 5000, enabled: false, spamming: false };
}

function saveConfig(botId, config) {
    db.prepare(`
        INSERT INTO bot_configs (bot_id, server_id, channel_id, message, delay, enabled, spamming)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(bot_id) DO UPDATE SET
            server_id = excluded.server_id,
            channel_id = excluded.channel_id,
            message = excluded.message,
            delay = excluded.delay,
            enabled = excluded.enabled,
            spamming = excluded.spamming,
            updated_at = CURRENT_TIMESTAMP
    `).run(botId, config.serverId || null, config.channelId || null, config.message || null, config.delay || 5000, config.enabled ? 1 : 0, config.spamming ? 1 : 0);
}

// Token loading
const TOKENS = [];
let tokenIndex = 1;
while (process.env[`DISCORD_TOKEN${tokenIndex === 1 ? '' : tokenIndex}`]) {
    const savedConfig = loadConfig(tokenIndex);
    TOKENS.push({
        id: tokenIndex,
        token: process.env[`DISCORD_TOKEN${tokenIndex === 1 ? '' : tokenIndex}`].trim(),
        ws: null,
        heartbeat: null,
        running: false,
        userId: null,
        username: null,
        config: savedConfig
    });
    tokenIndex++;
}

const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// API with persistence
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
    bot.config = {
        ...bot.config,
        serverId: serverId !== undefined ? serverId : bot.config.serverId,
        channelId: channelId !== undefined ? channelId : bot.config.channelId,
        message: message !== undefined ? message : bot.config.message,
        delay: delay || bot.config.delay,
        enabled: enabled !== undefined ? enabled : bot.config.enabled
    };
    
    saveConfig(bot.id, bot.config);
    res.json({ success: true, config: bot.config });
});

app.post('/api/bot/:id/spam/start', (req, res) => {
    const bot = TOKENS.find(t => t.id === parseInt(req.params.id));
    if (!bot || !bot.running) return res.status(400).json({ error: 'Bot not connected' });
    if (!bot.config.channelId || !bot.config.message) {
        return res.status(400).json({ error: 'Configure channel and message first' });
    }
    
    bot.config.spamming = true;
    bot.config.enabled = true;
    saveConfig(bot.id, bot.config);
    startSpamming(bot);
    res.json({ success: true });
});

app.post('/api/bot/:id/spam/stop', (req, res) => {
    const bot = TOKENS.find(t => t.id === parseInt(req.params.id));
    if (!bot) return res.status(404).json({ error: 'Bot not found' });
    
    bot.config.spamming = false;
    saveConfig(bot.id, bot.config);
    stopSpamming(bot);
    res.json({ success: true });
});

// Discord connection code (same as before but with persistence hooks)
const SUPER_PROPERTIES = {
    "os": "Windows",
    "browser": "Chrome",
    "device": "",
    "system_locale": "en-US",
    "browser_user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "browser_version": "120.0.0.0",
    "os_version": "10",
    "release_channel": "stable",
    "client_build_number": 242635
};

function getHeaders(token) {
    return {
        'Authorization': token,
        'Content-Type': 'application/json',
        'User-Agent': SUPER_PROPERTIES.browser_user_agent,
        'Accept': '*/*',
        'X-Super-Properties': Buffer.from(JSON.stringify(SUPER_PROPERTIES)).toString('base64'),
        'Origin': 'https://discord.com',
        'Referer': 'https://discord.com/channels/@me'
    };
}

async function sendMessage(bot, channelId, content, delay = 1000) {
    if (!channelId || !content) return false;
    await new Promise(r => setTimeout(r, delay));
    
    try {
        const res = await axios.post(
            `https://discord.com/api/v9/channels/${channelId}/messages`,
            { content, nonce: Date.now().toString(), tts: false },
            { headers: getHeaders(bot.token), timeout: 5000, validateStatus: () => true }
        );
        
        if (res.status === 200) {
            db.prepare('INSERT INTO spam_logs (bot_id, channel_id, message) VALUES (?, ?, ?)')
              .run(bot.id, channelId, content.substring(0, 100));
            return true;
        } else if (res.status === 429) {
            setTimeout(() => sendMessage(bot, channelId, content, 0), parseInt(res.headers['retry-after']) || 5000);
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
        await sendMessage(bot, bot.config.channelId, bot.config.message, 0);
        const jitter = Math.floor(Math.random() * 1000);
        setTimeout(loop, bot.config.delay + jitter);
    };
    loop();
}

function stopSpamming(bot) {
    bot.config.spamming = false;
    saveConfig(bot.id, bot.config);
}

function connectBot(bot) {
    if (bot.running) return;
    
    const ws = new WebSocket('wss://gateway.discord.gg/?v=9&encoding=json', {
        headers: { 'User-Agent': SUPER_PROPERTIES.browser_user_agent },
        handshakeTimeout: 30000
    });
    
    bot.ws = ws;
    
    ws.on('open', () => console.log(`[Bot ${bot.id}] Connected`));
    
    ws.on('message', (data) => {
        try {
            const { op, d, s, t } = JSON.parse(data);
            
            if (op === 10) {
                bot.heartbeat = setInterval(() => {
                    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: 1, d: s }));
                }, d.heartbeat_interval);
                
                ws.send(JSON.stringify({
                    op: 2,
                    d: {
                        token: bot.token,
                        capabilities: 30717,
                        properties: SUPER_PROPERTIES,
                        presence: { status: "online", since: 0, activities: [], afk: false },
                        compress: false,
                        client_state: { guild_versions: {}, highest_last_message_id: "0", read_state_version: 0 },
                        intents: (1 << 0) | (1 << 1) | (1 << 9)
                    }
                }));
            }
            
            if (op === 0 && t === 'READY') {
                bot.userId = d.user.id;
                bot.username = d.user.username;
                bot.running = true;
                console.log(`[Bot ${bot.id}] Ready as ${d.user.username}`);
                
                if (bot.config.enabled && bot.config.spamming) startSpamming(bot);
            }
            
            if (op === 0 && t === 'MESSAGE_CREATE' && d.author.id === bot.userId) {
                const cmd = d.content.trim().toLowerCase();
                if (!cmd.startsWith(PREFIX)) return;
                const args = cmd.slice(PREFIX.length).trim().split(' ');
                const command = args.shift();
                
                switch(command) {
                    case 'spam':
                        if (args[0] === 'stop') {
                            stopSpamming(bot);
                            sendMessage(bot, d.channel_id, '🔴 Stopped', 500);
                        } else {
                            bot.config.channelId = d.channel_id;
                            bot.config.message = args.join(' ') || bot.config.message;
                            bot.config.spamming = true;
                            saveConfig(bot.id, bot.config);
                            startSpamming(bot);
                            sendMessage(bot, d.channel_id, '🟢 Started', 500);
                        }
                        break;
                    case 'stop':
                        stopSpamming(bot);
                        sendMessage(bot, d.channel_id, '🔴 Stopped', 500);
                        break;
                }
            }
        } catch (e) {
            console.log(`[Bot ${bot.id}] Error: ${e.message}`);
        }
    });
    
    ws.on('close', () => {
        clearInterval(bot.heartbeat);
        bot.running = false;
        setTimeout(() => connectBot(bot), 5000);
    });
}

app.listen(PORT, () => {
    console.log(`Dashboard: http://localhost:${PORT}`);
    TOKENS.forEach(bot => connectBot(bot));
});
