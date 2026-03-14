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
  console.log('[*] Loading Snapchat login...');
  
  await page.goto('https://accounts.snapchat.com/accounts/login', { 
    waitUntil: 'networkidle0',
    timeout: 60000 
  });
  
  await page.waitForTimeout(8000);
  
  // Check for iframes
  const frames = page.frames();
  console.log(`[*] Found ${frames.length} frames`);
  
  let loginFrame = page;
  for (const frame of frames) {
    try {
      const hasForm = await frame.$('input[name="username"]') || await frame.$('input[type="text"]');
      if (hasForm) {
        console.log('[+] Found login frame');
        loginFrame = frame;
        break;
      }
    } catch(e) {}
  }
  
  // Username
  console.log('[*] Entering username...');
  await loginFrame.waitForSelector('input[name="username"], input[type="text"], input[id="username"]', {timeout: 20000});
  await loginFrame.type('input[name="username"], input[type="text"], input[id="username"]', EMAIL, {delay: 100});
  
  // TAB to password (human-like)
  await page.keyboard.press('Tab');
  await page.waitForTimeout(1000);
  
  // Try typing password with Tab focus
  console.log('[*] Entering password via Tab...');
  for (const char of PASSWORD) {
    await page.keyboard.sendCharacter(char);
    await page.waitForTimeout(50);
  }
  
  await page.waitForTimeout(1000);
  
  // Submit with Enter
  console.log('[*] Submitting...');
  await page.keyboard.press('Enter');
  
  await page.waitForTimeout(10000);
  
  const url = page.url();
  console.log(`[*] URL after login: ${url}`);
  
  if (!url.includes('login')) {
    console.log('[+] LOGIN SUCCESS');
    return true;
  }
  
  // Fallback: Look for password field again after username submit
  console.log('[*] Checking for password page...');
  const passInput = await page.$('input[type="password"]');
  if (passInput) {
    console.log('[+] Found password field on next page');
    await passInput.type(PASSWORD, {delay: 100});
    await page.keyboard.press('Enter');
    await page.waitForTimeout(8000);
    
    if (!page.url().includes('login')) {
      console.log('[+] LOGIN SUCCESS (2-step)');
      return true;
    }
  }
  
  throw new Error('Login failed');
}

async function watchChat(page) {
  console.log('[*] Opening web.snapchat.com...');
  await page.goto('https://web.snapchat.com/', { waitUntil: 'networkidle0', timeout: 60000 });
  await page.waitForTimeout(10000);
  
  console.log('[+] BOT ACTIVE');
  
  const seen = new Set();
  
  setInterval(async () => {
    try {
      const msgs = await page.$$eval('[data-testid="message-content"], .Message__body, div[dir="auto"]', 
        els => els.slice(-3).map((el, i) => ({
          id: i + '-' + el.innerText,
          text: el.innerText.trim(),
          mine: el.className.includes('outgoing')
        }))
      );
      
      for (const msg of msgs) {
        if (!msg.mine && msg.text === '.test' && !seen.has(msg.id)) {
          seen.add(msg.id);
          const input = await page.$('div[contenteditable="true"]');
          if (input) {
            await input.type('Work', {delay: 30});
            await page.keyboard.press('Enter');
            console.log('[>] Sent: Work');
          }
        }
      }
    } catch(e) {}
  }, 3000);
}

(async () => {
  let browser;
  try {
    browser = await launch();
    const page = await browser.newPage();
    await page.setViewport({width: 1920, height: 1080});
    
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
