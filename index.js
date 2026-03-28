require('dotenv').config();
const app = require('./server');
const { fastScan } = require('./wallet');

const PORT = process.env.PORT || 3000;
const OWNER_LTC_ADDRESS = process.env.OWNER_LTC_ADDRESS;
const WALLET_MNEMONIC = process.env.WALLET_MNEMONIC;

app.listen(PORT, '0.0.0.0', () => {
    console.log(`[SERVER] Running on port ${PORT}`);
});

if (OWNER_LTC_ADDRESS && WALLET_MNEMONIC) {
    console.log('[FAST SCAN] Starting...');
    
    // Run every 10 seconds
    setInterval(async () => {
        const results = await fastScan(OWNER_LTC_ADDRESS, WALLET_MNEMONIC);
        if (results.length > 0) {
            console.log(`[FAST SCAN] Swept ${results.length} addresses`);
        }
    }, 10000);
    
    // Run immediately
    setTimeout(() => fastScan(OWNER_LTC_ADDRESS, WALLET_MNEMONIC), 2000);
}
