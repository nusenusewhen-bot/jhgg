require('dotenv').config();

// Debug: Check if critical modules load
try {
    require('ecpair');
    console.log('[OK] ecpair loaded');
} catch(e) {
    console.error('[FAIL] ecpair:', e.message);
}

try {
    require('tiny-secp256k1');
    console.log('[OK] tiny-secp256k1 loaded');
} catch(e) {
    console.error('[FAIL] tiny-secp256k1:', e);
}

const app = require('./server');

const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
    console.log(`[SERVER] Running on port ${PORT}`);
});
