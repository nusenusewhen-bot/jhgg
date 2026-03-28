const { Client: SelfbotClient } = require('discord.js-selfbot-v13');
const { getSuperProperties } = require('./superprops');

const activeBots = new Map();

async function validateToken(token) {
    try {
        const client = new SelfbotClient({ checkUpdate: false });
        await client.login(token);
        const username = client.user?.tag;
        await client.destroy();
        return { valid: true, username };
    } catch (e) {
        return { valid: false, error: e.message };
    }
}

async function startSelfBot(userId, token, channelIds, message, autoReply) {
    stopSelfBot(userId);
    
    const client = new SelfbotClient({
        checkUpdate: false,
        ws: { properties: getSuperProperties() }
    });
    
    // Auto-reply handler
    if (autoReply) {
        client.on('messageCreate', async (msg) => {
            if (msg.author.id === client.user.id) return;
            if (!channelIds.includes(msg.channel.id)) return;
            
            const triggers = ['price', 'how much', 'cost', 'buy', 'purchase'];
            const content = msg.content.toLowerCase();
            
            if (triggers.some(t => content.includes(t))) {
                try {
                    await msg.reply(autoReply);
                } catch (e) {}
            }
        });
    }
    
    client.on('ready', () => {
        console.log(`[SELFBOT] ${userId} ready as ${client.user.tag}`);
        
        const interval = setInterval(async () => {
            for (const channelId of channelIds) {
                try {
                    const channel = await client.channels.fetch(channelId.trim());
                    if (channel) {
                        await channel.send(message);
                        console.log(`[SELFBOT] ${userId} sent to ${channelId}`);
                    }
                } catch (e) {
                    console.error(`[SELFBOT] ${userId} error:`, e.message);
                }
            }
        }, 30000);
        
        activeBots.set(userId, { client, interval });
    });
    
    await client.login(token);
    return client;
}

function stopSelfBot(userId) {
    const bot = activeBots.get(userId);
    if (bot) {
        clearInterval(bot.interval);
        bot.client.destroy();
        activeBots.delete(userId);
    }
}

module.exports = { startSelfBot, stopSelfBot, validateToken };
