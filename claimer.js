const WebSocket = require('ws');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');

const TOKEN = process.env.DISCORD_TOKEN?.trim();
const PROXY_URL = process.env.PROXY_URL;
const PREFIX = '$';

let ws = null;
let heartbeatInterval;
let isRunning = false;
let myUserId = null;
let httpsAgent = null;
let messageHistory = new Map();

const HELP_TEXT = `**Commands:**
\`$test\` — Test response
\`$help\` — This menu
\`$s\` / \`$snipe\` — Snipe 2hr history
\`$troll\` — Fake dox`;

if (PROXY_URL) {
    httpsAgent = new HttpsProxyAgent(PROXY_URL);
}

const axiosInstance = axios.create({
    httpsAgent: httpsAgent,
    httpAgent: httpsAgent,
    timeout: 5000,
    headers: {
        'Authorization': TOKEN,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'X-Super-Properties': Buffer.from(JSON.stringify({
            "os":"Windows","browser":"Chrome","device":"",
            "system_locale":"en-US",
            "browser_user_agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "browser_version":"120.0.0.0","os_version":"10",
            "release_channel":"stable","client_build_number":242635
        })).toString('base64')
    },
    validateStatus: () => true
});

async function sendMessage(channelId, content, delay = 5000) {
    await new Promise(r => setTimeout(r, delay));
    
    try {
        const res = await axiosInstance.post(
            `https://discord.com/api/v9/channels/${channelId}/messages`,
            { content, nonce: Date.now().toString() },
            { timeout: 3000 }
        );
        
        if (res.status === 200) {
            console.log(`[+] Sent: ${content.slice(0, 20)}...`);
            return true;
        } else if (res.status === 429) {
            const retry = parseInt(res.headers['retry-after']) || 5000;
            console.log(`[!] Rate limited, waiting ${retry}ms`);
            setTimeout(() => sendMessage(channelId, content, 0), retry);
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
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept-Encoding': 'gzip, deflate, br'
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
                        properties: { 
                            os: "Windows", 
                            browser: "Chrome", 
                            device: "" 
                        },
                        presence: { 
                            status: "online", 
                            since: 0, 
                            activities: [], 
                            afk: false 
                        },
                        intents: (1 << 0) | (1 << 1) | (1 << 9) | (1 << 12)
                    }
                }));
            }
            
            if (op === 0) {
                // Store messages for snipe only
                if (t === 'MESSAGE_CREATE' && d.author.id !== myUserId && !d.author.bot) {
                    if (!messageHistory.has(d.channel_id)) {
                        messageHistory.set(d.channel_id, []);
                    }
                    const history = messageHistory.get(d.channel_id);
                    history.push({
                        content: d.content,
                        author: d.author.username,
                        authorId: d.author.id,
                        attachments: d.attachments || [],
                        timestamp: Date.now()
                    });
                    if (history.length > 30) history.shift();
                }
                
                if (t === 'READY') {
                    myUserId = d.user.id;
                    console.log(`[+] Ready as ${d.user.username}`);
                    console.log(`[+] ID: ${myUserId}`);
                }
                
                // Commands - only owner, 5 second delay
                if (t === 'MESSAGE_CREATE' && d.author.id === myUserId) {
                    const cmd = d.content.trim();
                    const channelId = d.channel_id;
                    
                    if (!cmd.startsWith(PREFIX)) return;
                    
                    const baseCmd = cmd.slice(PREFIX.length).toLowerCase().split(' ')[0];
                    
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
                            const recent = history.filter(m => m.timestamp > twoHoursAgo).slice(-5);
                            
                            if (recent.length === 0) {
                                sendMessage(channelId, '🔍 Nothing to snipe');
                            } else {
                                let text = '**🔍 Sniped:**\n';
                                recent.reverse().forEach((m, i) => {
                                    text += `${i+1}. \`${m.author}\`: ${m.content?.slice(0, 50) || '[file]'}\n`;
                                });
                                sendMessage(channelId, text.slice(0, 1990));
                            }
                            break;
                            
                        case 'troll':
                            sendMessage(channelId, '🎯 Initiating...');
                            setTimeout(() => {
                                sendMessage(channelId, '```yaml\nTarget: Unknown\nIP: 127.0.0.1\n```\n*prank*', 5000);
                            }, 5000);
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
        if (code !== 4004) setTimeout(connect, 10000);
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
    console.log('=== SIMPLE BOT v1.0 ===');
    console.log('[INIT] 5s delay on all responses');
    connect();
})();
