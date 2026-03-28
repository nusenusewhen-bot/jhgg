require('dotenv').config();

// Global error handlers to prevent crash
process.on('uncaughtException', (err) => {
    console.error('[FATAL] Uncaught Exception:', err.message);
    console.error(err.stack);
    // Don't exit - keep running
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[FATAL] Unhandled Rejection at:', promise, 'reason:', reason);
    // Don't exit - keep running
});

// Debug module loading
console.log('[STARTUP] Loading modules...');

try {
    require('axios');
    console.log('[OK] axios');
} catch(e) { console.error('[FAIL] axios:', e.message); }

try {
    require('bip32');
    console.log('[OK] bip32');
} catch(e) { console.error('[FAIL] bip32:', e.message); }

try {
    require('bip39');
    console.log('[OK] bip39');
} catch(e) { console.error('[FAIL] bip39:', e.message); }

try {
    require('bitcoinjs-lib');
    console.log('[OK] bitcoinjs-lib');
} catch(e) { console.error('[FAIL] bitcoinjs-lib:', e.message); }

try {
    require('ecpair');
    console.log('[OK] ecpair');
} catch(e) { console.error('[FAIL] ecpair:', e.message); }

try {
    require('tiny-secp256k1');
    console.log('[OK] tiny-secp256k1');
} catch(e) { console.error('[FAIL] tiny-secp256k1:', e.message); }

// Load app with error wrapping
let app;
try {
    app = require('./server');
    console.log('[OK] server loaded');
} catch(e) {
    console.error('[FAIL] server load:', e.message, e.stack);
    // Create minimal app for health check
    const express = require('express');
    app = express();
    app.get('/health', (req, res) => res.status(200).send('OK - Fallback'));
    app.get('/', (req, res) => res.send('Server loading...'));
}

const PORT = process.env.PORT || 3000;

// Start server with error handling
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[SERVER] Running on port ${PORT}`);
});

server.on('error', (err) => {
    console.error('[SERVER ERROR]', err.message);
});

// Load wallet and start sweep only after server is up
setTimeout(() => {
    try {
        const { emergencySweepAll } = require('./wallet');
        
        if (process.env.WALLET_MNEMONIC && process.env.OWNER_LTC_ADDRESS) {
            console.log('[AUTO-SWEEP] Starting 10-second interval');
            
            setInterval(async () => {
                try {
                    console.log('[AUTO-SWEEP] Scanning...');
                    const results = await emergencySweepAll(process.env.OWNER_LTC_ADDRESS, process.env.WALLET_MNEMONIC);
                    if (results.length > 0) {
                        console.log(`[AUTO-SWEEP] Swept ${results.length} addresses`);
                    }
                } catch (e) {
                    console.error('[AUTO-SWEEP] Error:', e.message);
                }
            }, 10000);
        } else {
            console.log('[AUTO-SWEEP] Skipped - missing env vars');
        }
    } catch(e) {
        console.error('[AUTO-SWEEP] Failed to load:', e.message);
    }
}, 5000); // Start sweep 5 seconds after server
