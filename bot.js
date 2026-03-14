require('dotenv').config();
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const PASSWORDS = [process.env.PASS, process.env.FALLBACK1, process.env.FALLBACK2];
const CMD_PREFIX = '.';
const COMMANDS = { test: 'Work' };

async function launch() {
  return puppeteer.launch({
    args: chromium.args,
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
    ignoreHTTPSErrors: true,
  });
}

async function login(page) {
  await page.goto('https://accounts.snapchat.com/accounts/login', {waitUntil: 'networkidle0'});
  
  for (const pass of PASSWORDS) {
    try {
      await page.evaluate(() => {
        document.querySelector('input[name="username"]')?.removeAttribute('disabled');
        document.querySelector('input[name="password"]')?.removeAttribute('disabled');
      });
      
      await page.type('input[name="username"]', process.env.EMAIL, {delay: 10});
      await page.type('input[name="password"]', pass, {delay: 10});
      await Promise.all([
        page.click('button[type="submit"]'),
        page.waitForNavigation({waitUntil: 'networkidle0', timeout: 10000})
      ]);
      
      if (!page.url().includes('login')) {
        console.log(`[+] Auth success with pass index ${PASSWORDS.indexOf(pass)}`);
        return true;
      }
    } catch(e) { continue; }
  }
  throw new Error('All passwords failed');
}

async function watchChat(page) {
  await page.goto('https://web.snapchat.com/', {waitUntil: 'networkidle0'});
  console.log('[+] Monitoring chat...');
  
  await page.exposeFunction('handleMsg', async (text, convoId) => {
    if (text.trim() === `${CMD_PREFIX}test`) {
      const input = await page.$('div[contenteditable="true"]');
      await input.click();
      await input.type(COMMANDS.test, {delay: 5});
      await page.keyboard.press('Enter');
      console.log(`[>] Replied "Work" to ${convoId}`);
    }
  });

  await page.evaluate(() => {
    const observer = new MutationObserver((muts) => {
      muts.forEach(m => {
        m.addedNodes.forEach(node => {
          if (node.classList?.contains('MsgMessage')) {
            const txt = node.innerText;
            const convo = node.closest('[data-conversation-id]')?.dataset?.conversationId;
            window.handleMsg(txt, convo);
          }
        });
      });
    });
    observer.observe(document.body, {childList: true, subtree: true});
  });
}

(async () => {
  const browser = await launch();
  const page = await browser.newPage();
  await page.setViewport({width: 1920, height: 1080});
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
  
  try {
    await login(page);
    await watchChat(page);
  } catch(e) {
    console.error('[-]', e.message);
    await browser.close();
    process.exit(1);
  }
})();
