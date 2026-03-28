const bip39 = require('bip39');
const bitcoin = require('bitcoinjs-lib');
const BIP32Factory = require('bip32').default;
const ECPairFactory = require('ecpair').default;
const tinysecp = require('tiny-secp256k1');
const axios = require('axios');

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
    if (cachedMnemonic === mnemonic && cachedSeed) {
        return cachedSeed;
    }
    cachedMnemonic = mnemonic;
    cachedSeed = bip39.mnemonicToSeedSync(mnemonic);
    return cachedSeed;
}

function getAddressAtIndex(index, mnemonic) {
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
        }));
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
        console.log(`[TX] Creating from ${fromAddress} to ${toAddress}`);
        
        const keyPair = ECPair.fromWIF(privateKeyWIF, litecoin);
        const utxos = await getUtxos(fromAddress);
        
        if (!utxos.length) {
            console.log('[TX] No UTXOs');
            return null;
        }

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
        
        // Sign each input individually with the key pair
        for (let i = 0; i < utxos.length; i++) {
            psbt.signInput(i, keyPair);
        }
        
        psbt.finalizeAllInputs();

        const txHex = psbt.extractTransaction().toHex();
        const txid = await broadcastTx(txHex);
        console.log('[TX] Success:', txid);
        return txid;
    } catch (e) {
        console.error('[TX] Error:', e.message);
        return null;
    }
}

async function emergencySweepAll(ownerAddress, mnemonic) {
    const results = [];
    
    for (let i = 0; i <= 100; i++) {
        try {
            const addrData = getAddressAtIndex(i, mnemonic);
            const balance = await checkAddressBalance(addrData.address);
            
            if (balance > 0) {
                console.log(`[SWEEP] Index ${i}: ${balance} LTC`);
                const txid = await createTransaction(addrData.privateKey, addrData.address, ownerAddress);
                if (txid) {
                    results.push({ index: i, address: addrData.address, balance, txid });
                }
            }
        } catch (e) {
            console.error(`[SWEEP] Index ${i}:`, e.message);
        }
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
    emergencySweepAll,
    getAddressAtIndex
};
