const { Client, GatewayIntentBits } = require('discord.js');
const HttpsProxyAgent = require('https-proxy-agent');
const fetch = require('node-fetch');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const OWNER_ID = '1422945082746601594';
const TOKEN = process.env.DISCORD_TOKEN;

if (!TOKEN) {
    console.error('DISCORD_TOKEN not found in environment variables. Set it in Railway → Variables.');
    process.exit(1);
}

// Working public HTTP proxies (update when needed)
const proxyList = [
    'http://20.206.106.178:80',
    'http://47.251.70.153:33333',
    'http://154.36.110.199:6853',
    'http://38.154.227.167:5868',
    'http://45.145.130.199:3128',
    'http://20.210.113.32:80',
    'http://103.153.154.25:80',
    'http://47.76.144.88:3128',
    'http://154.202.119.35:8800'
];

async function testProxy(proxyUrl) {
    try {
        const agent = new HttpsProxyAgent(proxyUrl);
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), 7000);

        const res = await fetch('https://discord.com/api/v10/users/@me', {
            agent,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            signal: controller.signal
        });

        clearTimeout(id);
        return res.ok ? proxyUrl : null;
    } catch {
        return null;
    }
}

async function getWorkingProxy() {
    const shuffled = [...proxyList].sort(() => Math.random() - 0.5);

    for (const proxy of shuffled) {
        console.log(`Testing proxy: ${proxy}`);
        const good = await testProxy(proxy);
        if (good) {
            console.log(`Using working proxy → ${good}`);
            return new HttpsProxyAgent(good);
        }
    }

    console.log('No live proxies → connecting without proxy (more detectable)');
    return null;
}

client.once('ready', () => {
    console.log(`Selfbot online as ${client.user.tag} | Owner ID locked | .test → Work`);
});

client.on('messageCreate', async (message) => {
    if (message.author.id !== OWNER_ID) return;
    if (!message.content.startsWith('.')) return;

    const args = message.content.slice(1).trim().split(/ +/);
    const cmd = args.shift()?.toLowerCase();

    if (cmd === 'test') {
        await message.channel.send('Work').catch(() => {});
        // Uncomment to auto-delete your command:
        // await message.delete().catch(() => {});
    }
});

(async () => {
    const agent = await getWorkingProxy();

    // Small random delay before login (makes pattern less robotic)
    const delay = 1000 + Math.floor(Math.random() * 3000);
    console.log(`Waiting ${delay}ms before login...`);
    await new Promise(r => setTimeout(r, delay));

    client.login(TOKEN, {
        ws: { agent },
        http: { agent },
        compress: true
    }).catch(err => {
        console.error('Login error:', err.message);
        process.exit(1);
    });
})();
