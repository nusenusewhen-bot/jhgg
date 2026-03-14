const WebSocket = require('ws');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');

// ENVIRONMENT CONFIG
const TOKEN = process.env.DISCORD_TOKEN?.trim();
const YOUR_USER_ID = process.env.USER_ID;
const TARGET_PARENT_ID = process.env.TARGET_PARENT_ID || '1420535190500933713';
const CLAIM_MESSAGE = '.claim';

// SINGLE BEST RESIDENTIAL PROXY (Update this with your working proxy)
const PROXY_URL = process.env.PROXY_URL || 'http://20.204.212.76:3128';

let ws = null;
let heartbeatInterval;
let reconnectAttempts = 0;
let isRunning = false;

const headers = {
    'Authorization': TOKEN,
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'X-Super-Properties': Buffer.from(JSON.stringify({
        "os":"Windows","browser":"Chrome","device":"",
        "system_locale":"en-US",
        "browser_user_agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "browser_version":"120.0.0.0","os_version":"10",
        "referrer":"","referring_domain":"",
        "search_engine":"google","referrer_current":"",
        "referring_domain_current":"","release_channel":"stable",
        "client_build_number":232614,"client_event_source":null
    })).toString('base64')
};

function createAxiosInstance() {
    const agent = new HttpsProxyAgent(PROXY_URL);
    return axios.create({
        httpsAgent: agent,
        httpAgent: agent,
        timeout: 20000,
        validateStatus: () => true
    });
}

async function validateToken() {
    console.log('[DIAG] Validating token...');
    const http = createAxiosInstance();
    
    try {
        const res = await http.get('https://discord.com/api/v9/users/@me', { 
            headers,
            timeout: 15000
        });
        
        if (res.status === 200) {
            console.log('[DIAG] ✅ Token VALID - User:', res.data.username, `(${res.data.id})`);
            console.log('[DIAG] Email verified:', res.data.verified);
            console.log('[DIAG] MFA enabled:', res.data.mfa_enabled);
            return true;
        } else if (res.status === 401) {
            console.log('[DIAG] ❌ Token INVALID (401) - Expired or wrong');
            return false;
        } else if (res.status === 403) {
            console.log('[DIAG] ❌ Account DISABLED (403)');
            return false;
        } else if (res.status === 429) {
            console.log('[DIAG] ⚠️ Rate limited (429)');
            return false;
        }
    } catch (err) {
        console.log('[DIAG] ❌ Connection error:', err.message);
        return false;
    }
}

function connect() {
    if (isRunning) return;
    isRunning = true;
    
    const agent = new HttpsProxyAgent(PROXY_URL);
    
    console.log(`[WS] Connecting via proxy...`);
    
    ws = new WebSocket('wss://gateway.discord.gg/?v=9&encoding=json', {
        agent: agent,
        headers: { 'User-Agent': headers['User-Agent'] },
        handshakeTimeout: 30000
    });
    
    ws.on('open', () => {
        console.log('[WS] ✅ Gateway connected');
        reconnectAttempts = 0;
    });
    
    ws.on('message', async (data) => {
        try {
            const payload = JSON.parse(data);
            const { op, d, s, t } = payload;
            
            if (op === 10) {
                const { heartbeat_interval } = d;
                heartbeatInterval = setInterval(() => {
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ op: 1, d: s }));
                    }
                }, heartbeat_interval);
                
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
                        compress: false,
                        intents: (1 << 0) | (1 << 9)
                    }
                }));
            }
            
            if (op === 0) {
                if (t === 'CHANNEL_CREATE' && d.type === 0 && d.parent_id === TARGET_PARENT_ID) {
                    console.log(`[+] 🎫 TICKET: ${d.name} (${d.id})`);
                    await claimTicket(d.id);
                }
                
                if (t === 'MESSAGE_CREATE' && d.author.id === YOUR_USER_ID) {
                    if (d.content === '.test') {
                        await sendMessage(d.channel_id, 'Work');
                    }
                }
                
                if (t === 'READY') {
                    console.log(`[+] ✅ READY as ${d.user.username}#${d.user.discriminator || '0'}`);
                    console.log(`[+] Guilds: ${d.guilds.length}`);
                    console.log(`[+] Proxy: ${PROXY_URL}`);
                }
                
                if (t === 'RESUMED') {
                    console.log('[+] Session resumed');
                }
            }
            
            if (op === 7) {
                console.log('[WS] Reconnect requested');
                ws.close();
            }
            
            if (op === 9) {
                console.log('[WS] Session invalid');
                ws.close();
            }
        } catch (e) {
            console.log('[WS] Parse error:', e.message);
        }
    });
    
    ws.on('close', (code, reason) => {
        console.log(`[WS] Closed: ${code} ${reason}`);
        clearInterval(heartbeatInterval);
        isRunning = false;
        
        if (code === 4004) {
            console.log('[FATAL] ❌ Authentication failed - token invalid');
            process.exit(1);
        }
        
        const delay = Math.min(30000, 5000 * (reconnectAttempts + 1));
        reconnectAttempts++;
        console.log(`[WS] Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
        setTimeout(connect, delay);
    });
    
    ws.on('error', (err) => {
        console.log('[WS] Error:', err.message);
    });
}

async function claimTicket(channelId) {
    const http = createAxiosInstance();
    const start = Date.now();
    
    try {
        const res = await http.post(
            `https://discord.com/api/v9/channels/${channelId}/messages`,
            { content: CLAIM_MESSAGE },
            { headers }
        );
        
        const latency = Date.now() - start;
        
        if (res.status === 200) {
            console.log(`[+] ✅ CLAIMED in ${latency}ms`);
        } else if (res.status === 429) {
            const retry = res.headers['retry-after'] || 5000;
            console.log(`[!] Rate limited, retrying in ${retry}ms`);
            setTimeout(() => claimTicket(channelId), retry);
        } else if (res.status === 403) {
            console.log(`[!] No permission`);
        } else if (res.status === 401) {
            console.log(`[!] Token invalid`);
        } else {
            console.log(`[!] Status: ${res.status}`);
        }
    } catch (err) {
        console.log(`[!] Error: ${err.message}`);
    }
}

async function sendMessage(channelId, content) {
    const http = createAxiosInstance();
    try {
        await http.post(
            `https://discord.com/api/v9/channels/${channelId}/messages`,
            { content },
            { headers }
        );
        console.log(`[CMD] ✅ Sent: "${content}"`);
    } catch (err) {
        console.log(`[CMD] ❌ Failed: ${err.response?.status || err.message}`);
    }
}

// MAIN
(async () => {
    console.log('=== DISCORD CLAIMER v2.0 ===');
    console.log('Target category:', TARGET_PARENT_ID);
    console.log('User ID:', YOUR_USER_ID);
    console.log('Token:', TOKEN ? '✅ Present' : '❌ MISSING');
    
    if (!TOKEN || !YOUR_USER_ID) {
        console.log('[FATAL] ❌ Missing DISCORD_TOKEN or USER_ID env vars');
        process.exit(1);
    }
    
    const valid = await validateToken();
    if (!valid) {
        console.log('[FATAL] ❌ Token validation failed');
        process.exit(1);
    }
    
    console.log('[INIT] Starting...');
    connect();
})();
