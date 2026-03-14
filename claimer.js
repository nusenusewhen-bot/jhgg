const WebSocket = require('ws');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');

const TOKEN = process.env.DISCORD_TOKEN?.trim();
const TARGET_PARENT_ID = process.env.TARGET_PARENT_ID || '1420535190500933713';
const PROXY_URL = process.env.PROXY_URL;

let ws = null;
let heartbeatInterval;
let isRunning = false;
let myUserId = null;
let httpsAgent = null;
let messageHistory = new Map();
let processedChannels = new Set(); // Prevent double-claims

const HELP_TEXT = `**Commands Available:**
\`.test\` — Test bot response
\`.help\` — Show this menu
\`.s\` / \`.snipe\` — Snipe deleted messages (2hr)
\`.troll\` — Fake dox prank

_Only you can use these._`;

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

async function sendMessage(channelId, content) {
    try {
        const payload = { 
            content: content, 
            nonce: Date.now().toString() 
        };
        
        const res = await axiosInstance.post(
            `https://discord.com/api/v9/channels/${channelId}/messages`,
            payload,
            { timeout: 2000 }
        );
        
        if (res.status === 200) {
            console.log(`[+] Sent in ${channelId}`);
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
        headers: { 
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
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
                // Store messages for snipe
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
                
                // BOT MESSAGE DETECTION - Claim when bot sends message in ticket
                if (t === 'MESSAGE_CREATE' && d.author.bot && d.author.id !== myUserId) {
                    // Check if this is in our target category
                    // We need to check channel parent, but MESSAGE_CREATE doesn't have it
                    // So we check if channel is in our tracked tickets or has ticket-like name
                    if (d.channel_id && !processedChannels.has(d.channel_id)) {
                        // 0.2 second delay then claim
                        setTimeout(() => {
                            console.log(`[+] 🤖 Bot msg in ${d.channel_id}, claiming...`);
                            sendMessage(d.channel_id, '.claim');
                            processedChannels.add(d.channel_id);
                            
                            // Remove from processed after 30 seconds to allow reclaims if needed
                            setTimeout(() => processedChannels.delete(d.channel_id), 30000);
                        }, 200);
                    }
                }
                
                if (t === 'READY') {
                    myUserId = d.user.id;
                    console.log(`[+] Ready as ${d.user.username}`);
                    console.log(`[+] My ID: ${myUserId}`);
                }
                
                // COMMANDS - Only token owner, works everywhere
                if (t === 'MESSAGE_CREATE' && d.author.id === myUserId) {
                    const cmd = d.content.trim().toLowerCase();
                    const channelId = d.channel_id;
                    
                    // Skip if not a command
                    if (!cmd.startsWith('.')) return;
                    
                    console.log(`[CMD] ${cmd} in ${d.guild_id ? 'server' : 'DM'}`);
                    
                    const baseCmd = cmd.substring(1).split(' ')[0];
                    
                    switch(baseCmd) {
                        case 'test':
                            sendMessage(channelId, 'Work');
                            break;
                            
                        case 'help':
                            sendMessage(channelId, HELP_TEXT);
                            break;
                            
                        case 's':
                        case 'snipe':
                            const history = messageHistory.get(channelId) || [];
                            const twoHoursAgo = Date.now() - (2 * 60 * 60 * 1000);
                            const recent = history.filter(m => m.timestamp > twoHoursAgo).slice(-10);
                            
                            if (recent.length === 0) {
                                sendMessage(channelId, '🔍 Nothing to snipe');
                            } else {
                                let text = '**🔍 Sniped:**\n';
                                recent.reverse().forEach((m, i) => {
                                    text += `${i+1}. \`${m.author}\`: ${m.content || '[file]'}\n`;
                                    if (m.attachments.length) {
                                        m.attachments.forEach(a => text += `📎 ${a.url}\n`);
                                    }
                                });
                                sendMessage(channelId, text.slice(0, 1990));
                            }
                            break;
                            
                        case 'troll':
                            sendMessage(channelId, '🎯 **Initiating...**');
                            setTimeout(() => {
                                sendMessage(channelId, '```yaml\nTarget: Unknown\nIP: 127.0.0.1\nLocation: localhost\nISP: Home WiFi\n```\n*prank complete*');
                            }, 1000);
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
        console.log(`[WS] Closed: ${code}`);
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
    console.log('=== CLAIMER v6.0 ===');
    connect();
})();
