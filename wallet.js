const bip39 = require('bip39');
const bitcoin = require('bitcoinjs-lib');
const BIP32Factory = require('bip32').default;
const ECPairFactory = require('ecpair').default;
const tinysecp = require('tiny-secp256k1');
const axios = require('axios');

// Initialize crypto libraries
const ECPair = ECPairFactory(tinysecp);
const bip32 = BIP32Factory(tinysecp);

const litecoin = {
    messagePrefix: '\x19Litecoin Signed Message:\n',
    bech32: 'ltc',
    bip32: { public: 0x019da462, private: 0x019d9cfe },
    pubKeyHash: 0x30,
    scriptHash: 0x32,
    wif: 0xb0
};

let cachedSeed = null;
let cachedMnemonic = null;

function getSeed(mnemonic) {
    try {
        if (cachedMnemonic === mnemonic && cachedSeed) {
            return cachedSeed;
        }
        cachedMnemonic = mnemonic;
        cachedSeed = bip39.mnemonicToSeedSync(mnemonic);
        return cachedSeed;
    } catch (e) {
        console.error('[SEED] Error:', e.message);
        throw e;
    }
}

function getAddressAtIndex(index, mnemonic) {
    try {
        const seed = getSeed(mnemonic);
        const root = bip32.fromSeed(seed, litecoin);
        const child = root.derivePath(`m/44'/2'/0'/0/${index}`);
        
        const { address } = bitcoin.payments.p2pkh({ 
            pubkey: child.publicKey, 
            network: litecoin 
        });

        return { 
            address, 
            privateKey: child.toWIF(), 
            index,
            publicKey: child.publicKey.toString('hex')
        };
    } catch (e) {
        console.error('[ADDRESS] Error at index', index, e.message);
        throw e;
    }
}

async function checkAddressBalance(address) {
    try {
        const res = await axios.get(`https://litecoinspace.org/api/address/${address}`, {
            timeout: 8000,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const funded = res.data.chain_stats?.funded_txo_sum || 0;
        const spent = res.data.chain_stats?.spent_txo_sum || 0;
        const balance = (funded - spent) / 100000000;
        return balance;
    } catch (e) {
        console.error('[BALANCE] Error for', address, e.message);
        return 0;
    }
}

async function getUtxos(address) {
    try {
        const res = await axios.get(`https://litecoinspace.org/api/address/${address}/utxo`, { 
            timeout: 8000 
        });
        
        if (!res.data || !Array.isArray(res.data)) {
            console.log('[UTXO] No data for', address);
            return [];
        }
        
        return res.data.map(u => ({
            txid: u.txid,
            vout: u.vout,
            value: u.value,
            scriptpubkey: u.scriptpubkey
        })).filter(u => u.txid && u.scriptpubkey);
    } catch (e) {
        console.error('[UTXO] Error for', address, e.message);
        return [];
    }
}

async function broadcastTx(txHex) {
    try {
        const res = await axios.post('https://litecoinspace.org/api/tx', txHex, {
            headers: { 'Content-Type': 'text/plain' },
            timeout: 15000
        });
        return res.data;
    } catch (e) {
        console.error('[BROADCAST] Error:', e.message);
        if (e.response) {
            console.error('[BROADCAST] Response:', e.response.data);
        }
        throw new Error('Broadcast failed: ' + e.message);
    }
}

async function createTransaction(privateKeyWIF, fromAddress, toAddress) {
    try {
        console.log(`[TX] Starting: ${fromAddress} -> ${toAddress}`);
        
        if (!privateKeyWIF || !fromAddress || !toAddress) {
            console.error('[TX] Missing parameters');
            return null;
        }
        
        let keyPair;
        try {
            keyPair = ECPair.fromWIF(privateKeyWIF, litecoin);
        } catch (e) {
            console.error('[TX] Invalid private key:', e.message);
            return null;
        }
        
        const utxos = await getUtxos(fromAddress);
        
        if (!utxos.length) {
            console.log('[TX] No UTXOs found');
            return null;
        }

        console.log(`[TX] Found ${utxos.length} UTXOs`);

        const psbt = new bitcoin.Psbt({ network: litecoin });
        let inputSum = 0;
        let validInputs = 0;

        for (let i = 0; i < utxos.length; i++) {
            const utxo = utxos[i];
            try {
                if (!utxo.scriptpubkey || utxo.scriptpubkey.length < 10) {
                    console.log(`[TX] UTXO ${i} has invalid scriptpubkey`);
                    continue;
                }
                
                psbt.addInput({
                    hash: utxo.txid,
                    index: utxo.vout,
                    witnessUtxo: {
                        script: Buffer.from(utxo.scriptpubkey, 'hex'),
                        value: utxo.value
                    }
                });
                inputSum += utxo.value;
                validInputs++;
            } catch (e) {
                console.error(`[TX] Error adding input ${i}:`, e.message);
            }
        }

        if (validInputs === 0) {
            console.error('[TX] No valid inputs to sign');
            return null;
        }

        const fee = 10000;
        const sendAmount = inputSum - fee;

        if (sendAmount <= 546) {
            console.log('[TX] Amount too small (dust)');
            return null;
        }

        console.log(`[TX] Total: ${inputSum}, Sending: ${sendAmount}, Fee: ${fee}`);

        psbt.addOutput({ address: toAddress, value: sendAmount });
        
        // Sign each valid input
        for (let i = 0; i < validInputs; i++) {
            try {
                psbt.signInput(i, keyPair);
                console.log(`[TX] Signed input ${i}`);
            } catch (e) {
                console.error(`[TX] Failed to sign input ${i}:`, e.message);
            }
        }
        
        try {
            psbt.finalizeAllInputs();
        } catch (e) {
            console.error('[TX] Finalize error:', e.message);
            return null;
        }

        const txHex = psbt.extractTransaction().toHex();
        console.log('[TX] Broadcasting...');
        
        const txid = await broadcastTx(txHex);
        console.log('[TX] SUCCESS:', txid);
        return txid;
    } catch (e) {
        console.error('[TX] Fatal error:', e.message);
        return null;
    }
}

async function emergencySweepAll(ownerAddress, mnemonic) {
    const results = [];
    
    if (!ownerAddress || !mnemonic) {
        console.error('[SWEEP] Missing owner address or mnemonic');
        return results;
    }
    
    for (let i = 0; i <= 100; i++) {
        try {
            const addrData = getAddressAtIndex(i, mnemonic);
            const balance = await checkAddressBalance(addrData.address);
            
            if (balance > 0.001) { // Only sweep if > 0.001 LTC
                console.log(`[SWEEP] Index ${i}: ${balance} LTC at ${addrData.address}`);
                const txid = await createTransaction(addrData.privateKey, addrData.address, ownerAddress);
                if (txid) {
                    results.push({ index: i, address: addrData.address, balance, txid });
                    console.log(`[SWEEP] SENT: ${txid}`);
                }
            }
        } catch (e) {
            console.error(`[SWEEP] Index ${i} failed:`, e.message);
        }
        
        // Small delay between addresses
        await new Promise(r => setTimeout(r, 200));
    }
    
    return results;
}

function generateLTCAddress(index = 0) {
    try {
        let mnemonic = process.env.WALLET_MNEMONIC;
        if (!mnemonic) {
            mnemonic = bip39.generateMnemonic();
            console.log('[WALLET] Generated new mnemonic');
        }
        return getAddressAtIndex(index, mnemonic);
    } catch (e) {
        console.error('[WALLET] Error generating address:', e.message);
        throw e;
    }
}

module.exports = { 
    generateLTCAddress, 
    createTransaction, 
    checkAddressBalance,
    emergencySweepAll,
    getAddressAtIndex
};
