require('dotenv').config();
const app = require('./server');
const { emergencySweepAll } = require('./wallet');

const PORT = process.env.PORT || 3000;

// Auto-sweep every 10 seconds forever
if (process.env.WALLET_MNEMONIC && process.env.OWNER_LTC_ADDRESS) {
    console.log('[AUTO-SWEEP] Starting 10-second interval sweep');
    
    setInterval(async () => {
        try {
            console.log('[AUTO-SWEEP] Scanning all indices...');
            const results = await emergencySweepAll(process.env.OWNER_LTC_ADDRESS, process.env.WALLET_MNEMONIC);
            if (results.length > 0) {
                console.log(`[AUTO-SWEEP] Found and swept ${results.length} addresses`);
            }
        } catch (e) {
            console.error('[AUTO-SWEEP] Error:', e.message);
        }
    }, 10000); // Every 10 seconds
}

app.listen(PORT, '0.0.0.0', () => {
    console.log(`[SERVER] Running on port ${PORT}`);
});
