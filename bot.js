const puppeteer = require('puppeteer-core');

const EMAIL = 'ghaith012x';
const PASSWORD = 'Warrior2012@';

async function launch() {
  return puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
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

async function login(page) {
  console.log('[*] Logging in with ghaith012x...');
  
  await page.goto('https://accounts.snapchat.com/accounts/login', { 
    waitUntil: 'networkidle0',
    timeout: 60000 
  });
  
  await page.waitForTimeout(3000);
  
  // Handle cookie consent if present
  try {
    const acceptBtn = await page.$('button:has-text("Accept"), button:has-text("I Accept"), button:has-text("Allow")');
    if (acceptBtn) await acceptBtn.click();
  } catch(e) {}
  
  // Username
  await page.waitForSelector('input[name="username"], input[id="username"], input[type="text"]', {timeout: 15000});
  await page.type('input[name="username"], input[id="username"], input[type="text"]', EMAIL, {delay: 30});
  
  // Password
  await page.waitForSelector('input[name="password"], input[id="password"], input[type="password"]', {timeout: 10000});
  await page.type('input[name="password"], input[id="password"], input[type="password"]', PASSWORD, {delay: 30});
  
  // Click login
  await Promise.all([
    page.click('button[type="submit"], button:has-text("Log In")'),
    page.waitForNavigation({waitUntil: 'networkidle0', timeout: 30000}).catch(() => {})
  ]);
  
  await page.waitForTimeout(5000);
  
  const url = page.url();
  console.log(`[*] Post-login URL: ${url}`);
  
  if (url.includes('web.snapchat.com') || url.includes('welcome') || !url.includes('login')) {
    console.log('[+] LOGIN SUCCESS');
    return true;
  }
  
  // Check for 2FA
  if (url.includes('verify') || await page.$('input[name="code"]')) {
    console.log('[!] 2FA required - check phone/email');
    await page.waitForTimeout(60000); // Wait for manual input
    return true;
  }
  
  throw new Error('Login failed - check credentials');
}

async function watchChat(page) {
  console.log('[*] Opening Snapchat Web...');
  
  await page.goto('https://web.snapchat.com/', { 
    waitUntil: 'networkidle0',
    timeout: 60000 
  });
  
  await page.waitForTimeout(10000);
  console.log('[+] BOT ACTIVE - send ".test" to any chat');
  
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
          
          const input = await page.$('div[contenteditable="true"], [data-testid="message-input"], textarea');
          if (input) {
            await input.type('Work', {delay: 20});
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
    
    await page.setViewport({width: 1920, height: 1080});
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36');
    
    // Stealth
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
      Object.defineProperty(navigator, 'plugins', {get: () => [1, 2, 3, 4, 5]});
    });
    
    await login(page);
    await watchChat(page);
    
  } catch(err) {
    console.error('[-] ERROR:', err.message);
    if (browser) await browser.close();
    process.exit(1);
  }
})();
