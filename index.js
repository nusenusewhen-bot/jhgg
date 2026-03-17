const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, PermissionFlagsBits } = require('discord.js');
const { Client: SelfbotClient } = require('discord.js-selfbot-v13');
const Database = require('better-sqlite3');
const superProps = require('./superprops.js');

const db = new Database('./data.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,
    key TEXT,
    key_expires INTEGER,
    token TEXT,
    channels TEXT,
    message TEXT,
    delay INTEGER,
    status TEXT DEFAULT 'stopped'
  );
  CREATE TABLE IF NOT EXISTS keys (
    key TEXT PRIMARY KEY,
    duration TEXT,
    created_at INTEGER,
    redeemed_by TEXT,
    redeemed_at INTEGER
  );
`);

const botClient = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

const ownerId = '1422945082746601594';
const activeSelfbots = new Map();

botClient.once('ready', () => {
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
      .toJSON()
  ];
  
  botClient.application.commands.set(commands);
});

botClient.on('interactionCreate', async interaction => {
  if (!interaction.isCommand() && !interaction.isButton() && !interaction.isModalSubmit()) return;
  
  const isOwner = interaction.user.id === ownerId;
  
  if (interaction.commandName === 'advkey') {
    if (!isOwner) return interaction.reply({ content: 'Owner only.', ephemeral: true });
    
    const duration = interaction.options.getString('duration') || 'lifetime';
    const key = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    let expires = null;
    
    if (duration.endsWith('m')) expires = Date.now() + parseInt(duration) * 60000;
    else if (duration.endsWith('d')) expires = Date.now() + parseInt(duration) * 86400000;
    else if (duration.endsWith('y')) expires = Date.now() + parseInt(duration) * 31536000000;
    
    db.prepare('INSERT INTO keys (key, duration, created_at, expires) VALUES (?, ?, ?, ?)').run(key, duration, Date.now(), expires);
    
    return interaction.reply({ content: `Key generated: \`${key}\`\nDuration: ${duration}`, ephemeral: true });
  }
  
  if (interaction.commandName === 'revokeuser') {
    if (!isOwner) return interaction.reply({ content: 'Owner only.', ephemeral: true });
    
    const target = interaction.options.getUser('user');
    db.prepare('DELETE FROM users WHERE user_id = ?').run(target.id);
    
    if (activeSelfbots.has(target.id)) {
      activeSelfbots.get(target.id).destroy();
      activeSelfbots.delete(target.id);
    }
    
    return interaction.reply({ content: `Revoked all access for ${target.tag}`, ephemeral: true });
  }
  
  if (interaction.commandName === 'redeemkey') {
    const key = interaction.options.getString('key');
    const keyData = db.prepare('SELECT * FROM keys WHERE key = ?').get(key);
    
    if (!keyData) return interaction.reply({ content: 'Invalid key.', ephemeral: true });
    if (keyData.redeemed_by) return interaction.reply({ content: 'Key already used.', ephemeral: true });
    
    db.prepare('UPDATE keys SET redeemed_by = ?, redeemed_at = ? WHERE key = ?').run(interaction.user.id, Date.now(), key);
    db.prepare('INSERT OR REPLACE INTO users (user_id, key, key_expires) VALUES (?, ?, ?)').run(interaction.user.id, key, keyData.expires);
    
    return interaction.reply({ content: 'Key redeemed! Use /manager to configure.', ephemeral: true });
  }
  
  if (interaction.commandName === 'manager') {
    const userData = db.prepare('SELECT * FROM users WHERE user_id = ?').get(interaction.user.id);
    if (!userData) return interaction.reply({ content: 'Redeem a key first using /redeemkey', ephemeral: true });
    
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('set_token').setLabel('Set Token').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('set_channels').setLabel('Set Channels').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('set_message').setLabel('Set Message').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('set_delay').setLabel('Set Delay').setStyle(ButtonStyle.Primary)
    );
    
    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('start_bot')
        .setLabel('Start')
        .setStyle(userData.status === 'running' ? ButtonStyle.Success : ButtonStyle.Secondary)
        .setDisabled(userData.status === 'running'),
      new ButtonBuilder()
        .setCustomId('stop_bot')
        .setLabel('Stop')
        .setStyle(userData.status === 'stopped' ? ButtonStyle.Danger : ButtonStyle.Secondary)
        .setDisabled(userData.status === 'stopped')
    );
    
    const embed = new EmbedBuilder()
      .setTitle('Selfbot Manager')
      .setDescription(`Status: ${userData.status}\nToken: ${userData.token ? '✅ Set' : '❌ Not set'}\nChannels: ${userData.channels || 'Not set'}\nDelay: ${userData.delay || 'Not set'}s`)
      .setColor(userData.status === 'running' ? 0x00ff00 : 0xff0000);
    
    return interaction.reply({ embeds: [embed], components: [row, row2], ephemeral: true });
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
        new TextInputBuilder().setCustomId('channels_input').setLabel('Channel IDs (comma separated)').setStyle(TextInputStyle.Short).setRequired(true)
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
        new TextInputBuilder().setCustomId('delay_input').setLabel('Delay in seconds (5-1800)').setStyle(TextInputStyle.Short).setRequired(true)
      ));
      return interaction.showModal(modal);
    }
    
    if (interaction.customId === 'start_bot') {
      const userData = db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId);
      if (!userData.token || !userData.channels || !userData.message || !userData.delay) {
        return interaction.reply({ content: 'Configure all settings first!', ephemeral: true });
      }
      
      if (activeSelfbots.has(userId)) {
        activeSelfbots.get(userId).destroy();
      }
      
      const selfbot = new SelfbotClient({ checkUpdate: false });
      
      selfbot.on('ready', async () => {
        console.log(`Selfbot ready: ${selfbot.user.tag}`);
        db.prepare('UPDATE users SET status = ? WHERE user_id = ?').run('running', userId);
        
        const channels = userData.channels.split(',').map(c => c.trim());
        let current = 0;
        
        const interval = setInterval(async () => {
          const ch = await selfbot.channels.fetch(channels[current]).catch(() => null);
          if (ch) ch.send(userData.message).catch(() => {});
          current = (current + 1) % channels.length;
        }, userData.delay * 1000);
        
        activeSelfbots.set(userId, { client: selfbot, interval });
        
        await interaction.update({
          embeds: [new EmbedBuilder().setTitle('Selfbot Manager').setDescription(`✅ Running as ${selfbot.user.tag}`).setColor(0x00ff00)],
          components: [interaction.message.components[0], new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('start_bot').setLabel('Start').setStyle(ButtonStyle.Secondary).setDisabled(true),
            new ButtonBuilder().setCustomId('stop_bot').setLabel('Stop').setStyle(ButtonStyle.Danger).setDisabled(false)
          )]
        });
      });
      
      selfbot.on('error', async () => {
        await interaction.reply({ content: 'Invalid token!', ephemeral: true });
      });
      
      Object.assign(selfbot.options, { http: { headers: { 'x-super-properties': Buffer.from(JSON.stringify(superProps.getSuperProperties())).toString('base64') } } });
      selfbot.login(userData.token);
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
      
      return interaction.update({
        embeds: [new EmbedBuilder().setTitle('Selfbot Manager').setDescription('⛔ Stopped').setColor(0xff0000)],
        components: [interaction.message.components[0], new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('start_bot').setLabel('Start').setStyle(ButtonStyle.Success).setDisabled(false),
          new ButtonBuilder().setCustomId('stop_bot').setLabel('Stop').setStyle(ButtonStyle.Secondary).setDisabled(true)
        )]
      });
    }
  }
  
  if (interaction.isModalSubmit()) {
    const userId = interaction.user.id;
    
    if (interaction.customId === 'modal_token') {
      const token = interaction.fields.getTextInputValue('token_input');
      db.prepare('UPDATE users SET token = ? WHERE user_id = ?').run(token, userId);
      return interaction.reply({ content: 'Token saved! Click Start to validate.', ephemeral: true });
    }
    
    if (interaction.customId === 'modal_channels') {
      const channels = interaction.fields.getTextInputValue('channels_input');
      db.prepare('UPDATE users SET channels = ? WHERE user_id = ?').run(channels, userId);
      return interaction.reply({ content: 'Channels saved!', ephemeral: true });
    }
    
    if (interaction.customId === 'modal_message') {
      const message = interaction.fields.getTextInputValue('message_input');
      db.prepare('UPDATE users SET message = ? WHERE user_id = ?').run(message, userId);
      return interaction.reply({ content: 'Message saved!', ephemeral: true });
    }
    
    if (interaction.customId === 'modal_delay') {
      const delay = parseInt(interaction.fields.getTextInputValue('delay_input'));
      if (delay < 5 || delay > 1800) return interaction.reply({ content: 'Delay must be 5-1800 seconds!', ephemeral: true });
      db.prepare('UPDATE users SET delay = ? WHERE user_id = ?').run(delay, userId);
      return interaction.reply({ content: `Delay set to ${delay} seconds!`, ephemeral: true });
    }
  }
});

botClient.login(process.env.DISCORD_TOKEN);
