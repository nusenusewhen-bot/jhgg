const WebSocket = require('ws');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');

let TOKEN = process.env.DISCORD_TOKEN?.trim();
const YOUR_USER_ID = process.env.USER_ID;
const TARGET_PARENT_ID = process.env.TARGET_PARENT_ID || '1420535190500933713';
const PROXY_URL = process.env.PROXY_URL;

// Fix common token issues
function sanitizeToken(token) {
    if (!token) return null;
    // Remove quotes if present
    token = token.replace(/^["']|["']$/g, '');
    // Remove any whitespace
    token = token.replace(/\s/g, '');
    // Ensure it starts with M, N, or O (Discord token prefixes)
    if (!/^[MNO]/.test(token)) {
        console.log('[WARN] Token doesnt start with M/N/O - might be wrong');
    }
    return token;
}

TOKEN = sanitizeToken(TOKEN);

let ws = null;
let heartbeatInterval;
let reconnectAttempts = 0;
let isRunning = false;

function getHeaders() {
    return {
        'Authorization': TOKEN,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Encoding': 'gzip, deflate, br',
        'X-Super-Properties': Buffer.from(JSON.stringify({
            "os":"Windows","browser":"Chrome","device":"",
            "system_locale":"en-US",
            "browser_user_agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "browser_version":"120.0.0.0","os_version":"10",
            "release_channel":"stable",
            "client_build_number":242635
        })).toString('base64')
    };
}

async function testToken() {
    console.log('[TEST] Token length:', TOKEN?.length);
    console.log('[TEST] Token starts with:', TOKEN?.substring(0, 10) + '...');
    console.log('[TEST] Token ends with:', '...' + TOKEN?.slice(-10));
    
    const config = {
        method: 'GET',
        url: 'https://discord.com/api/v9/users/@me',
        headers: getHeaders(),
        timeout: 15000,
        validateStatus: () => true // Don't throw on error status
    };
    
    if (PROXY_URL) {
        console.log('[TEST] Using proxy:', PROXY_URL);
        const agent = new HttpsProxyAgent(PROXY_URL);
        config.httpsAgent = agent;
    } else {
        console.log('[TEST] Direct connection (Railway IP)');
    }
    
    try {
        const res = await axios(config);
        
        console.log('[TEST] Status:', res.status);
        
        if (res.status === 200) {
            console.log('[TEST] ✅ SUCCESS');
            console.log('[TEST] Username:', res.data.username);
            console.log('[TEST] ID:', res.data.id);
            return true;
        } else if (res.status === 401) {
            console.log('[TEST] ❌ 401 Unauthorized - Token is invalid');
            console.log('[TEST] Response:', res.data);
            
            // Try to get more info
            if (res.data.message?.includes('Unauthorized')) {
                console.log('\n[!] Your token is definitely wrong. Ways to get correct token:');
                console.log('1. Open Discord in browser');
                console.log('2. Press F12 > Application tab');
                console.log('3. Local Storage > https://discord.com');
                console.log('4. Find "token" key - copy the value WITHOUT quotes');
                console.log('5. Or use Network tab, filter "science", click any request, check Request Headers for Authorization\n');
            }
            return false;
        } else if (res.status === 403) {
            console.log('[TEST] ❌ 403 Forbidden - Account banned');
            return false;
        } else if (res.status === 429) {
            console.log('[TEST] ❌ 429 Rate Limited - IP blocked');
            return false;
        }
    } catch (err) {
        console.log('[TEST] ❌ Request failed:', err.message);
        return false;
    }
}

function connect() {
    if (isRunning) return;
    isRunning = true;
    
    console.log('[WS] Connecting...');
    
    const wsOptions = {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
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
        const payload = JSON.parse(data);
        const { op, d, s, t } = payload;
        
        if (op === 10) {
            console.log('[WS] Got Hello');
            
            heartbeatInterval = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ op: 1, d: s }));
                }
            }, d.heartbeat_interval);
            
            console.log('[WS] Sending Identify...');
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
                    intents: (1 << 0) | (1 << 9) | (1 << 15)
                }
            }));
        }
        
        if (op === 0 && t === 'READY') {
            console.log('[+] ✅ LOGGED IN as', d.user.username);
            console.log('[+] ID:', d.user.id);
        }
        
        if (op === 0 && t === 'MESSAGE_CREATE') {
            if (d.author.id === YOUR_USER_ID && d.content === '.test') {
                sendMessage(d.channel_id, 'Work');
            }
        }
        
        if (op === 9) {
            console.log('[WS] Invalid session - token rejected');
        }
    });
    
    ws.on('close', (code) => {
        console.log(`[WS] Closed: ${code}`);
        clearInterval(heartbeatInterval);
        isRunning = false;
        
        if (code === 4004) {
            console.log('[FATAL] Authentication failed');
            process.exit(1);
        }
        
        setTimeout(connect, 5000);
    });
    
    ws.on('error', (err) => {
        console.log('[WS] Error:', err.message);
    });
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
        
        await axios(config);
        console.log('[+] Sent:', content);
    } catch (err) {
        console.log('[!] Send failed:', err.message);
    }
}

(async () => {
    console.log('=== DISCORD CLAIMER ===\n');
    
    if (!TOKEN) {
        console.log('[FATAL] No token');
        process.exit(1);
    }
    
    const valid = await testToken();
    if (!valid) {
        console.log('\n[!] Fix your token first');
        process.exit(1);
    }
    
    connect();
})();
