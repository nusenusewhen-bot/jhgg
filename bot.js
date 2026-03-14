const StealthBrowser = require('./stealth-browser');
const ProxyRotator = require('./proxy-rotator');
const CaptchaSolver = require('./captcha-solver');
const DiscordAutomation = require('./discord-automation');

class MasterBot {
  constructor() {
    this.proxyRotator = new ProxyRotator();
    this.captcha = new CaptchaSolver();
  }

  async init() {
    await this.proxyRotator.fetchProxies();
    console.log(`[+] System ready with ${this.proxyRotator.proxies.length} proxies`);
  }

  async snapchatLogin(username, password) {
    const proxy = this.proxyRotator.getNext();
    const browser = new StealthBrowser();
    const page = await browser.launch(proxy);
    
    try {
      await page.goto('https://accounts.snapchat.com/accounts/login', { waitUntil: 'networkidle0' });
      
      // Solve any captcha
      const token = await this.captcha.solveHCaptcha(
        await page.evaluate(() => document.querySelector('[data-sitekey]')?.dataset.sitekey),
        page.url(),
        proxy
      );
      
      if (token) {
        await page.evaluate((t) => {
          document.querySelector('textarea[name="h-captcha-response"]').value = t;
        }, token);
      }

      await page.type('input[name="username"]', username, {delay: 50});
      await page.type('input[name="password"]', password, {delay: 50});
      await page.click('button[type="submit"]');
      
      await page.waitForTimeout(5000);
      
      if (!page.url().includes('login')) {
        console.log('[+] Snapchat logged in');
        return page;
      }
      throw new Error('Login failed');
    } catch (err) {
      await browser.close();
      throw err;
    }
  }

  async discordRaid(serverId, message, count = 10) {
    const discord = new DiscordAutomation();
    // Implementation from discord-automation.js
  }
}

module.exports = MasterBot;
