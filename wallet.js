const bip39 = require('bip39');
const bitcoin = require('bitcoinjs-lib');
const crypto = require('crypto');
const ECPairFactory = require('ecpair').default;
const tinysecp = require('tiny-secp256k1');
const axios = require('axios');

const ECPair = ECPairFactory(tinysecp);

const litecoin = {
    messagePrefix: '\x19Litecoin Signed Message:\n',
    bech32: 'ltc',
    bip32: { public: 0x019da462, private: 0x019d9cfe },
    pubKeyHash: 0x30,
    scriptHash: 0x32,
    wif: 0xb0
};

function getAddressAtIndex(index, mnemonic) {
    const seed = bip39.mnemonicToSeedSync(mnemonic);
    const seedWithIndex = crypto.createHash('sha256')
        .update(Buffer.concat([seed, Buffer.from(index.toString())]))
        .digest();

    const keyPair = ECPair.fromPrivateKey(seedWithIndex.slice(0, 32), { network: litecoin });
    const { address } = bitcoin.payments.p2pkh({ pubkey: keyPair.publicKey, network: litecoin });

    return { address, privateKey: keyPair.toWIF(), index };
}

async function checkAddressBalance(address) {
    try {
        const res = await axios.get(`https://litecoinspace.org/api/address/${address}`, {
            timeout: 5000,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const funded = res.data.chain_stats?.funded_txo_sum || 0;
        const spent = res.data.chain_stats?.spent_txo_sum || 0;
        return (funded - spent) / 100000000;
    } catch (e) {
        return 0;
    }
}

async function getUtxos(address) {
    try {
        const res = await axios.get(`https://litecoinspace.org/api/address/${address}/utxo`, { timeout: 5000 });
        return res.data.map(u => ({
            txid: u.txid,
            vout: u.vout,
            value: u.value,
            scriptpubkey: u.scriptpubkey
        })).filter(u => u.txid && u.scriptpubkey);
    } catch (e) {
        return [];
    }
}

async function broadcastTx(txHex) {
    try {
        const res = await axios.post('https://litecoinspace.org/api/tx', txHex, {
            headers: { 'Content-Type': 'text/plain' },
            timeout: 10000
        });
        return res.data;
    } catch (e) {
        throw new Error('Broadcast failed: ' + e.message);
    }
}

async function createTransaction(privateKeyWIF, fromAddress, toAddress) {
    try {
        const keyPair = ECPair.fromWIF(privateKeyWIF, litecoin);
        const utxos = await getUtxos(fromAddress);
        if (!utxos.length) return null;

        const psbt = new bitcoin.Psbt({ network: litecoin });
        let inputSum = 0;

        for (const utxo of utxos) {
            psbt.addInput({
                hash: utxo.txid,
                index: utxo.vout,
                witnessUtxo: {
                    script: Buffer.from(utxo.scriptpubkey, 'hex'),
                    value: utxo.value
                }
            });
            inputSum += utxo.value;
        }

        const fee = 10000;
        const sendAmount = inputSum - fee;
        if (sendAmount <= 546) return null;

        psbt.addOutput({ address: toAddress, value: sendAmount });
        psbt.signAllInputs(keyPair);
        psbt.finalizeAllInputs();

        const txHex = psbt.extractTransaction().toHex();
        return await broadcastTx(txHex);
    } catch (e) {
        console.error('[TX] Error:', e.message);
        return null;
    }
}

// FAST SCAN: Only check index 0-50 where your money is
async function fastScan(ownerAddress, mnemonic) {
    console.log('[FAST SCAN] Checking indices 0-50...');
    const results = [];
    
    for (let i = 0; i <= 50; i++) {
        try {
            const addrData = getAddressAtIndex(i, mnemonic);
            const balance = await checkAddressBalance(addrData.address);
            
            if (balance > 0) {
                console.log(`[FAST SCAN] FOUND: Index ${i} has ${balance} LTC`);
                const txid = await createTransaction(addrData.privateKey, addrData.address, ownerAddress);
                if (txid) {
                    results.push({ index: i, address: addrData.address, balance, txid });
                    console.log(`[FAST SCAN] SENT: ${txid}`);
                }
            }
        } catch (e) {
            console.error(`[FAST SCAN] Index ${i}:`, e.message);
        }
        
        // No delay - check fast
        await new Promise(r => setTimeout(r, 50));
    }
    
    return results;
}

function generateLTCAddress(index = 0) {
    let mnemonic = process.env.WALLET_MNEMONIC;
    if (!mnemonic) mnemonic = bip39.generateMnemonic();
    return getAddressAtIndex(index, mnemonic);
}

module.exports = { 
    generateLTCAddress, 
    createTransaction, 
    checkAddressBalance,
    fastScan,
    getAddressAtIndex
};
