const puppeteer = require('puppeteer');
const config = require('./config.json');

async function loginSnapchat() {
  const browser = await puppeteer.launch({ headless: false });
  const page = await browser.newPage();
  
  await page.goto('https://accounts.snapchat.com/accounts/login');
  
  for (let pass of config.credentials.passwords) {
    try {
      await page.type('input[name="username"]', config.credentials.email);
      await page.type('input[name="password"]', pass);
      await page.click('button[type="submit"]');
      await page.waitForTimeout(3000);
      
      if (!await page.$('text/Incorrect password')) {
        console.log('Login successful');
        return { browser, page };
      }
    } catch (e) {
      continue;
    }
  }
  return null;
}

async function monitorMessages(page) {
  await page.goto('https://web.snapchat.com/');
  
  setInterval(async () => {
    const messages = await page.$$eval('.message-text', msgs => 
      msgs.map(m => ({ text: m.innerText, user: m.closest('.conversation')?.dataset?.user }))
    );
    
    for (let msg of messages) {
      if (msg.text.startsWith(config.prefix + 'test')) {
        await page.type('input[placeholder="Send a chat"]', config.commands.test);
        await page.keyboard.press('Enter');
      }
    }
  }, 2000);
}

(async () => {
  const session = await loginSnapchat();
  if (session) await monitorMessages(session.page);
})();
