const StealthBrowser = require('./stealth-browser');
const ProxyRotator = require('./proxy-rotator');

class DiscordAutomator {
  constructor() {
    this.browser = new StealthBrowser();
    this.proxyRotator = new ProxyRotator();
  }

  async login(email, password) {
    await this.proxyRotator.fetchProxies();
    const proxy = this.proxyRotator.getNext();
    
    console.log(`[*] Using proxy: ${proxy}`);
    const browser = await this.browser.launch(proxy);
    const page = await browser.newPage();
    
    try {
      await page.goto('https://discord.com/login', { waitUntil: 'networkidle0' });
      
      // Handle captcha if present
      await this.browser.solveCaptchas(page);
      
      await page.type('input[name="email"]', email, {delay: 50});
      await page.type('input[name="password"]', password, {delay: 50});
      await page.click('button[type="submit"]');
      
      await page.waitForTimeout(5000);
      
      // Check for captcha after submit
      await this.browser.solveCaptchas(page);
      
      if (page.url().includes('channels')) {
        console.log('[+] Discord login success');
        return { browser, page };
      }
      
      throw new Error('Login failed');
    } catch (err) {
      await browser.close();
      throw err;
    }
  }

  async sendMessage(page, channelId, message) {
    await page.goto(`https://discord.com/channels/@me/${channelId}`);
    await page.waitForTimeout(3000);
    
    await page.type('div[role="textbox"]', message, {delay: 30});
    await page.keyboard.press('Enter');
  }
}

module.exports = DiscordAutomator;
