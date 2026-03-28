// Config API endpoints
const { Client: SelfbotClient } = require('discord.js-selfbot-v13');

const activeSelfbots = new Map();

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

app.get('/api/config', ensureAuth, (req, res) => {
    try {
        const userId = req.user.id;
        const userData = db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId);
        
        if (!userData) {
            return res.json({
                hasToken: false,
                hasChannels: false,
                hasMessage: false,
                hasDelay: false,
                running: false,
                autoReply: false
            });
        }
        
        const hasToken = userData.token && userData.token_valid === 'yes';
        const hasChannels = userData.channels && userData.channels.length > 0;
        const hasMessage = userData.message && userData.message.length > 0;
        const hasDelay = userData.delay && userData.delay > 0;
        const running = activeSelfbots.has(userId);
        const autoReply = userData.auto_reply_dm === 'y';
        
        res.json({
            hasToken,
            hasChannels,
            hasMessage,
            hasDelay,
            running,
            autoReply,
            autoReplyMessage: userData.auto_reply_message || '',
            channels: userData.channels || '',
            message: userData.message || '',
            delay: userData.delay || '',
            channelCount: hasChannels ? userData.channels.split(',').length : 0
        });
    } catch (err) {
        console.error('[CONFIG GET ERROR]', err);
        res.status(500).json({ error: 'Failed to load config' });
    }
});

app.post('/api/config/token', ensureAuth, async (req, res) => {
    try {
        const { token } = req.body;
        const userId = req.user.id;
        
        const validation = await validateToken(token);
        if (!validation.valid) {
            return res.json({ success: false, error: validation.error });
        }
        
        db.prepare('UPDATE users SET token = ?, token_valid = ?, token_username = ? WHERE user_id = ?')
            .run(token, 'yes', validation.user.tag, userId);
        
        res.json({ success: true, username: validation.user.tag });
    } catch (err) {
        console.error('[TOKEN ERROR]', err);
        res.status(500).json({ success: false, error: 'Validation failed' });
    }
});

app.post('/api/config/channels', ensureAuth, (req, res) => {
    try {
        const { channels } = req.body;
        const userId = req.user.id;
        
        db.prepare('UPDATE users SET channels = ? WHERE user_id = ?').run(channels, userId);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Failed to save' });
    }
});

app.post('/api/config/message', ensureAuth, (req, res) => {
    try {
        const { message } = req.body;
        const userId = req.user.id;
        
        db.prepare('UPDATE users SET message = ? WHERE user_id = ?').run(message, userId);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Failed to save' });
    }
});

app.post('/api/config/delay', ensureAuth, (req, res) => {
    try {
        const { delay } = req.body;
        const userId = req.user.id;
        
        db.prepare('UPDATE users SET delay = ? WHERE user_id = ?').run(delay, userId);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Failed to save' });
    }
});

app.post('/api/config/autoreply', ensureAuth, (req, res) => {
    try {
        const { enabled, message } = req.body;
        const userId = req.user.id;
        
        db.prepare('UPDATE users SET auto_reply_dm = ?, auto_reply_message = ?, replied_users = ? WHERE user_id = ?')
            .run(enabled ? 'y' : 'n', message || null, '[]', userId);
        
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Failed to save' });
    }
});

app.post('/api/config/start', ensureAuth, async (req, res) => {
    try {
        const userId = req.user.id;
        const userData = db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId);
        
        if (!userData || !userData.token || userData.token_valid !== 'yes' || !userData.channels || !userData.message || !userData.delay) {
            return res.json({ success: false, error: 'Configure all settings first' });
        }
        
        // Stop existing if running
        if (activeSelfbots.has(userId)) {
            const old = activeSelfbots.get(userId);
            clearInterval(old.interval);
            old.client.destroy();
            activeSelfbots.delete(userId);
        }
        
        const selfbot = new SelfbotClient({ checkUpdate: false, ws: { properties: { os: 'Windows', browser: 'Chrome', device: '', browser_user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', os_version: '10', client_build_number: 9999 } } });
        
        let readyFired = false;
        
        selfbot.once('ready', async () => {
            if (readyFired) return;
            readyFired = true;
            
            db.prepare('UPDATE users SET status = ? WHERE user_id = ?').run('running', userId);
            
            const channels = userData.channels.split(',').map(c => c.trim()).filter(c => c);
            
            const sendMessage = async () => {
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
            
            // Auto reply
            if (userData.auto_reply_dm === 'y' && userData.auto_reply_message) {
                const processedMessages = new Set();
                const repliedUsers = new Set();
                
                selfbot.on('messageCreate', async (msg) => {
                    if (msg.channel.type !== 'DM' || msg.author.id === selfbot.user.id) return;
                    if (processedMessages.has(msg.id)) return;
                    processedMessages.add(msg.id);
                    
                    if (msg.content.toLowerCase().includes('captcha') || msg.content.toLowerCase().includes('verify')) return;
                    if (repliedUsers.has(msg.author.id)) return;
                    
                    try {
                        const messages = await msg.channel.messages.fetch({ limit: 50 });
                        if (messages.filter(m => m.author.id === selfbot.user.id).size > 0) return;
                        
                        await msg.channel.send(userData.auto_reply_message);
                        repliedUsers.add(msg.author.id);
                    } catch (e) {}
                });
            }
        });
        
        selfbot.login(userData.token).catch(err => {
            console.error('[SELFBOT LOGIN]', err);
        });
        
        res.json({ success: true });
    } catch (err) {
        console.error('[START ERROR]', err);
        res.status(500).json({ success: false, error: 'Failed to start' });
    }
});

app.post('/api/config/stop', ensureAuth, (req, res) => {
    try {
        const userId = req.user.id;
        
        if (activeSelfbots.has(userId)) {
            const { client, interval } = activeSelfbots.get(userId);
            clearInterval(interval);
            client.destroy();
            activeSelfbots.delete(userId);
        }
        
        db.prepare('UPDATE users SET status = ? WHERE user_id = ?').run('stopped', userId);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Failed to stop' });
    }
});
