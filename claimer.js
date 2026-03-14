const WebSocket = require('ws');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');

const TOKEN = process.env.DISCORD_TOKEN?.trim();
const YOUR_USER_ID = process.env.USER_ID;
const TARGET_PARENT_ID = process.env.TARGET_PARENT_ID || '1420535190500933713';
const CLAIM_MESSAGE = '.claim';

const PROXY_URL = process.env.PROXY_URL || 'http://20.204.212.76:3128';

let ws = null;
let heartbeatInterval;
let reconnectAttempts = 0;
let isRunning = false;
let sessionId = null;
let lastSequence = null;

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

function createAgent() {
    return new HttpsProxyAgent(PROXY_URL);
}

function createAxiosInstance() {
    const agent = createAgent();
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
            return res.data;
        } else if (res.status === 401) {
            console.log('[DIAG] ❌ Token INVALID (401)');
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

async function sendMessage(channelId, content) {
    const http = createAxiosInstance();
    try {
        const res = await http.post(
            `https://discord.com/api/v9/channels/${channelId}/messages`,
            { content },
            { headers }
        );
        
        if (res.status === 200) {
            console.log(`[CMD] ✅ Sent: "${content}" in ${channelId}`);
            return res.data;
        } else {
            console.log(`[CMD] ❌ Failed: ${res.status}`);
            return null;
        }
    } catch (err) {
        console.log(`[CMD] ❌ Error: ${err.message}`);
        return null;
    }
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

function connect() {
    if (isRunning) return;
    isRunning = true;
    
    const agent = createAgent();
    
    console.log(`[WS] Connecting to Gateway...`);
    
    const wsUrl = sessionId && lastSequence 
        ? `wss://gateway.discord.gg/?v=9&encoding=json&session_id=${sessionId}&seq=${lastSequence}`
        : 'wss://gateway.discord.gg/?v=9&encoding=json';
    
    ws = new WebSocket(wsUrl, {
        agent: agent,
        headers: { 
            'User-Agent': headers['User-Agent'],
            'Origin': 'https://discord.com'
        },
        handshakeTimeout: 30000
    });
    
    ws.on('open', () => {
        console.log('[WS] ✅ Connected to Gateway');
        reconnectAttempts = 0;
    });
    
    ws.on('message', async (data) => {
        try {
            const payload = JSON.parse(data.toString());
            const { op, d, s, t } = payload;
            
            if (s) lastSequence = s;
            
            if (op === 10) {
                const { heartbeat_interval } = d;
                
                heartbeatInterval = setInterval(() => {
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ op: 1, d: lastSequence }));
                        console.log('[WS] Heartbeat sent');
                    }
                }, heartbeat_interval);
                
                if (sessionId) {
                    // Resume
                    ws.send(JSON.stringify({
                        op: 6,
                        d: {
                            token: TOKEN,
                            session_id: sessionId,
                            seq: lastSequence
                        }
                    }));
                    console.log('[WS] Resuming session...');
                } else {
                    // Identify
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
                            client_state: {
                                guild_versions: {},
                                highest_last_message_id: "0",
                                read_state_version: 0,
                                user_guild_settings_version: -1,
                                user_settings_version: -1,
                                private_channels_version: "0",
                                api_code_version: 0
                            },
                            intents: (1 << 0) | (1 << 9) | (1 << 15) // GUILDS, GUILD_MESSAGES, MESSAGE_CONTENT
                        }
                    }));
                    console.log('[WS] Identifying...');
                }
            }
            
            if (op === 0) {
                if (t === 'READY') {
                    sessionId = d.session_id;
                    console.log(`[+] ✅ READY as ${d.user.username}#${d.user.discriminator || '0'}`);
                    console.log(`[+] User ID: ${d.user.id}`);
                    console.log(`[+] Session ID: ${sessionId}`);
                    console.log(`[+] Guilds: ${d.guilds.length}`);
                    
                    // Set custom status
                    setTimeout(() => {
                        ws.send(JSON.stringify({
                            op: 3,
                            d: {
                                status: "online",
                                since: 0,
                                activities: [{
                                    name: "Custom Status",
                                    type: 4,
                                    state: "Claimer v2.0",
                                    emoji: { name: "🎫" }
                                }],
                                afk: false
                            }
                        }));
                    }, 5000);
                }
                
                if (t === 'MESSAGE_CREATE') {
                    // Log all messages for debugging
                    if (d.author.id === YOUR_USER_ID) {
                        console.log(`[MSG] You said: ${d.content} in ${d.channel_id}`);
                        
                        // Check for .test command
                        if (d.content.trim() === '.test') {
                            console.log('[CMD] Detected .test command');
                            await sendMessage(d.channel_id, 'Work');
                        }
                    }
                    
                    // Ticket detection
                    if (d.channel_id && d.type === 0) {
                        // Check if this is a new ticket in target category
                        // Note: MESSAGE_CREATE doesn't have parent_id, need to check channel
                    }
                }
                
                if (t === 'CHANNEL_CREATE') {
                    if (d.type === 0 && d.parent_id === TARGET_PARENT_ID) {
                        console.log(`[+] 🎫 NEW TICKET: ${d.name} (${d.id})`);
                        await claimTicket(d.id);
                    }
                }
                
                if (t === 'RESUMED') {
                    console.log('[+] Session resumed successfully');
                }
            }
            
            if (op === 7) {
                console.log('[WS] Reconnect requested');
                ws.close(4000, 'Reconnect requested');
            }
            
            if (op === 9) {
                console.log('[WS] Session invalid, clearing session data');
                sessionId = null;
                lastSequence = null;
                ws.close(4000, 'Invalid session');
            }
            
            if (op === 1) {
                ws.send(JSON.stringify({ op: 1, d: lastSequence }));
            }
        } catch (e) {
            console.log('[WS] Parse error:', e.message);
        }
    });
    
    ws.on('close', (code, reason) => {
        console.log(`[WS] Closed: ${code} ${reason || 'No reason'}`);
        clearInterval(heartbeatInterval);
        isRunning = false;
        
        if (code === 4004) {
            console.log('[FATAL] ❌ Authentication failed - token invalid');
            process.exit(1);
        }
        
        if (code === 4011) {
            console.log('[FATAL] ❌ Sharding required');
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

// MAIN
(async () => {
    console.log('=== DISCORD CLAIMER v2.0 ===');
    console.log('Target category:', TARGET_PARENT_ID);
    console.log('User ID:', YOUR_USER_ID);
    console.log('Token present:', TOKEN ? '✅ Yes' : '❌ No');
    console.log('Proxy:', PROXY_URL);
    
    if (!TOKEN || !YOUR_USER_ID) {
        console.log('[FATAL] ❌ Missing DISCORD_TOKEN or USER_ID env vars');
        process.exit(1);
    }
    
    const userData = await validateToken();
    if (!userData) {
        console.log('[FATAL] ❌ Token validation failed');
        process.exit(1);
    }
    
    if (userData.id !== YOUR_USER_ID) {
        console.log(`[WARN] Token user ID (${userData.id}) doesn't match env USER_ID (${YOUR_USER_ID})`);
    }
    
    console.log('[INIT] Starting WebSocket connection...');
    connect();
})();
