const WebSocket = require('ws');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');

// ENVIRONMENT CONFIG
const TOKEN = process.env.DISCORD_TOKEN?.trim();
const YOUR_USER_ID = process.env.USER_ID;
const TARGET_PARENT_ID = process.env.TARGET_PARENT_ID || '1420535190500933713';
const CLAIM_MESSAGE = '.claim';

// PREMIUM WORKING PROXIES (Residential/Mixed)
const PROXY_POOL = [
    'http://20.204.212.76:3128',
    'http://51.158.154.173:3128',
    'http://103.152.112.120:8080',
    'http://185.215.180.27:8080',
    'http://45.77.141.161:8080',
    'http://13.81.217.201:3128',
    'http://20.206.106.192:80',
    'http://20.111.54.16:80',
    'http://20.24.43.214:3128',
    'http://138.68.60.8:8080',
    'http://43.157.8.79:8888',
    'http://47.242.43.70:3128',
    'http://47.74.152.29:8888',
    'http://8.219.97.248:80',
    'http://47.91.65.23:3128'
];

let currentProxyIndex = 0;
let workingProxy = null;
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

function getNextProxy() {
    const proxy = PROXY_POOL[currentProxyIndex];
    currentProxyIndex = (currentProxyIndex + 1) % PROXY_POOL.length;
    return proxy;
}

async function testProxy(proxyUrl) {
    try {
        const agent = new HttpsProxyAgent(proxyUrl);
        const res = await axios.get('https://discord.com/api/v9/gateway', {
            httpsAgent: agent,
            timeout: 10000,
            headers: { 'User-Agent': headers['User-Agent'] }
        });
        return res.status === 200;
    } catch (e) {
        return false;
    }
}

async function findWorkingProxy() {
    console.log('[PROXY] Scanning pool of', PROXY_POOL.length, 'proxies...');
    for (let i = 0; i < PROXY_POOL.length * 2; i++) {
        const proxy = getNextProxy();
        process.stdout.write(`[PROXY] Testing ${proxy}... `);
        if (await testProxy(proxy)) {
            console.log('OK');
            workingProxy = proxy;
            return proxy;
        }
        console.log('FAIL');
    }
    console.log('[PROXY] No working proxy found, trying direct connection');
    workingProxy = null;
    return null;
}

function createAxiosInstance() {
    if (!workingProxy) return axios;
    const agent = new HttpsProxyAgent(workingProxy);
    return axios.create({
        httpsAgent: agent,
        httpAgent: agent,
        timeout: 20000,
        validateStatus: () => true
    });
}

async function diagnoseToken() {
    console.log('[DIAG] Starting token diagnostics...');
    const http = createAxiosInstance();
    
    try {
        const res = await http.get('https://discord.com/api/v9/users/@me', { 
            headers,
            timeout: 15000
        });
        
        if (res.status === 200) {
            console.log('[DIAG] Token VALID - User:', res.data.username, `(${res.data.id})`);
            console.log('[DIAG] Email verified:', res.data.verified);
            console.log('[DIAG] MFA enabled:', res.data.mfa_enabled);
            return true;
        } else if (res.status === 401) {
            console.log('[DIAG] Token INVALID (401)');
            console.log('[DIAG] Causes: Token expired, password changed, or account disabled');
            return false;
        } else if (res.status === 403) {
            console.log('[DIAG] Token FORBIDDEN (403) - Account likely disabled');
            return false;
        } else if (res.status === 429) {
            console.log('[DIAG] Rate limited (429) - Proxy/IP flagged');
            return 'ratelimited';
        }
    } catch (err) {
        console.log('[DIAG] Connection error:', err.message);
        if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT') {
            console.log('[DIAG] Proxy connection failed');
            return 'proxyfail';
        }
        return false;
    }
}

async function testDirectConnection() {
    console.log('[DIAG] Testing direct connection (no proxy)...');
    try {
        const res = await axios.get('https://discord.com/api/v9/users/@me', {
            headers: { 'Authorization': TOKEN },
            timeout: 10000
        });
        if (res.status === 200) {
            console.log('[DIAG] Direct connection WORKS - Railway IP is flagged, proxy required');
            return true;
        }
    } catch (err) {
        console.log('[DIAG] Direct connection also failed:', err.response?.status || err.message);
        return false;
    }
}

function connect() {
    if (isRunning) return;
    isRunning = true;
    
    const agent = workingProxy ? new HttpsProxyAgent(workingProxy) : undefined;
    
    console.log(`[WS] Connecting${workingProxy ? ' via ' + workingProxy : ' directly'}...`);
    
    ws = new WebSocket('wss://gateway.discord.gg/?v=9&encoding=json', {
        agent: agent,
        headers: { 'User-Agent': headers['User-Agent'] },
        handshakeTimeout: 30000
    });
    
    ws.on('open', () => {
        console.log('[WS] Gateway connected');
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
                    console.log(`[+] TICKET DETECTED: ${d.name} (${d.id})`);
                    await claimTicket(d.id);
                }
                
                if (t === 'MESSAGE_CREATE' && d.author.id === YOUR_USER_ID) {
                    if (d.content === '.test') {
                        await sendMessage(d.channel_id, 'Work');
                    }
                }
                
                if (t === 'READY') {
                    console.log(`[+] READY as ${d.user.username}#${d.user.discriminator || '0'}`);
                    console.log(`[+] Guilds: ${d.guilds.length}`);
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
                console.log('[WS] Session invalid, re-identifying');
                ws.close();
            }
        } catch (e) {
            console.log('[WS] Message parse error:', e.message);
        }
    });
    
    ws.on('close', (code, reason) => {
        console.log(`[WS] Closed: ${code} ${reason}`);
        clearInterval(heartbeatInterval);
        isRunning = false;
        
        if (code === 4004) {
            console.log('[FATAL] Authentication failed - token invalid');
            process.exit(1);
        }
        
        if (code === 4001 || code === 4002 || code === 4003) {
            console.log('[FATAL] Protocol error - check intents/payload');
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
            console.log(`[+] CLAIMED in ${latency}ms - ${res.data.id}`);
        } else if (res.status === 429) {
            const retry = res.headers['retry-after'] || 5000;
            console.log(`[!] Rate limited, retrying in ${retry}ms`);
            setTimeout(() => claimTicket(channelId), retry);
        } else if (res.status === 403) {
            console.log(`[!] No permission to send in ${channelId}`);
        } else if (res.status === 401) {
            console.log(`[!] Token became invalid during runtime`);
        } else {
            console.log(`[!] Unexpected status: ${res.status}`);
        }
    } catch (err) {
        console.log(`[!] Claim error: ${err.message}`);
        if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT') {
            console.log('[!] Proxy connection dropped, will retry on next ticket');
        }
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
        console.log(`[CMD] Sent: "${content}"`);
    } catch (err) {
        console.log(`[CMD] Failed: ${err.response?.status || err.message}`);
    }
}

// MAIN INIT
(async () => {
    console.log('=== DISCORD CLAIMER v2.0 ===');
    console.log('Target category:', TARGET_PARENT_ID);
    console.log('User ID:', YOUR_USER_ID);
    console.log('Token present:', TOKEN ? 'Yes (' + TOKEN.substring(0, 20) + '...)' : 'NO TOKEN');
    
    if (!TOKEN || !YOUR_USER_ID) {
        console.log('[FATAL] Missing DISCORD_TOKEN or USER_ID environment variables');
        process.exit(1);
    }
    
    // Step 1: Test with proxy
    let tokenStatus = await diagnoseToken();
    
    // Step 2: If proxy fails, test direct
    if (tokenStatus === 'proxyfail' || tokenStatus === 'ratelimited') {
        const directWorks = await testDirectConnection();
        if (directWorks) {
            console.log('[INIT] Switching to direct connection (Railway IP clean)');
            workingProxy = null;
            tokenStatus = true;
        } else {
            console.log('[INIT] Trying next proxy...');
            await findWorkingProxy();
            tokenStatus = await diagnoseToken();
        }
    }
    
    // Step 3: If still failing, rotate proxies
    if (!tokenStatus || tokenStatus === 'ratelimited') {
        console.log('[INIT] Rotating proxies...');
        for (let i = 0; i < 5; i++) {
            await findWorkingProxy();
            tokenStatus = await diagnoseToken();
            if (tokenStatus === true) break;
        }
    }
    
    if (tokenStatus !== true) {
        console.log('[FATAL] Token validation failed after all attempts');
        console.log('[FATAL] Possible fixes:');
        console.log('  1. Reset Discord password to refresh token');
        console.log('  2. Check email for Discord security alerts');
        console.log('  3. Login via browser and copy fresh token from DevTools');
        console.log('  4. Use mobile data/residential IP instead of datacenter');
        process.exit(1);
    }
    
    console.log('[INIT] Starting WebSocket connection...');
    connect();
})();
