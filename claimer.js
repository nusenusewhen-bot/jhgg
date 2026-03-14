const WebSocket = require('ws');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const http = require('http');
const https = require('https');

const TOKEN = process.env.DISCORD_TOKEN?.trim();
const TARGET_PARENT_ID = process.env.TARGET_PARENT_ID || '1420535190500933713';
const PROXY_URL = process.env.PROXY_URL;

let ws = null;
let heartbeatInterval;
let isRunning = false;
let myUserId = null;
let httpClient = null;
let claimQueue = [];
let isProcessing = false;

// Pre-warm connection pool
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 10 });
const httpsAgent = PROXY_URL 
    ? new HttpsProxyAgent(PROXY_URL)
    : new https.Agent({ keepAlive: true, maxSockets: 10 });

const headers = {
    'Authorization': TOKEN,
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': '*/*',
    'Accept-Encoding': 'gzip, deflate, br',
    'X-Super-Properties': Buffer.from(JSON.stringify({
        "os":"Windows","browser":"Chrome","device":"",
        "system_locale":"en-US",
        "browser_user_agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "browser_version":"120.0.0.0","os_version":"10",
        "release_channel":"stable","client_build_number":242635
    })).toString('base64')
};

// Initialize axios instance with keep-alive
function initHttpClient() {
    httpClient = axios.create({
        httpAgent: httpAgent,
        httpsAgent: httpsAgent,
        timeout: 5000,
        headers: headers,
        validateStatus: () => true
    });
}

async function sendMessage(channelId, content) {
    const start = Date.now();
    try {
        const res = await httpClient.post(
            `https://discord.com/api/v9/channels/${channelId}/messages`,
            { content, nonce: Date.now().toString() },
            { timeout: 3000 }
        );
        const latency = Date.now() - start;
        
        if (res.status === 200) {
            console.log(`[+] ✅ ${content} in ${latency}ms`);
            return true;
        } else if (res.status === 429) {
            const retry = res.headers['retry-after'] || 100;
            console.log(`[!] 429, retry ${retry}ms`);
            setTimeout(() => sendMessage(channelId, content), retry);
        }
    } catch (err) {
        console.log(`[!] Error: ${err.code}`);
    }
    return false;
}

// Process claim queue immediately
function processQueue() {
    if (isProcessing || claimQueue.length === 0) return;
    isProcessing = true;
    
    const item = claimQueue.shift();
    sendMessage(item.channelId, '.claim').then(() => {
        isProcessing = false;
        if (claimQueue.length > 0) processQueue();
    });
}

function queueClaim(channelId, channelName) {
    console.log(`[+] 🎫 ${channelName} detected`);
    claimQueue.push({ channelId, ts: Date.now() });
    processQueue();
}

function connect() {
    if (isRunning) return;
    isRunning = true;
    
    const wsOptions = {
        headers: { 
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Origin': 'https://discord.com'
        },
        handshakeTimeout: 30000,
        agent: httpsAgent
    };
    
    ws = new WebSocket('wss://gateway.discord.gg/?v=9&encoding=json', wsOptions);
    
    ws.on('open', () => {
        console.log('[WS] Connected');
    });
    
    ws.on('message', (data) => {
        try {
            const payload = JSON.parse(data.toString());
            const { op, d, s, t } = payload;
            
            if (op === 10) {
                heartbeatInterval = setInterval(() => {
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ op: 1, d: s }));
                    }
                }, d.heartbeat_interval);
                
                // Identify with minimal payload for speed
                ws.send(JSON.stringify({
                    op: 2,
                    d: {
                        token: TOKEN,
                        properties: { os: "Windows", browser: "Chrome", device: "" },
                        compress: false,
                        large_threshold: 50,
                        presence: { status: "online", since: 0, activities: [], afk: false },
                        intents: (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15)
                    }
                }));
            }
            
            if (op === 0) {
                if (t === 'READY') {
                    myUserId = d.user.id;
                    console.log(`[+] Ready as ${d.user.username}`);
                    console.log(`[+] Target: ${TARGET_PARENT_ID}`);
                }
                
                // CHANNEL_CREATE - instant claim
                if (t === 'CHANNEL_CREATE') {
                    if (d.parent_id === TARGET_PARENT_ID && d.type === 0) {
                        // Immediate claim without queue for max speed
                        console.log(`[+] ⚡ ${d.name}`);
                        sendMessage(d.id, '.claim');
                    }
                }
                
                // GUILD_CREATE - check for existing tickets in category
                if (t === 'GUILD_CREATE') {
                    if (d.channels) {
                        d.channels.forEach(ch => {
                            if (ch.parent_id === TARGET_PARENT_ID && ch.type === 0) {
                                console.log(`[+] Found existing: ${ch.name}`);
                            }
                        });
                    }
                }
                
                // Commands
                if (t === 'MESSAGE_CREATE' && d.author.id === myUserId) {
                    const content = d.content.trim();
                    
                    if (content === '.test') {
                        sendMessage(d.channel_id, 'Work');
                    }
                    
                    if (content === '.ping') {
                        const latency = Date.now() - d.timestamp;
                        sendMessage(d.channel_id, `Pong! ${latency}ms`);
                    }
                    
                    if (content === '.status') {
                        sendMessage(d.channel_id, `Queue: ${claimQueue.length} | Proxy: ${PROXY_URL ? 'ON' : 'OFF'}`);
                    }
                }
            }
            
            if (op === 7) {
                ws.close();
            }
            
            if (op === 9) {
                console.log('[WS] Invalid session');
            }
            
        } catch (e) {}
    });
    
    ws.on('close', (code) => {
        console.log(`[WS] Closed: ${code}`);
        clearInterval(heartbeatInterval);
        isRunning = false;
        
        if (code !== 4004) {
            setTimeout(connect, 1000);
        }
    });
    
    ws.on('error', () => {});
}

(async () => {
    if (!TOKEN) {
        console.log('[FATAL] No token');
        process.exit(1);
    }
    
    initHttpClient();
    console.log('=== DISCORD CLAIMER v3.0 ⚡ ===');
    console.log('[INIT] HTTP pool warmed up');
    connect();
})();
