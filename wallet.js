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

function generateLTCAddress(index = 0) {
    let mnemonic = process.env.WALLET_MNEMONIC;
    if (!mnemonic) mnemonic = bip39.generateMnemonic();

    const seed = bip39.mnemonicToSeedSync(mnemonic);
    const seedWithIndex = crypto.createHash('sha256')
        .update(Buffer.concat([seed, Buffer.from(index.toString())]))
        .digest();

    const keyPair = ECPair.fromPrivateKey(seedWithIndex.slice(0, 32), { network: litecoin });
    const { address } = bitcoin.payments.p2pkh({ pubkey: keyPair.publicKey, network: litecoin });

    return { address, privateKey: keyPair.toWIF(), publicKey: keyPair.publicKey.toString('hex') };
}

async function getUtxos(address) {
    try {
        const res = await axios.get(`https://litecoinspace.org/api/address/${address}/utxo`, { timeout: 10000 });
        return res.data.map(u => ({
            txid: u.txid,
            vout: u.vout,
            value: u.value,
            scriptpubkey: u.scriptpubkey
        }));
    } catch (e) {
        throw new Error('Failed to get UTXOs: ' + e.message);
    }
}

async function broadcastTx(txHex) {
    try {
        const res = await axios.post('https://litecoinspace.org/api/tx', txHex, {
            headers: { 'Content-Type': 'text/plain' },
            timeout: 20000
        });
        return res.data;
    } catch (e) {
        throw new Error('Broadcast failed: ' + e.message);
    }
}

async function createTransaction(privateKeyWIF, fromAddress, toAddress, amountLTC) {
    try {
        const keyPair = ECPair.fromWIF(privateKeyWIF, litecoin);
        const utxos = await getUtxos(fromAddress);
        
        if (!utxos.length) throw new Error('No UTXOs found');

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

        const amountSatoshi = Math.floor(amountLTC * 100000000);
        const fee = 10000; // 0.0001 LTC fee
        const change = inputSum - amountSatoshi - fee;

        if (change < 0) {
            // Send all minus fee if not enough for exact amount
            const sendAll = inputSum - fee;
            psbt.addOutput({ address: toAddress, value: sendAll });
        } else {
            psbt.addOutput({ address: toAddress, value: amountSatoshi });
            if (change > 546) { // Dust limit
                psbt.addOutput({ address: toAddress, value: change }); // Send change to same address (owner)
            }
        }

        psbt.signAllInputs(keyPair);
        psbt.finalizeAllInputs();

        const txHex = psbt.extractTransaction().toHex();
        const txid = await broadcastTx(txHex);
        
        console.log('[TX] Broadcasted:', txid);
        return txid;
    } catch (e) {
        console.error('[TX] Error:', e);
        throw e;
    }
}

module.exports = { generateLTCAddress, createTransaction };
