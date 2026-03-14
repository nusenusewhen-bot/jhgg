const puppeteer = require('puppeteer-core');

const EMAIL = process.env.EMAIL || 'aghaithollah@gmail.com';
const PASSWORDS = [
  process.env.PASS || 'Warrior2012@',
  process.env.FALLBACK1 || 'Warrior012@',
  process.env.FALLBACK2 || 'Warrior12@'
];

async function launch() {
  return puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process'
    ],
    headless: 'new',
    ignoreHTTPSErrors: true
  });
}

async function login(page) {
  console.log('[*] Starting login...');
  await page.goto('https://accounts.snapchat.com/accounts/login', { 
    waitUntil: 'networkidle2',
    timeout: 30000 
  });
  
  for (let i = 0; i < PASSWORDS.length; i++) {
    try {
      await page.waitForSelector('input[name="username"]', {timeout: 10000});
      
      await page.evaluate(() => {
        const u = document.querySelector('input[name="username"]');
        const p = document.querySelector('input[name="password"]');
        if(u) u.value = '';
        if(p) p.value = '';
      });
      
      await page.type('input[name="username"]', EMAIL, {delay: 15});
      await page.type('input[name="password"]', PASSWORDS[i], {delay: 15});
      
      await Promise.all([
        page.click('button[type="submit"]'),
        page.waitForNavigation({waitUntil: 'networkidle2', timeout: 15000}).catch(() => {})
      ]);
      
      await page.waitForTimeout(4000);
      
      const url = page.url();
      if (!url.includes('accounts.snapchat.com')) {
        console.log(`[+] Auth success (password ${i})`);
        return true;
      }
      
      if (await page.$('text/Incorrect password') || await page.$('text/Wrong password')) {
        console.log(`[-] Password ${i} incorrect`);
        continue;
      }
      
    } catch(e) {
      console.log(`[-] Attempt ${i} error: ${e.message}`);
      if (!page.url().includes('login')) return true;
    }
  }
  throw new Error('Login failed - all passwords exhausted');
}

async function watchChat(page) {
  console.log('[*] Loading web.snapchat.com...');
  
  await page.goto('https://web.snapchat.com/', { 
    waitUntil: 'domcontentloaded',
    timeout: 60000 
  });
  
  await page.waitForTimeout(8000);
  
  console.log('[+] BOT ACTIVE - watching for ".test"');
  console.log('[*] Ready to reply "Work"');
  
  const processed = new Set();
  
  while (true) {
    try {
      const messages = await page.$$eval('[data-testid="message-content"], .MessageContent, .MsgMessage', 
        els => els.slice(-10).map((el, idx) => ({
          id: idx + '-' + el.innerText.slice(0, 20),
          text: el.innerText.trim(),
          isMine: el.className.includes('fromMe') || el.closest('[data-testid="message-outgoing"]')
        }))
      );
      
      for (const msg of messages) {
        if (!msg.isMine && msg.text === '.test' && !processed.has(msg.id)) {
          processed.add(msg.id);
          
          const inputSelectors = [
            'div[contenteditable="true"]',
            '[data-testid="message-input"]',
            'input[placeholder*="Send"]',
            'textarea'
          ];
          
          let input = null;
          for (const sel of inputSelectors) {
            input = await page.$(sel);
            if (input) break;
          }
          
          if (input) {
            await input.click();
            await input.type('Work', {delay: 10});
            await page.keyboard.press('Enter');
            console.log(`[>] Replied "Work" to .test command`);
            await page.waitForTimeout(500);
          }
        }
      }
      
      if (processed.size > 100) processed.clear();
      
    } catch(e) {
      // Silent continue
    }
    
    await page.waitForTimeout(1500);
  }
}

(async () => {
  let browser;
  try {
    browser = await launch();
    const page = await browser.newPage();
    
    await page.setViewport({width: 1280, height: 720});
    await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    await login(page);
    await watchChat(page);
    
  } catch(err) {
    console.error('[-] FATAL:', err.message);
    if (browser) await browser.close();
    process.exit(1);
  }
})();
