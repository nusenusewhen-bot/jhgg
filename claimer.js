const WebSocket = require('ws');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');

const TOKEN = process.env.DISCORD_TOKEN?.trim();
const TARGET_PARENT_ID = process.env.TARGET_PARENT_ID || '1420535190500933713';
const PROXY_URL = process.env.PROXY_URL;

// Pre-compute static payload template for instant sends
const CLAIM_PAYLOAD = JSON.stringify({ content: '.claim', nonce: '0' });
const WORK_PAYLOAD = JSON.stringify({ content: 'Work' });
const HELP_PAYLOAD = JSON.stringify({ 
    content: '**Commands:**\n`.s` — snipes 2hr ago messages & images\n`.troll` — fake dox' 
});
const TROLL_PAYLOAD = JSON.stringify({ content: 'Fake dox initiated... 🎯' });

let ws = null;
let heartbeatInterval;
let isRunning = false;
let myUserId = null;
let httpsAgent = null;
let messageHistory = new Map(); // For snipe command

// Fast agent setup
if (PROXY_URL) {
    httpsAgent = new HttpsProxyAgent(PROXY_URL);
}

const axiosInstance = axios.create({
    httpsAgent: httpsAgent,
    httpAgent: httpsAgent,
    timeout: 2000,
    headers: {
        'Authorization': TOKEN,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.0.36',
        'Accept': '*/*'
    },
    validateStatus: () => true
});

// Ultra-fast POST with pre-warmed connection
async function fastSend(channelId, payload) {
    const start = process.hrtime.bigint();
    try {
        // Replace nonce with timestamp for uniqueness
        const finalPayload = payload.replace('"nonce":"0"', `"nonce":"${Date.now()}"`);
        
        const res = await axiosInstance.post(
            `https://discord.com/api/v9/channels/${channelId}/messages`,
            finalPayload,
            { timeout: 1500 }
        );
        
        const end = process.hrtime.bigint();
        const ms = Number(end - start) / 1000000;
        
        if (res.status === 200) {
            console.log(`[+] ⚡ ${ms.toFixed(2)}ms`);
            return true;
        } else if (res.status === 429) {
            const retry = parseInt(res.headers['retry-after']) || 50;
            setTimeout(() => fastSend(channelId, payload), retry);
        }
    } catch (e) {
        console.log(`[!] ${e.code}`);
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
                        intents: (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15)
                    }
                }));
            }
            
            if (op === 0) {
                // Store message history for snipe (keep last 100 per channel, 2hr ttl)
                if (t === 'MESSAGE_CREATE' && !d.author.bot) {
                    const twoHoursAgo = Date.now() - (2 * 60 * 60 * 1000);
                    if (d.timestamp > twoHoursAgo) {
                        if (!messageHistory.has(d.channel_id)) {
                            messageHistory.set(d.channel_id, []);
                        }
                        const history = messageHistory.get(d.channel_id);
                        history.push({
                            id: d.id,
                            content: d.content,
                            author: d.author.username,
                            attachments: d.attachments,
                            timestamp: d.timestamp
                        });
                        if (history.length > 100) history.shift();
                    }
                }
                
                if (t === 'READY') {
                    myUserId = d.user.id;
                    console.log(`[+] Ready as ${d.user.username}`);
                }
                
                // INSTANT CLAIM - zero delay
                if (t === 'CHANNEL_CREATE') {
                    if (d.parent_id === TARGET_PARENT_ID && d.type === 0) {
                        console.log(`[+] 🎫 ${d.name}`);
                        // Fire immediately without waiting
                        fastSend(d.id, CLAIM_PAYLOAD);
                    }
                }
                
                // Commands - only token owner
                if (t === 'MESSAGE_CREATE' && d.author.id === myUserId) {
                    const cmd = d.content.trim();
                    
                    if (cmd === '.test') {
                        fastSend(d.channel_id, WORK_PAYLOAD);
                    }
                    
                    if (cmd === '.help') {
                        fastSend(d.channel_id, HELP_PAYLOAD);
                    }
                    
                    if (cmd === '.s' || cmd === '.snipe') {
                        const history = messageHistory.get(d.channel_id) || [];
                        const twoHoursAgo = Date.now() - (2 * 60 * 60 * 1000);
                        const recent = history.filter(m => m.timestamp > twoHoursAgo).slice(-5);
                        
                        if (recent.length === 0) {
                            fastSend(d.channel_id, JSON.stringify({ content: 'Nothing to snipe (2hr)' }));
                        } else {
                            let snipeText = '**Sniped (2hr):**\n';
                            recent.reverse().forEach(m => {
                                snipeText += `\`${m.author}\`: ${m.content || '[embed/file]'}\n`;
                                if (m.attachments.length > 0) {
                                    m.attachments.forEach(a => {
                                        snipeText += `📎 ${a.url}\n`;
                                    });
                                }
                            });
                            fastSend(d.channel_id, JSON.stringify({ content: snipeText.slice(0, 2000) }));
                        }
                    }
                    
                    if (cmd === '.troll') {
                        fastSend(d.channel_id, TROLL_PAYLOAD);
                        setTimeout(() => {
                            fastSend(d.channel_id, JSON.stringify({ 
                                content: '```yaml\nName: Unknown\nIP: 127.0.0.1\nLocation: localhost\nISP: Your Mom```\n*fake dox complete*' 
                            }));
                        }, 500);
                    }
                }
            }
            
            if (op === 9) {
                console.log('[WS] Invalid');
            }
            
        } catch (e) {}
    });
    
    ws.on('close', (code) => {
        clearInterval(heartbeatInterval);
        isRunning = false;
        if (code !== 4004) setTimeout(connect, 1000);
    });
    
    ws.on('error', () => {});
}

(async () => {
    if (!TOKEN) {
        console.log('No token');
        process.exit(1);
    }
    console.log('=== CLAIMER v4.0 ⚡ ===');
    connect();
})();
