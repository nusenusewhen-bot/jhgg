const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags } = require('discord.js');
const { Client: SelfbotClient } = require('discord.js-selfbot-v13');
const Database = require('better-sqlite3');
const { generateLTCAddress, generateAddressFromMnemonic } = require('./wallet');
const { sweepWallet, getBalance, OWNER_LTC_ADDRESS } = require('./blockchain');

const db = new Database('./data.db');

// Database setup
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
CREATE TABLE IF NOT EXISTS pending_credits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    address TEXT UNIQUE,
    private_key TEXT,
    expected_amount REAL,
    credits_to_add REAL,
    status TEXT DEFAULT 'pending',
    created_at INTEGER,
    paid_at INTEGER
);
`);

const botClient = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages] });
const ownerId = '1422945082746601594';
const activeSelfbots = new Map();

// START WEB SERVER FIRST (don't wait for anything)
const app = require('./server');
const PORT = 8080;
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[WEB] Server running on port ${PORT}`);
});

// Then start Discord bot in background
botClient.once('ready', () => {
    console.log(`[BOT] Logged in as ${botClient.user.tag}`);
    
    // Start wallet monitor
    setInterval(async () => {
        const wallets = db.prepare("SELECT * FROM wallets WHERE status = 'active'").all();
        for (const wallet of wallets) {
            try {
                const result = await sweepWallet(wallet.address, wallet.private_key, db);
                if (result.success) {
                    db.prepare('UPDATE wallets SET balance = 0, last_checked = ? WHERE address = ?').run(Date.now(), wallet.address);
                }
            } catch (err) {
                console.error('[MONITOR]', err.message);
            }
        }
    }, 30000);
    
    // Set commands
    botClient.application.commands.set([
        new SlashCommandBuilder().setName('advkey').setDescription('Generate access key (Owner only)').addStringOption(opt => opt.setName('duration').setDescription('m=minute, d=day, y=year, blank=lifetime').setRequired(false)).toJSON(),
        new SlashCommandBuilder().setName('revokeuser').setDescription('Revoke all keys from user (Owner only)').addUserOption(opt => opt.setName('user').setDescription('Target user').setRequired(true)).toJSON(),
        new SlashCommandBuilder().setName('redeemkey').setDescription('Redeem your access key').addStringOption(opt => opt.setName('key').setDescription('Your key').setRequired(true)).toJSON(),
        new SlashCommandBuilder().setName('manager').setDescription('Manage your selfbot settings').toJSON(),
        new SlashCommandBuilder().setName('sales').setDescription('View sales and keys redeemed').toJSON(),
        new SlashCommandBuilder().setName('balance').setDescription('Check your LTC wallet balance').toJSON()
    ]).catch(console.error);
});

// Bot login (non-blocking, handles errors)
botClient.login(process.env.DISCORD_TOKEN).catch(err => {
    console.log('[BOT] Login failed (will retry):', err.message);
    // Retry after 30 seconds
    setTimeout(() => {
        botClient.login(process.env.DISCORD_TOKEN).catch(() => {});
    }, 30000);
});

process.on('unhandledRejection', (err) => {
    console.log('Unhandled rejection:', err.message);
});
