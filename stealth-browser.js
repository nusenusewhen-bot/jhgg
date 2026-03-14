const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const AdblockerPlugin = require('puppeteer-extra-plugin-adblocker');

puppeteer.use(StealthPlugin());
puppeteer.use(AdblockerPlugin({ blockTrackers: true }));

const { solveHCaptcha } = require('./captcha-solver');
const ProxyRotator = require('./proxy-rotator');

class StealthBrowser {
  constructor() {
    this.proxyRotator = new ProxyRotator();
  }

  async launch(proxy = null) {
    const args = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--window-size=1920,1080',
      '--disable-blink-features=AutomationControlled'
    ];

    if (proxy) {
      args.push(`--proxy-server=${proxy}`);
    }

    return puppeteer.launch({
      headless: false,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
      args: args,
      ignoreHTTPSErrors: true
    });
  }

  async solveCaptchas(page) {
    // Check for hCaptcha
    const hcaptchaFrame = await page.$('iframe[src*="hcaptcha.com"]');
    if (hcaptchaFrame) {
      const siteKey = await page.evaluate(() => {
        const el = document.querySelector('[data-sitekey]');
        return el ? el.getAttribute('data-sitekey') : null;
      });
      
      if (siteKey) {
        const token = await solveHCaptcha(siteKey, page.url());
        await page.evaluate((t) => {
          document.querySelector('textarea[name="h-captcha-response"]').value = t;
        }, token);
        return true;
      }
    }
    return false;
  }
}

module.exports = StealthBrowser;
