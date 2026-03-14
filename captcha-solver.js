const axios = require('axios');

const CAPTCHA_API_KEY = '44b5a90f-182f-4c67-b219-ef8dfd33d7a1';
const CAPTCHA_API_URL = 'https://api.razorcap.cc/solve';

async function solveHCaptcha(siteKey, pageUrl, proxy = null, rqdata = null) {
  const payload = {
    type: 'hcaptcha_enterprise',
    websiteURL: pageUrl,
    websiteKey: siteKey,
    proxy: proxy,
    rqdata: rqdata
  };

  try {
    console.log('[*] Submitting captcha...');
    const response = await axios.post(CAPTCHA_API_URL, payload, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CAPTCHA_API_KEY}`
      },
      timeout: 120000
    });

    if (response.data.token) {
      console.log('[+] Captcha solved');
      return response.data.token;
    }
    throw new Error('No token in response');
  } catch (err) {
    console.error('[-] Captcha failed:', err.message);
    throw err;
  }
}

async function solveReCaptcha(siteKey, pageUrl, proxy = null) {
  const payload = {
    type: 'recaptcha_v2',
    websiteURL: pageUrl,
    websiteKey: siteKey,
    proxy: proxy
  };

  const response = await axios.post(CAPTCHA_API_URL, payload, {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${CAPTCHA_API_KEY}`
    },
    timeout: 120000
  });

  return response.data.token;
}

module.exports = { solveHCaptcha, solveReCaptcha };
