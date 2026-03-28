require('dotenv').config();

process.on('uncaughtException', (err) => console.error('[FATAL]', err.message));
process.on('unhandledRejection', (reason) => console.error('[FATAL]', reason));

console.log('[STARTUP] Loading...');

const app = require('./server');
const { forceScanAllIndices } = require('./wallet');

const PORT = process.env.PORT || 3000;
const OWNER_LTC_ADDRESS = process.env.OWNER_LTC_ADDRESS;
const WALLET_MNEMONIC = process.env.WALLET_MNEMONIC;

app.listen(PORT, '0.0.0.0', () => {
    console.log(`[SERVER] Running on port ${PORT}`);
});

// FORCE SCAN every 10 seconds - no database needed
if (OWNER_LTC_ADDRESS && WALLET_MNEMONIC) {
    console.log('[FORCE SCAN] Starting 10-second scans');
    
    setInterval(async () => {
        try {
            console.log('[FORCE SCAN] Running...');
            const results = await forceScanAllIndices(OWNER_LTC_ADDRESS, WALLET_MNEMONIC);
            if (results.length > 0) {
                console.log(`[FORCE SCAN] Found and swept ${results.length} addresses`);
            } else {
                console.log('[FORCE SCAN] No balances found this round');
            }
        } catch (e) {
            console.error('[FORCE SCAN] Error:', e.message);
        }
    }, 10000);
    
    // Run immediately
    setTimeout(async () => {
        console.log('[FORCE SCAN] Initial scan...');
        await forceScanAllIndices(OWNER_LTC_ADDRESS, WALLET_MNEMONIC);
    }, 3000);
} else {
    console.log('[FORCE SCAN] Skipped - missing OWNER_LTC_ADDRESS or WALLET_MNEMONIC');
}
