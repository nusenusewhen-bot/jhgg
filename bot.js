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
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding'
    ],
    headless: false,
    ignoreHTTPSErrors: true
  });
}

async function login(page) {
  console.log('[*] Starting fresh login...');
  
  // Clear cookies
  await page.deleteCookie(...await page.cookies());
  
  await page.goto('https://accounts.snapchat.com/accounts/login', { 
    waitUntil: 'domcontentloaded',
    timeout: 60000 
  });
  
  // Wait for React to render
  await page.waitForTimeout(10000);
  
  // Get all inputs
  const inputs = await page.$$('input');
  console.log(`[*] Found ${inputs.length} inputs`);
  
  if (inputs.length < 2) {
    throw new Error('Not enough input fields detected');
  }
  
  // First input = username
  console.log('[*] Clicking username field...');
  await inputs[0].click();
  await page.waitForTimeout(500);
  await inputs[0].type(EMAIL, {delay: 150});
  
  await page.waitForTimeout(2000);
  
  // Second input = password
  console.log('[*] Clicking password field...');
  await inputs[1].click();
  await page.waitForTimeout(500);
  await inputs[1].type(PASSWORD, {delay: 150});
  
  await page.waitForTimeout(2000);
  
  // Find button
  const buttons = await page.$$('button');
  console.log(`[*] Found ${buttons.length} buttons`);
  
  for (const btn of buttons) {
    const text = await page.evaluate(el => el.innerText || el.value || '', btn);
    console.log(`  - Button: "${text}"`);
    if (text.toLowerCase().includes('log') || text.toLowerCase().includes('sign')) {
      console.log('[*] Clicking login button...');
      await btn.click();
      break;
    }
  }
  
  // Wait for navigation
  await page.waitForTimeout(15000);
  
  const url = page.url();
  console.log(`[*] Final URL: ${url}`);
  
  // Check for success indicators
  const body = await page.evaluate(() => document.body.innerText);
  
  if (url.includes('web.snapchat.com') || body.includes('Snapchat Web')) {
    console.log('[+] LOGIN SUCCESS');
    return true;
  }
  
  if (body.includes('Verify') || body.includes('verification')) {
    console.log('[!] Verification required - check phone');
    return false;
  }
  
  if (body.includes('incorrect') || body.includes('wrong')) {
    console.log('[-] Wrong password');
    return false;
  }
  
  // Try one more time with Enter key
  console.log('[*] Retrying with Enter key...');
  await inputs[1].press('Enter');
  await page.waitForTimeout(10000);
  
  if (!page.url().includes('login')) {
    console.log('[+] LOGIN SUCCESS (retry)');
    return true;
  }
  
  throw new Error('Login blocked by Snapchat');
}

async function watchChat(page) {
  console.log('[*] Loading web.snapchat.com...');
  await page.goto('https://web.snapchat.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(15000);
  
  console.log('[+] BOT ACTIVE - .test commands enabled');
  
  const seen = new Set();
  
  while (true) {
    try {
      const msgs = await page.$$eval('[data-testid="message-content"], .Message__body, div[dir="auto"], span', 
        els => els.slice(-5).map((el, i) => ({
          id: i + '-' + el.innerText,
          text: el.innerText.trim(),
          mine: el.className.includes('outgoing') || el.getAttribute('data-self') === 'true'
        }))
      );
      
      for (const msg of msgs) {
        if (!msg.mine && msg.text === '.test' && !seen.has(msg.id)) {
          seen.add(msg.id);
          console.log('[+] Command detected');
          
          const inputs = await page.$$('div[contenteditable="true"]');
          if (inputs.length > 0) {
            await inputs[inputs.length-1].type('Work', {delay: 50});
            await page.keyboard.press('Enter');
            console.log('[>] Replied: Work');
          }
        }
      }
      
      if (seen.size > 50) seen.clear();
    } catch(e) {}
    
    await page.waitForTimeout(2500);
  }
}

(async () => {
  let browser;
  try {
    browser = await launch();
    const page = await browser.newPage();
    
    await page.setViewport({width: 1920, height: 1080});
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0');
    
    // Heavy stealth
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
      Object.defineProperty(navigator, 'plugins', {get: () => [1, 2, 3, 4, 5]});
      Object.defineProperty(navigator, 'languages', {get: () => ['en-US', 'en', 'es']});
      Object.defineProperty(screen, 'width', {get: () => 1920});
      Object.defineProperty(screen, 'height', {get: () => 1080});
      window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {}, app: {} };
      delete navigator.__proto__.webdriver;
    });
    
    const success = await login(page);
    if (success) {
      await watchChat(page);
    } else {
      await browser.close();
      process.exit(1);
    }
    
  } catch(err) {
    console.error('[-] FATAL:', err.message);
    if (browser) await browser.close();
    process.exit(1);
  }
})();
