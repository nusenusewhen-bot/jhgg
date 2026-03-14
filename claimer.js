const WebSocket = require('ws');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');

const TOKEN = process.env.DISCORD_TOKEN?.trim();
const YOUR_USER_ID = process.env.USER_ID;
const TARGET_PARENT_ID = process.env.TARGET_PARENT_ID || '1420535190500933713';

// MUST BE RESIDENTIAL PROXY - datacenter IPs get blocked
const PROXY_URL = process.env.PROXY_URL;

let ws = null;
let heartbeatInterval;
let reconnectAttempts = 0;
let isRunning = false;

// Discord API headers
function getHeaders() {
    return {
        'Authorization': TOKEN,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'X-Super-Properties': Buffer.from(JSON.stringify({
            "os":"Windows","browser":"Chrome","device":"",
            "system_locale":"en-US",
            "browser_user_agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "browser_version":"120.0.0.0","os_version":"10",
            "referrer":"","referring_domain":"",
            "search_engine":"google","referrer_current":"",
            "referring_domain_current":"","release_channel":"stable",
            "client_build_number":242635,"client_event_source":null,
            "design_id":0
        })).toString('base64'),
        'X-Discord-Locale': 'en-US',
        'X-Discord-Timezone': 'America/New_York',
        'Origin': 'https://discord.com',
        'Referer': 'https://discord.com/channels/@me'
    };
}

async function testConnection() {
    console.log('[TEST] Testing HTTP connection...');
    
    const config = {
        method: 'GET',
        url: 'https://discord.com/api/v9/users/@me',
        headers: getHeaders(),
        timeout: 15000
    };
    
    if (PROXY_URL) {
        console.log('[TEST] Using proxy:', PROXY_URL);
        const agent = new HttpsProxyAgent(PROXY_URL);
        config.httpsAgent = agent;
        config.httpAgent = agent;
    } else {
        console.log('[TEST] No proxy, direct connection');
    }
    
    try {
        const res = await axios(config);
        
        if (res.status === 200) {
            console.log('[TEST] ✅ HTTP Success - User:', res.data.username);
            console.log('[TEST] ID:', res.data.id);
            console.log('[TEST] Verified:', res.data.verified);
            return true;
        }
    } catch (err) {
        console.log('[TEST] ❌ HTTP Failed:', err.response?.status, err.response?.statusText);
        console.log('[TEST] Error:', err.message);
        if (err.response?.data) {
            console.log('[TEST] Response:', err.response.data);
        }
        return false;
    }
}

function connectGateway() {
    if (isRunning) return;
    isRunning = true;
    
    console.log('[WS] Connecting to wss://gateway.discord.gg...');
    
    const wsOptions = {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Origin': 'https://discord.com'
        },
        handshakeTimeout: 30000
    };
    
    if (PROXY_URL) {
        wsOptions.agent = new HttpsProxyAgent(PROXY_URL);
    }
    
    ws = new WebSocket('wss://gateway.discord.gg/?v=9&encoding=json', wsOptions);
    
    let identified = false;
    
    ws.on('open', () => {
        console.log('[WS] ✅ Socket opened');
    });
    
    ws.on('message', (data) => {
        try {
            const payload = JSON.parse(data.toString());
            const { op, d, s, t } = payload;
            
            console.log(`[WS] Op: ${op}, Event: ${t || 'none'}, Seq: ${s || 'none'}`);
            
            // Hello
            if (op === 10) {
                console.log('[WS] Received Hello, heartbeat interval:', d.heartbeat_interval);
                
                // Start heartbeat
                heartbeatInterval = setInterval(() => {
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ op: 1, d: s }));
                        console.log('[WS] Heartbeat sent');
                    }
                }, d.heartbeat_interval);
                
                // Send Identify
                console.log('[WS] Sending Identify...');
                ws.send(JSON.stringify({
                    op: 2,
                    d: {
                        token: TOKEN,
                        capabilities: 30717,
                        properties: {
                            os: "Windows",
                            browser: "Chrome",
                            device: "",
                            system_locale: "en-US",
                            browser_user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.0.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                            browser_version: "120.0.0.0",
                            os_version: "10",
                            referrer: "",
                            referring_domain: "",
                            referrer_current: "",
                            referring_domain_current: "",
                            release_channel: "stable",
                            client_build_number: 242635,
                            client_event_source: null,
                            design_id: 0
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
                        intents: (1 << 0) | (1 << 9) | (1 << 15)
                    }
                }));
            }
            
            // Heartbeat ACK
            if (op === 11) {
                console.log('[WS] Heartbeat ACK');
            }
            
            // Dispatch
            if (op === 0) {
                if (t === 'READY') {
                    identified = true;
                    console.log('\n[+] ✅ LOGIN SUCCESSFUL');
                    console.log('[+] User:', d.user.username + '#' + d.user.discriminator);
                    console.log('[+] ID:', d.user.id);
                    console.log('[+] Email:', d.user.email);
                    console.log('[+] Verified:', d.user.verified);
                    console.log('[+] Guilds:', d.guilds.length);
                    console.log('[+] Session:', d.session_id);
                    
                    // Update presence
                    setTimeout(() => {
                        ws.send(JSON.stringify({
                            op: 3,
                            d: {
                                status: "online",
                                since: 0,
                                activities: [{
                                    name: "Claimer v2.0",
                                    type: 0
                                }],
                                afk: false
                            }
                        }));
                    }, 1000);
                }
                
                if (t === 'MESSAGE_CREATE') {
                    if (d.author.id === YOUR_USER_ID && d.content === '.test') {
                        console.log('[CMD] .test detected, sending Work...');
                        sendMessage(d.channel_id, 'Work');
                    }
                }
                
                if (t === 'CHANNEL_CREATE') {
                    if (d.parent_id === TARGET_PARENT_ID) {
                        console.log('[+] New ticket:', d.name);
                        sendMessage(d.id, '.claim');
                    }
                }
            }
            
            // Reconnect
            if (op === 7) {
                console.log('[WS] Reconnect requested');
                ws.close();
            }
            
            // Invalid Session
            if (op === 9) {
                console.log('[WS] Invalid session');
                identified = false;
            }
            
        } catch (e) {
            console.log('[WS] Error parsing message:', e.message);
        }
    });
    
    ws.on('close', (code, reason) => {
        console.log(`[WS] ❌ Closed: ${code} ${reason || ''}`);
        clearInterval(heartbeatInterval);
        isRunning = false;
        
        if (code === 4004) {
            console.log('[FATAL] Authentication failed - wrong token');
            process.exit(1);
        }
        if (code === 4011) {
            console.log('[FATAL] Sharding required');
            process.exit(1);
        }
        if (code === 4013) {
            console.log('[FATAL] Invalid intents');
            process.exit(1);
        }
        if (code === 4014) {
            console.log('[FATAL] Disallowed intents');
            process.exit(1);
        }
        
        reconnectAttempts++;
        const delay = Math.min(30000, 5000 * reconnectAttempts);
        console.log(`[WS] Reconnecting in ${delay}ms...`);
        setTimeout(connectGateway, delay);
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
            const agent = new HttpsProxyAgent(PROXY_URL);
            config.httpsAgent = agent;
        }
        
        const res = await axios(config);
        if (res.status === 200) {
            console.log('[+] Sent:', content);
        }
    } catch (err) {
        console.log('[!] Send failed:', err.response?.status, err.message);
    }
}

// MAIN
(async () => {
    console.log('=== DISCORD CLAIMER v2.0 ===\n');
    
    if (!TOKEN) {
        console.log('[FATAL] No DISCORD_TOKEN provided');
        process.exit(1);
    }
    
    console.log('Token prefix:', TOKEN.substring(0, 20) + '...');
    console.log('User ID:', YOUR_USER_ID);
    console.log('Target Category:', TARGET_PARENT_ID);
    console.log('Proxy:', PROXY_URL || 'None (direct)\n');
    
    // Test HTTP first
    const httpWorks = await testConnection();
    if (!httpWorks) {
        console.log('\n[FATAL] HTTP test failed. Possible issues:');
        console.log('1. Token is invalid/expired');
        console.log('2. IP is banned (need residential proxy)');
        console.log('3. Discord is blocking the request');
        process.exit(1);
    }
    
    console.log('\n[INIT] Starting Gateway connection...');
    connectGateway();
})();
