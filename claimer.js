const WebSocket = require('ws');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');

const TOKEN = process.env.DISCORD_TOKEN?.trim();
const TARGET_PARENT_ID = process.env.TARGET_PARENT_ID || '1420535190500933713';
const PROXY_URL = process.env.PROXY_URL;

let ws = null;
let heartbeatInterval;
let isRunning = false;
let myUserId = null;
let httpsAgent = null;
let messageHistory = new Map();

// Command definitions
const COMMANDS = {
    test: { desc: 'Test if bot is responding', response: 'Work' },
    help: { desc: 'Show this help menu' },
    s: { desc: 'Snipe deleted messages from last 2 hours' },
    snipe: { desc: 'Alias for .s' },
    troll: { desc: 'Fake dox troll' }
};

const HELP_TEXT = `**Commands Available:**
\`.test\` — ${COMMANDS.test.desc}
\`.help\` — ${COMMANDS.help.desc}
\`.s\` / \`.snipe\` — ${COMMANDS.s.desc}
\`.troll\` — ${COMMANDS.troll.desc}

_Only you can use these commands._`;

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

async function sendMessage(channelId, content) {
    const start = process.hrtime.bigint();
    try {
        const payload = typeof content === 'string' ? { content, nonce: Date.now().toString() } : { ...content, nonce: Date.now().toString() };
        
        const res = await axiosInstance.post(
            `https://discord.com/api/v9/channels/${channelId}/messages`,
            payload,
            { timeout: 1500 }
        );
        
        const end = process.hrtime.bigint();
        const ms = Number(end - start) / 1000000;
        
        if (res.status === 200) {
            console.log(`[+] ⚡ ${ms.toFixed(2)}ms to ${channelId}`);
            return true;
        } else if (res.status === 429) {
            const retry = parseInt(res.headers['retry-after']) || 50;
            setTimeout(() => sendMessage(channelId, content), retry);
        } else if (res.status === 403) {
            console.log(`[!] 403 - No permission in ${channelId}`);
        }
    } catch (e) {
        console.log(`[!] ${e.code || e.message}`);
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
                        intents: (1 << 0) | (1 << 1) | (1 << 9) | (1 << 12) | (1 << 15)
                    }
                }));
            }
            
            if (op === 0) {
                // Store messages for snipe (all channels including DMs)
                if (t === 'MESSAGE_CREATE' && d.author.id !== myUserId && !d.author.bot) {
                    const channelKey = d.channel_id;
                    if (!messageHistory.has(channelKey)) {
                        messageHistory.set(channelKey, []);
                    }
                    const history = messageHistory.get(channelKey);
                    history.push({
                        id: d.id,
                        content: d.content,
                        author: d.author.username,
                        authorId: d.author.id,
                        attachments: d.attachments || [],
                        embeds: d.embeds || [],
                        timestamp: Date.now()
                    });
                    // Keep only last 50, 2 hour TTL handled in retrieval
                    if (history.length > 50) history.shift();
                }
                
                // Handle deleted messages for snipe
                if (t === 'MESSAGE_DELETE') {
                    // Mark as deleted in history if needed
                }
                
                if (t === 'READY') {
                    myUserId = d.user.id;
                    console.log(`[+] Ready as ${d.user.username} (${d.user.id})`);
                    console.log(`[+] Commands restricted to: ${myUserId}`);
                }
                
                // INSTANT CLAIM
                if (t === 'CHANNEL_CREATE') {
                    if (d.parent_id === TARGET_PARENT_ID && d.type === 0) {
                        console.log(`[+] 🎫 Ticket: ${d.name}`);
                        sendMessage(d.id, '.claim');
                    }
                }
                
                // COMMANDS - STRICTLY OWNER ONLY (myUserId from token)
                if (t === 'MESSAGE_CREATE' && d.author.id === myUserId) {
                    const cmd = d.content.trim().toLowerCase();
                    const channelId = d.channel_id;
                    const isDM = !d.guild_id;
                    
                    console.log(`[CMD] "${cmd}" from ${d.author.username} in ${isDM ? 'DM' : 'server'} ${channelId}`);
                    
                    // Only process if starts with .
                    if (!cmd.startsWith('.')) return;
                    
                    const baseCmd = cmd.replace('.', '').split(' ')[0];
                    
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
                            const recent = history.filter(m => m.timestamp > twoHoursAgo).slice(-10);
                            
                            if (recent.length === 0) {
                                sendMessage(channelId, '🔍 Nothing to snipe (last 2 hours)');
                            } else {
                                let snipeText = '**🔍 Sniped Messages (2hr):**\n';
                                recent.reverse().forEach((m, i) => {
                                    snipeText += `\`${i+1}. ${m.author}\`: ${m.content || '[no text]'}\n`;
                                    if (m.attachments.length > 0) {
                                        m.attachments.forEach(a => {
                                            snipeText += `📎 ${a.url}\n`;
                                        });
                                    }
                                    if (m.embeds.length > 0) {
                                        snipeText += `📊 [embed]\n`;
                                    }
                                });
                                sendMessage(channelId, snipeText.slice(0, 1990));
                            }
                            break;
                            
                        case 'troll':
                            sendMessage(channelId, '🎯 **Fake Dox Initiated...**');
                            setTimeout(() => {
                                sendMessage(channelId, '```yaml\nUser: Unknown_Target\nIP: 192.168.1.1\nLocation: Localhost City\nISP: Mom\'s Basement WiFi\nVPN: Detected (NordVPN)\n```\n*This is a joke. Real doxing is illegal.*');
                            }, 800);
                            break;
                    }
                }
            }
            
            if (op === 9) {
                console.log('[WS] Invalid session');
            }
            
        } catch (e) {
            console.log('[WS] Parse error:', e.message);
        }
    });
    
    ws.on('close', (code) => {
        clearInterval(heartbeatInterval);
        isRunning = false;
        console.log(`[WS] Closed: ${code}`);
        if (code !== 4004) setTimeout(connect, 2000);
    });
    
    ws.on('error', (err) => {
        console.log('[WS] Error:', err.message);
    });
}

(async () => {
    if (!TOKEN) {
        console.log('[FATAL] No DISCORD_TOKEN');
        process.exit(1);
    }
    console.log('=== CLAIMER v5.0 ⚡ ===');
    console.log('[INIT] Starting...');
    connect();
})();
