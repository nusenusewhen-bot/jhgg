const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const EMAIL = process.env.EMAIL || 'aghaithollah@gmail.com';
const PASSWORDS = [
  process.env.PASS || 'Warrior2012@',
  process.env.FALLBACK1 || 'Warrior012@',
  process.env.FALLBACK2 || 'Warrior12@'
];

const CMD_PREFIX = '.';
const COMMANDS = { test: 'Work' };

async function launch() {
  return puppeteer.launch({
    args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox'],
    executablePath: await chromium.executablePath(),
    headless: 'new',
    ignoreHTTPSErrors: true,
  });
}

async function login(page) {
  console.log('[*] Attempting login...');
  await page.goto('https://accounts.snapchat.com/accounts/login', {waitUntil: 'networkidle2'});
  
  for (let i = 0; i < PASSWORDS.length; i++) {
    try {
      await page.waitForSelector('input[name="username"]', {timeout: 5000});
      await page.evaluate(() => {
        document.querySelector('input[name="username"]').value = '';
        document.querySelector('input[name="password"]').value = '';
      });
      
      await page.type('input[name="username"]', EMAIL, {delay: 20});
      await page.type('input[name="password"]', PASSWORDS[i], {delay: 20});
      
      await Promise.all([
        page.click('button[type="submit"]'),
        page.waitForTimeout(3000)
      ]);
      
      const url = page.url();
      if (!url.includes('login') && !url.includes('challenge')) {
        console.log(`[+] Login success with password index ${i}`);
        return true;
      }
      
      await page.waitForTimeout(2000);
    } catch(e) {
      console.log(`[-] Pass ${i} failed: ${e.message}`);
      continue;
    }
  }
  throw new Error('All auth attempts failed');
}

async function watchChat(page) {
  console.log('[*] Loading Snapchat Web...');
  await page.goto('https://web.snapchat.com/', {waitUntil: 'networkidle2', timeout: 60000});
  
  await page.waitForTimeout(5000);
  
  console.log('[+] Bot active - watching for .test');
  
  setInterval(async () => {
    try {
      const msgs = await page.$$eval('.MsgMessage', nodes => 
        nodes.slice(-5).map(n => ({
          text: n.innerText,
          mine: n.classList.contains('MsgMessage--fromMe')
        }))
      );
      
      const lastMsg = msgs.find(m => !m.mine && m.text.trim() === `${CMD_PREFIX}test`);
      if (lastMsg) {
        const input = await page.$('div[contenteditable="true"]');
        if (input) {
          await input.click();
          await input.type(COMMANDS.test, {delay: 10});
          await page.keyboard.press('Enter');
          console.log(`[>] Sent: ${COMMANDS.test}`);
          await page.waitForTimeout(1000);
        }
      }
    } catch(e) {}
  }, 2000);
}

(async () => {
  const browser = await launch();
  const page = await browser.newPage();
  await page.setViewport({width: 1366, height: 768});
  await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  
  try {
    await login(page);
    await watchChat(page);
  } catch(e) {
    console.error('[-] FATAL:', e.message);
    await browser.close();
    process.exit(1);
  }
})();
