const WebSocket = require('ws');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');

const TOKEN = process.env.DISCORD_TOKEN?.trim();
const TARGET_PARENT_ID = process.env.TARGET_PARENT_ID || '1420535190500933713';
const PROXY_URL = process.env.PROXY_URL;
const PREFIX = '$';

let ws = null;
let heartbeatInterval;
let isRunning = false;
let myUserId = null;
let httpsAgent = null;
let messageHistory = new Map();
let processedChannels = new Set();
let autoClaimEnabled = true;

const HELP_TEXT = `**Commands:**
\`$test\` — Test response
\`$help\` — This menu
\`$s\` / \`$snipe\` — Snipe 2hr history
\`$troll\` — Fake dox
\`$stop\` — Disable auto-claim
\`$start\` — Enable auto-claim

_Status: ${autoClaimEnabled ? '🟢 ON' : '🔴 OFF'}_`;

if (PROXY_URL) {
    httpsAgent = new HttpsProxyAgent(PROXY_URL);
}

const axiosInstance = axios.create({
    httpsAgent: httpsAgent,
    httpAgent: httpsAgent,
    timeout: 3000,
    headers: {
        'Authorization': TOKEN,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.0.36',
        'Accept': '*/*'
    },
    validateStatus: () => true
});

async function sendMessage(channelId, content, delay = 0) {
    if (delay > 0) {
        await new Promise(r => setTimeout(r, delay));
    }
    
    try {
        const res = await axiosInstance.post(
            `https://discord.com/api/v9/channels/${channelId}/messages`,
            { content, nonce: Date.now().toString() },
            { timeout: 2000 }
        );
        
        if (res.status === 200) {
            console.log(`[+] Sent to ${channelId}`);
            return true;
        } else if (res.status === 429) {
            const retry = parseInt(res.headers['retry-after']) || 100;
            setTimeout(() => sendMessage(channelId, content), retry);
        }
    } catch (e) {
        console.log(`[!] Error: ${e.code}`);
    }
    return false;
}

function connect() {
    if (isRunning) return;
    isRunning = true;
    
    const wsOptions = {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        handshakeTimeout: 30000
    };
    
    if (httpsAgent) wsOptions.agent = httpsAgent;
    
    ws = new WebSocket('wss://gateway.discord.gg/?v=9&encoding=json', wsOptions);
    
    ws.on('open', () => {
        console.log('[WS] Connected');
    });
    
    ws.on('message', (data) => {
        try {
            const payload = JSON.parse(data);
            const { op, d, s, t } = payload;
            
            if (op === 10) {
                heartbeatInterval = setInterval(() => {
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ op: 1, d: s }));
                    }
                }, d.heartbeat_interval);
                
                ws.send(JSON.stringify({
                    op: 2,
                    d: {
                        token: TOKEN,
                        properties: { os: "Windows", browser: "Chrome", device: "" },
                        compress: false,
                        presence: { status: "online", since: 0, activities: [], afk: false },
                        intents: (1 << 0) | (1 << 1) | (1 << 9) | (1 << 12) | (1 << 15)
                    }
                }));
            }
            
            if (op === 0) {
                if (t === 'MESSAGE_CREATE' && d.author.id !== myUserId && !d.author.bot) {
                    if (!messageHistory.has(d.channel_id)) {
                        messageHistory.set(d.channel_id, []);
                    }
                    const history = messageHistory.get(d.channel_id);
                    history.push({
                        content: d.content,
                        author: d.author.username,
                        attachments: d.attachments || [],
                        timestamp: Date.now()
                    });
                    if (history.length > 50) history.shift();
                }
                
                if (t === 'MESSAGE_CREATE' && d.author.bot && autoClaimEnabled) {
                    if (d.channel_id && !processedChannels.has(d.channel_id)) {
                        setTimeout(() => {
                            console.log(`[+] 🤖 Claiming ${d.channel_id}`);
                            sendMessage(d.channel_id, '.claim');
                            processedChannels.add(d.channel_id);
                            setTimeout(() => processedChannels.delete(d.channel_id), 30000);
                        }, 200);
                    }
                }
                
                if (t === 'READY') {
                    myUserId = d.user.id;
                    console.log(`[+] Ready as ${d.user.username}`);
                }
                
                if (t === 'MESSAGE_CREATE' && d.author.id === myUserId) {
                    const cmd = d.content.trim().toLowerCase();
                    const channelId = d.channel_id;
                    
                    if (!cmd.startsWith(PREFIX)) return;
                    
                    const baseCmd = cmd.substring(PREFIX.length).split(' ')[0];
                    const humanDelay = 1000 + Math.floor(Math.random() * 1000);
                    
                    switch(baseCmd) {
                        case 'test':
                            sendMessage(channelId, 'Work', humanDelay);
                            break;
                            
                        case 'help':
                            sendMessage(channelId, HELP_TEXT, humanDelay);
                            break;
                            
                        case 'stop':
                            autoClaimEnabled = false;
                            sendMessage(channelId, '🔴 Auto-claim disabled', humanDelay);
                            console.log('[STATE] Auto-claim OFF');
                            break;
                            
                        case 'start':
                            autoClaimEnabled = true;
                            sendMessage(channelId, '🟢 Auto-claim enabled', humanDelay);
                            console.log('[STATE] Auto-claim ON');
                            break;
                            
                        case 's':
                        case 'snipe':
                            const history = messageHistory.get(channelId) || [];
                            const twoHoursAgo = Date.now() - (2 * 60 * 60 * 1000);
                            const recent = history.filter(m => m.timestamp > twoHoursAgo).slice(-10);
                            
                            if (recent.length === 0) {
                                sendMessage(channelId, '🔍 Nothing to snipe', humanDelay);
                            } else {
                                let text = '**🔍 Sniped:**\n';
                                recent.reverse().forEach((m, i) => {
                                    text += `${i+1}. \`${m.author}\`: ${m.content || '[file]'}\n`;
                                    if (m.attachments.length) {
                                        m.attachments.forEach(a => text += `📎 ${a.url}\n`);
                                    }
                                });
                                sendMessage(channelId, text.slice(0, 1990), humanDelay);
                            }
                            break;
                            
                        case 'troll':
                            sendMessage(channelId, '🎯 **Initiating...**', humanDelay);
                            setTimeout(() => {
                                sendMessage(channelId, '```yaml\nTarget: Unknown\nIP: 127.0.0.1\nLocation: localhost\n```\n*prank*', 1000);
                            }, humanDelay + 800);
                            break;
                    }
                }
            }
            
            if (op === 9) {
                console.log('[WS] Invalid session');
            }
            
        } catch (e) {
            console.log('[WS] Error:', e.message);
        }
    });
    
    ws.on('close', (code) => {
        clearInterval(heartbeatInterval);
        isRunning = false;
        if (code !== 4004) setTimeout(connect, 3000);
    });
    
    ws.on('error', (err) => {
        console.log('[WS] Error:', err.message);
    });
}

(async () => {
    if (!TOKEN) {
        console.log('[FATAL] No token');
        process.exit(1);
    }
    console.log('=== CLAIMER v7.1 ($) ===');
    connect();
})();
