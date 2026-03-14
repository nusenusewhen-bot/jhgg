const WebSocket = require('ws');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');

const TOKEN = process.env.DISCORD_TOKEN?.trim();
const TARGET_PARENT_ID = process.env.TARGET_PARENT_ID || '1420535190500933713';
const PROXY_URL = process.env.PROXY_URL;

let ws = null;
let heartbeatInterval;
let reconnectAttempts = 0;
let isRunning = false;
let myUserId = null; // Store the logged-in user's ID

function getHeaders() {
    return {
        'Authorization': TOKEN,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': '*/*',
        'X-Super-Properties': Buffer.from(JSON.stringify({
            "os":"Windows","browser":"Chrome","device":"",
            "system_locale":"en-US",
            "browser_user_agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "browser_version":"120.0.0.0","os_version":"10",
            "release_channel":"stable","client_build_number":242635
        })).toString('base64')
    };
}

async function sendMessage(channelId, content) {
    try {
        const config = {
            method: 'POST',
            url: `https://discord.com/api/v9/channels/${channelId}/messages`,
            headers: getHeaders(),
            data: { content },
            timeout: 10000
        };
        
        if (PROXY_URL) {
            config.httpsAgent = new HttpsProxyAgent(PROXY_URL);
        }
        
        const res = await axios(config);
        if (res.status === 200) {
            console.log('[+] Sent:', content);
            return true;
        }
    } catch (err) {
        console.log('[!] Failed:', err.response?.status);
        return false;
    }
}

function connect() {
    if (isRunning) return;
    isRunning = true;
    
    const wsOptions = {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        handshakeTimeout: 30000
    };
    
    if (PROXY_URL) {
        wsOptions.agent = new HttpsProxyAgent(PROXY_URL);
    }
    
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
                
                ws.send(JSON.stringify({
                    op: 2,
                    d: {
                        token: TOKEN,
                        properties: { os: "Windows", browser: "Chrome", device: "" },
                        presence: { status: "online", since: 0, activities: [], afk: false },
                        intents: (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15) // Added DM intents
                    }
                }));
            }
            
            if (op === 0) {
                // READY event - store our user ID
                if (t === 'READY') {
                    myUserId = d.user.id;
                    console.log('[+] Logged in as:', d.user.username);
                    console.log('[+] My ID:', myUserId);
                }
                
                // MESSAGE_CREATE - handle commands
                if (t === 'MESSAGE_CREATE' && myUserId) {
                    // Only respond to messages from the logged-in account
                    if (d.author.id === myUserId) {
                        const content = d.content.trim();
                        
                        console.log(`[MSG] Me: "${content}" in ${d.channel_id} (DM: ${!d.guild_id})`);
                        
                        // .test command - works everywhere including DMs
                        if (content === '.test') {
                            console.log('[CMD] Executing .test');
                            sendMessage(d.channel_id, 'Work');
                        }
                        
                        // .claim command for tickets
                        if (content === '.claim') {
                            console.log('[CMD] Manual claim');
                            sendMessage(d.channel_id, '.claim');
                        }
                    }
                }
                
                // CHANNEL_CREATE - auto-claim tickets
                if (t === 'CHANNEL_CREATE') {
                    if (d.parent_id === TARGET_PARENT_ID) {
                        console.log('[+] Ticket created:', d.name);
                        setTimeout(() => sendMessage(d.id, '.claim'), 500);
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
        console.log(`[WS] Closed: ${code}`);
        clearInterval(heartbeatInterval);
        isRunning = false;
        
        if (code === 4004) {
            console.log('[FATAL] Auth failed');
            process.exit(1);
        }
        
        reconnectAttempts++;
        setTimeout(connect, Math.min(30000, 5000 * reconnectAttempts));
    });
    
    ws.on('error', (err) => {
        console.log('[WS] Error:', err.message);
    });
}

(async () => {
    console.log('=== DISCORD CLAIMER ===');
    if (!TOKEN) {
        console.log('[FATAL] No token');
        process.exit(1);
    }
    
    connect();
})();
