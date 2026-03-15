const WebSocket = require('ws');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');

const TOKEN = process.env.DISCORD_TOKEN?.trim();
const TARGET_PARENT_ID = process.env.TARGET_PARENT_ID || '1420535190500933713';
const PROXY_URL = process.env.PROXY_URL;
const PREFIX = '$';

let ws = null;
let heartbeatInterval;
let isRunning = false;
let myUserId = null;
let httpsAgent = null;
let messageHistory = new Map();
let processedChannels = new Set();
let autoClaimEnabled = true;

// Updated super properties with realistic client build
const SUPER_PROPERTIES = {
    "os": "Windows",
    "browser": "Chrome",
    "device": "",
    "system_locale": "en-US",
    "browser_user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "browser_version": "120.0.0.0",
    "os_version": "10",
    "referrer": "",
    "referring_domain": "",
    "referrer_current": "",
    "referring_domain_current": "",
    "release_channel": "stable",
    "client_build_number": 242635,
    "client_event_source": null,
    "design_id": 0
};

// Client fingerprint - mimics real Discord web client
const CLIENT_FINGERPRINT = {
    "version": "v2",
    "visitorId": Array.from({length: 16}, () => Math.floor(Math.random() * 16).toString(16)).join(''),
    "components": {
        "fonts": ["Arial", "Times New Roman", "Helvetica"],
        "plugins": ["Chrome PDF Plugin", "Native Client"],
        "mimeTypes": ["application/pdf"],
        "screen": { "width": 1920, "height": 1080, "colorDepth": 24 },
        "timezone": "America/New_York",
        "sessionStorage": true,
        "localStorage": true,
        "indexedDb": true,
        "cpuClass": "unknown",
        "platform": "Win32",
        "doNotTrack": null,
        "canvas": "noise_" + Math.random().toString(36).substring(7),
        "webgl": "noise_" + Math.random().toString(36).substring(7),
        "webdriver": false,
        "language": "en-US",
        "touchSupport": { "maxTouchPoints": 0, "touchEvent": false, "touchStart": false }
    }
};

const HELP_TEXT = `**Commands:**
\`$test\` — Test response
\`$help\` — This menu
\`$s\` / \`$snipe\` — Snipe 2hr history
\`$troll\` — Fake dox
\`$stop\` — Disable auto-claim
\`$start\` — Enable auto-claim

_Status: ${autoClaimEnabled ? '🟢 ON' : '🔴 OFF'}_`;

if (PROXY_URL) {
    httpsAgent = new HttpsProxyAgent(PROXY_URL);
}

// Generate realistic headers
function getHeaders() {
    const timestamp = Date.now();
    return {
        'Authorization': TOKEN,
        'Content-Type': 'application/json',
        'User-Agent': SUPER_PROPERTIES.browser_user_agent,
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'X-Super-Properties': Buffer.from(JSON.stringify(SUPER_PROPERTIES)).toString('base64'),
        'X-Fingerprint': Buffer.from(JSON.stringify(CLIENT_FINGERPRINT)).toString('base64'),
        'X-Discord-Locale': 'en-US',
        'X-Discord-Timezone': 'America/New_York',
        'X-Debug-Options': 'bugReporterEnabled',
        'Origin': 'https://discord.com',
        'Referer': 'https://discord.com/channels/@me',
        'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'DNT': '1',
        'Connection': 'keep-alive',
        'X-Request-Id': `${timestamp}-${Math.random().toString(36).substring(2, 15)}`
    };
}

const axiosInstance = axios.create({
    httpsAgent: httpsAgent,
    httpAgent: httpsAgent,
    timeout: 5000,
    headers: getHeaders(),
    validateStatus: () => true
});

async function sendMessage(channelId, content, delay = 1000) {
    await new Promise(r => setTimeout(r, delay));
    
    try {
        // Refresh headers with new request ID for each call
        const headers = getHeaders();
        const res = await axiosInstance.post(
            `https://discord.com/api/v9/channels/${channelId}/messages`,
            { 
                content, 
                nonce: Date.now().toString(),
                tts: false,
                flags: 0
            },
            { 
                timeout: 3000,
                headers: headers // Fresh headers per request
            }
        );
        
        if (res.status === 200) {
            console.log(`[+] Sent to ${channelId}`);
            return true;
        } else if (res.status === 429) {
            const retry = parseInt(res.headers['retry-after']) || 100;
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
            'User-Agent': SUPER_PROPERTIES.browser_user_agent,
            'Origin': 'https://discord.com',
            'X-Super-Properties': Buffer.from(JSON.stringify(SUPER_PROPERTIES)).toString('base64'),
            'X-Fingerprint': Buffer.from(JSON.stringify(CLIENT_FINGERPRINT)).toString('base64')
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
                        capabilities: 30717,
                        properties: SUPER_PROPERTIES,
                        presence: { 
                            status: "online", 
                            since: 0, 
                            activities: [{
                                name: "Visual Studio Code",
                                type: 0,
                                application_id: "383226320970055681",
                                state: "Editing claimer.js",
                                details: "Workspace: discord-claimer",
                                timestamps: { start: Date.now() }
                            }], 
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
                        intents: (1 << 0) | (1 << 1) | (1 << 9) | (1 << 12) | (1 << 15)
                    }
                }));
            }
            
            if (op === 0) {
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
                
                if (t === 'MESSAGE_CREATE' && d.author.bot && autoClaimEnabled) {
                    if (d.channel_id && !processedChannels.has(d.channel_id)) {
                        setTimeout(() => {
                            console.log(`[+] 🤖 Claiming ${d.channel_id}`);
                            sendMessage(d.channel_id, '.claim');
                            processedChannels.add(d.channel_id);
                            setTimeout(() => processedChannels.delete(d.channel_id), 30000);
                        }, 200);
                    }
                }
                
                if (t === 'READY') {
                    myUserId = d.user.id;
                    console.log(`[+] Ready as ${d.user.username}`);
                }
                
                if (t === 'MESSAGE_CREATE' && d.author.id === myUserId) {
                    const cmd = d.content.trim().toLowerCase();
                    const channelId = d.channel_id;
                    
                    if (!cmd.startsWith(PREFIX)) return;
                    
                    const baseCmd = cmd.substring(PREFIX.length).split(' ')[0];
                    const humanDelay = 1000 + Math.floor(Math.random() * 1000);
                    
                    switch(baseCmd) {
                        case 'test':
                            sendMessage(channelId, 'Work', humanDelay);
                            break;
                        case 'help':
                            sendMessage(channelId, HELP_TEXT, humanDelay);
                            break;
                        case 'stop':
                            autoClaimEnabled = false;
                            sendMessage(channelId, '🔴 Auto-claim disabled', humanDelay);
                            break;
                        case 'start':
                            autoClaimEnabled = true;
                            sendMessage(channelId, '🟢 Auto-claim enabled', humanDelay);
                            break;
                        case 's':
                        case 'snipe':
                            const history = messageHistory.get(channelId) || [];
                            const twoHoursAgo = Date.now() - (2 * 60 * 60 * 1000);
                            const recent = history.filter(m => m.timestamp > twoHoursAgo).slice(-10);
                            if (recent.length === 0) {
                                sendMessage(channelId, '🔍 Nothing to snipe', humanDelay);
                            } else {
                                let text = '**🔍 Sniped:**\n';
                                recent.reverse().forEach((m, i) => {
                                    text += `${i+1}. \`${m.author}\`: ${m.content || '[file]'}\n`;
                                    if (m.attachments.length) m.attachments.forEach(a => text += `📎 ${a.url}\n`);
                                });
                                sendMessage(channelId, text.slice(0, 1990), humanDelay);
                            }
                            break;
                        case 'troll':
                            sendMessage(channelId, '🎯 **Initiating...**', humanDelay);
                            setTimeout(() => sendMessage(channelId, '```yaml\nTarget: Unknown\nIP: 127.0.0.1\n```\n*prank*', 1000), humanDelay + 800);
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
    console.log('=== CLAIMER v8.0 (FP) ===');
    connect();
})();
