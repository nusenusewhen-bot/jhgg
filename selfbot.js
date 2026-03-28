const { Client: SelfbotClient } = require('discord.js-selfbot-v13');
const { getSuperProperties } = require('./superprops');

const activeBots = new Map();

async function startSelfBot(userId, token, channelIds, message) {
    stopSelfBot(userId);
    
    const client = new SelfbotClient({
        checkUpdate: false,
        ws: {
            properties: getSuperProperties()
        }
    });
    
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
                    console.error(`[SELFBOT] ${userId} error in ${channelId}:`, e.message);
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
        console.log(`[SELFBOT] ${userId} stopped`);
    }
}

module.exports = { startSelfBot, stopSelfBot };
