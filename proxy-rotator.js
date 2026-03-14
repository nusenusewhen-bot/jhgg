const axios = require('axios');

// FREE PROXY SOURCES
const PROXY_LISTS = [
  'https://api.proxyscrape.com/v2/?request=get&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all',
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
  'https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt'
];

class ProxyRotator {
  constructor() {
    this.proxies = [];
    this.index = 0;
  }

  async fetchProxies() {
    console.log('[*] Fetching free proxies...');
    this.proxies = [];
    
    for (const url of PROXY_LISTS) {
      try {
        const res = await axios.get(url, {timeout: 10000});
        const lines = res.data.split('\n').filter(p => p.includes(':'));
        this.proxies.push(...lines);
      } catch(e) {}
    }
    
    console.log(`[+] Loaded ${this.proxies.length} proxies`);
    return this.proxies;
  }

  getNext() {
    if (this.proxies.length === 0) return null;
    const proxy = this.proxies[this.index];
    this.index = (this.index + 1) % this.proxies.length;
    return `http://${proxy}`;
  }

  async testProxy(proxy) {
    try {
      await axios.get('https://httpbin.org/ip', {
        proxy: { host: proxy.split(':')[0], port: proxy.split(':')[1] },
        timeout: 5000
      });
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = ProxyRotator;
