const axios = require('axios');

let cachedPrice = 0;
let lastPriceUpdate = 0;

async function getLTCToUSD() {
    const now = Date.now();
    // Cache for 5 minutes
    if (cachedPrice && (now - lastPriceUpdate < 300000)) {
        return cachedPrice;
    }
    
    try {
        // Using CoinGecko API
        const res = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=litecoin&vs_currencies=usd', {
            timeout: 10000
        });
        cachedPrice = res.data.litecoin.usd;
        lastPriceUpdate = now;
        return cachedPrice;
    } catch (err) {
        console.error('[PRICE] Failed to fetch LTC price:', err.message);
        // Fallback price if API fails
        return cachedPrice || 85.00;
    }
}

async function getBalance(address) {
    try {
        const res = await axios.get(`https://api.blockcypher.com/v1/ltc/main/addrs/${address}/balance`, {
            timeout: 10000
        });
        return {
            balance: res.data.balance / 100000000,
            unconfirmed: res.data.unconfirmed_balance / 100000000
        };
    } catch (err) {
        throw new Error('Balance check failed: ' + err.message);
    }
}

async function sendExcessToOwner(privateKeyWIF, fromAddress, amountLTC, ownerAddress) {
    // This requires implementing LTC transaction creation and broadcasting
    // For now, log it - you'll need to implement actual transaction signing
    console.log(`[EXCESS] Would send ${amountLTC} LTC from ${fromAddress} to owner ${ownerAddress}`);
    console.log(`[EXCESS] Private key available for signing: ${privateKeyWIF.substring(0, 10)}...`);
    
    // TODO: Implement actual LTC transaction using bitcoinjs-lib with Litecoin network
    // This is a placeholder - real implementation needs UTXO fetching, transaction building, signing, and broadcasting
    
    return { txid: 'pending-implementation' };
}

module.exports = { getBalance, getLTCToUSD, sendExcessToOwner };
