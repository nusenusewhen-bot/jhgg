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
      '--disable-gpu',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1920,1080'
    ],
    headless: false,
    ignoreHTTPSErrors: true
  });
}

async function stealth(page) {
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
    Object.defineProperty(navigator, 'plugins', {get: () => [1, 2, 3, 4, 5]});
    Object.defineProperty(navigator, 'languages', {get: () => ['en-US', 'en']});
    window.chrome = { runtime: {} };
  });
}

async function login(page) {
  console.log('[*] Loading login page...');
  
  await page.goto('https://accounts.snapchat.com/accounts/login', { 
    waitUntil: 'networkidle0',
    timeout: 60000 
  });
  
  await page.waitForTimeout(3000);
  
  // Try multiple selectors
  const userSelectors = [
    'input[name="username"]',
    'input[id="username"]',
    'input[type="text"]',
    'input[placeholder*="username" i]',
    'input[placeholder*="phone" i]',
    'input[autocomplete="username"]'
  ];
  
  let usernameInput = null;
  for (const sel of userSelectors) {
    try {
      usernameInput = await page.waitForSelector(sel, {timeout: 5000});
      if (usernameInput) {
        console.log(`[+] Found username field: ${sel}`);
        break;
      }
    } catch(e) {}
  }
  
  if (!usernameInput) {
    console.log('[-] Dumping page HTML for debug:');
    const html = await page.content();
    console.log(html.slice(0, 2000));
    throw new Error('Cannot find username input');
  }
  
  for (let i = 0; i < PASSWORDS.length; i++) {
    try {
      await usernameInput.click();
      await usernameInput.type(EMAIL, {delay: 50});
      
      const passSelectors = [
        'input[name="password"]',
        'input[id="password"]',
        'input[type="password"]'
      ];
      
      let passInput = null;
      for (const sel of passSelectors) {
        passInput = await page.$(sel);
        if (passInput) break;
      }
      
      if (!passInput) throw new Error('No password field');
      
      await passInput.click();
      await passInput.type(PASSWORDS[i], {delay: 50});
      
      const btnSelectors = [
        'button[type="submit"]',
        'button:has-text("Log In")',
        'input[type="submit"]'
      ];
      
      let btn = null;
      for (const sel of btnSelectors) {
        btn = await page.$(sel);
        if (btn) break;
      }
      
      await Promise.all([
        btn.click(),
        page.waitForNavigation({waitUntil: 'networkidle0', timeout: 20000}).catch(() => {})
      ]);
      
      await page.waitForTimeout(5000);
      
      const url = page.url();
      console.log(`[*] Current URL: ${url}`);
      
      if (url.includes('web.snapchat.com') || url.includes('accounts.snapchat.com/accounts/welcome')) {
        console.log(`[+] LOGIN SUCCESS (password ${i})`);
        return true;
      }
      
      if (url.includes('challenge') || url.includes('verify')) {
        console.log('[!] 2FA/Challenge required - cannot proceed');
        return false;
      }
      
    } catch(e) {
      console.log(`[-] Attempt ${i}: ${e.message}`);
    }
  }
  return false;
}

async function watchChat(page) {
  console.log('[*] Navigating to web.snapchat.com...');
  
  await page.goto('https://web.snapchat.com/', { 
    waitUntil: 'networkidle0',
    timeout: 60000 
  });
  
  await page.waitForTimeout(10000);
  
  console.log('[+] BOT RUNNING - type ".test" in any chat');
  
  const seen = new Set();
  
  setInterval(async () => {
    try {
      const msgs = await page.$$eval('[data-testid="message-content"], .Message__body, .MsgMessage__body, .conversation-message', 
        els => els.slice(-5).map((el, i) => ({
          id: i + '-' + el.innerText.slice(0, 15),
          text: el.innerText.trim(),
          mine: el.className.includes('outgoing') || el.getAttribute('data-self') === 'true'
        }))
      );
      
      for (const msg of msgs) {
        if (!msg.mine && msg.text === '.test' && !seen.has(msg.id)) {
          seen.add(msg.id);
          
          const inputs = await page.$$('div[contenteditable="true"], [data-testid="message-input"], textarea');
          if (inputs.length > 0) {
            await inputs[inputs.length - 1].type('Work', {delay: 20});
            await page.keyboard.press('Enter');
            console.log('[>] Replied: Work');
          }
        }
      }
      
      if (seen.size > 50) seen.clear();
    } catch(e) {}
  }, 2000);
}

(async () => {
  let browser;
  try {
    browser = await launch();
    const page = await browser.newPage();
    
    await stealth(page);
    
    await page.setViewport({width: 1920, height: 1080});
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36');
    
    const success = await login(page);
    if (success) await watchChat(page);
    else {
      console.log('[-] Login failed');
      await browser.close();
      process.exit(1);
    }
    
  } catch(err) {
    console.error('[-] CRASH:', err.message);
    if (browser) await browser.close();
    process.exit(1);
  }
})();
