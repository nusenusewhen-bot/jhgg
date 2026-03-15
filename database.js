const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'bots.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS bot_configs (
    bot_id INTEGER PRIMARY KEY,
    server_id TEXT,
    channel_id TEXT,
    message TEXT,
    delay INTEGER DEFAULT 5000,
    enabled INTEGER DEFAULT 0,
    spamming INTEGER DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  
  CREATE TABLE IF NOT EXISTS spam_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_id INTEGER,
    channel_id TEXT,
    message TEXT,
    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

module.exports = db;
