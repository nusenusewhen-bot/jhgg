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
      '--window-size=1920,1080',
      '--start-maximized'
    ],
    headless: false,
    ignoreHTTPSErrors: true
  });
}

async function waitForAnySelector(page, selectors, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    for (const sel of selectors) {
      try {
        const el = await page.$(sel);
        if (el) return el;
      } catch(e) {}
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`None of ${selectors.join(', ')} found`);
}

async function login(page) {
  console.log('[*] Loading Snapchat login...');
  
  await page.goto('https://accounts.snapchat.com/accounts/login', { 
    waitUntil: 'networkidle0',
    timeout: 60000 
  });
  
  // Wait for page to fully render
  await page.waitForTimeout(5000);
  
  // Screenshot for debug
  await page.screenshot({path: '/tmp/login_page.png'});
  console.log('[*] Screenshot saved');
  
  // Find username field
  console.log('[*] Looking for username field...');
  const userSelectors = [
    'input[name="username"]',
    'input[id="username"]',
    'input[placeholder*="username" i]',
    'input[placeholder*="phone" i]',
    'input[type="text"]',
    'input[autocomplete="username"]',
    'input'
  ];
  
  const userInput = await waitForAnySelector(page, userSelectors, 20000);
  console.log('[+] Found username input');
  
  await userInput.click();
  await userInput.type(EMAIL, {delay: 50});
  console.log('[*] Username entered');
  
  await page.waitForTimeout(1000);
  
  // Find password field
  console.log('[*] Looking for password field...');
  const passSelectors = [
    'input[name="password"]',
    'input[id="password"]',
    'input[type="password"]',
    'input[placeholder*="password" i]'
  ];
  
  const passInput = await waitForAnySelector(page, passSelectors, 20000);
  console.log('[+] Found password input');
  
  await passInput.click();
  await passInput.type(PASSWORD, {delay: 50});
  console.log('[*] Password entered');
  
  await page.waitForTimeout(1000);
  
  // Find submit button
  console.log('[*] Looking for login button...');
  const btnSelectors = [
    'button[type="submit"]',
    'button:has-text("Log In")',
    'button:has-text("Sign In")',
    'input[type="submit"]',
    'button'
  ];
  
  let btn = null;
  for (const sel of btnSelectors) {
    try {
      btn = await page.$(sel);
      if (btn) {
        const text = await page.evaluate(el => el.innerText, btn);
        if (text.toLowerCase().includes('log') || text.toLowerCase().includes('sign') || sel === 'button[type="submit"]') {
          console.log(`[+] Found button: ${text || sel}`);
          break;
        }
      }
    } catch(e) {}
  }
  
  if (!btn) btn = await page.$('button');
  
  console.log('[*] Clicking login...');
  await Promise.all([
    btn.click(),
    page.waitForNavigation({waitUntil: 'networkidle0', timeout: 30000}).catch(() => {})
  ]);
  
  await page.waitForTimeout(8000);
  
  const url = page.url();
  console.log(`[*] Current URL: ${url}`);
  
  // Check success
  if (!url.includes('login') && !url.includes('accounts.snapchat.com/accounts')) {
    console.log('[+] LOGIN SUCCESS');
    return true;
  }
  
  // Check for errors
  const errorText = await page.evaluate(() => document.body.innerText);
  if (errorText.includes('incorrect') || errorText.includes('wrong')) {
    console.log('[-] Invalid credentials');
    return false;
  }
  
  if (errorText.includes('verify') || errorText.includes('code')) {
    console.log('[!] 2FA required - waiting 60s for manual solve');
    await page.waitForTimeout(60000);
    return true;
  }
  
  // Final check
  const finalUrl = page.url();
  if (finalUrl.includes('web.snapchat.com')) {
    console.log('[+] LOGIN SUCCESS (redirected to web)');
    return true;
  }
  
  throw new Error(`Login failed. URL: ${finalUrl}`);
}

async function watchChat(page) {
  console.log('[*] Navigating to web.snapchat.com...');
  
  await page.goto('https://web.snapchat.com/', { 
    waitUntil: 'networkidle0',
    timeout: 60000 
  });
  
  await page.waitForTimeout(10000);
  console.log('[+] BOT ACTIVE - waiting for .test commands');
  
  const seen = new Set();
  
  while (true) {
    try {
      const msgs = await page.$$eval('[data-testid="message-content"], .Message__body, .conversation-message, div[dir="auto"]', 
        els => els.slice(-5).map((el, i) => ({
          id: i + '-' + el.innerText.slice(0, 20),
          text: el.innerText.trim(),
          mine: el.className.includes('outgoing') || el.closest('[data-self="true"]') !== null
        }))
      );
      
      for (const msg of msgs) {
        if (!msg.mine && msg.text === '.test' && !seen.has(msg.id)) {
          seen.add(msg.id);
          console.log(`[+] Got .test command`);
          
          // Try multiple input selectors
          const inputSelectors = [
            'div[contenteditable="true"]',
            '[data-testid="message-input"]',
            'textarea',
            'input[placeholder*="Send"]'
          ];
          
          for (const sel of inputSelectors) {
            const input = await page.$(sel);
            if (input) {
              await input.click();
              await input.type('Work', {delay: 30});
              await page.keyboard.press('Enter');
              console.log('[>] Replied: Work');
              break;
            }
          }
        }
      }
      
      if (seen.size > 100) seen.clear();
      
    } catch(e) {
      // Silent continue
    }
    
    await page.waitForTimeout(2000);
  }
}

(async () => {
  let browser;
  try {
    browser = await launch();
    const page = await browser.newPage();
    
    await page.setViewport({width: 1920, height: 1080});
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36');
    
    // Stealth measures
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
      Object.defineProperty(navigator, 'plugins', {get: () => [1, 2, 3, 4, 5]});
      Object.defineProperty(navigator, 'languages', {get: () => ['en-US', 'en']});
      window.chrome = { runtime: {} };
      delete navigator.__proto__.webdriver;
    });
    
    const success = await login(page);
    if (success) {
      await watchChat(page);
    } else {
      console.log('[-] Login failed, exiting');
      await browser.close();
      process.exit(1);
    }
    
  } catch(err) {
    console.error('[-] CRASH:', err.message);
    if (browser) await browser.close();
    process.exit(1);
  }
})();
