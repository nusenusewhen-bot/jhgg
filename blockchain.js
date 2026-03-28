const axios = require('axios');
const bitcoin = require('bitcoinjs-lib');
const litecoin = bitcoin.networks.litecoin;

const EXPLORER_API = 'https://litecoinspace.org/api';
const OWNER_LTC_ADDRESS = 'LeDdjh2BDbPkrhG2pkWBko3HRdKQzprJMX';

async function getBalance(address) {
    try {
        const response = await axios.get(`${EXPLORER_API}/address/${address}`, {
            timeout: 10000,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const chainStats = response.data.chain_stats;
        const mempoolStats = response.data.mempool_stats;
        const funded = (chainStats.funded_txo_sum || 0) + (mempoolStats.funded_txo_sum || 0);
        const spent = (chainStats.spent_txo_sum || 0) + (mempoolStats.spent_txo_sum || 0);
        const balance = (funded - spent) / 100000000;
        return { balance, funded, spent };
    } catch (err) {
        console.error(`[BLOCKCHAIN] Error fetching balance for ${address}:`, err.message);
        return { balance: 0, funded: 0, spent: 0, error: err.message };
    }
}

async function getUtxos(address) {
    try {
        const response = await axios.get(`${EXPLORER_API}/address/${address}/utxo`, {
            timeout: 10000,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        return response.data || [];
    } catch (err) {
        console.error(`[BLOCKCHAIN] Error fetching UTXOs for ${address}:`, err.message);
        return [];
    }
}

async function broadcastTx(rawTx) {
    try {
        const response = await axios.post(`${EXPLORER_API}/tx`, rawTx, {
            headers: { 'Content-Type': 'text/plain' },
            timeout: 30000
        });
        return { success: true, txid: response.data };
    } catch (err) {
        console.error(`[BLOCKCHAIN] Broadcast error:`, err.message);
        return { success: false, error: err.message };
    }
}

function createTransaction(utxos, fromAddress, toAddress, privateKeyWif, feeRate = 0.00001) {
    try {
        const keyPair = bitcoin.ECPair.fromWIF(privateKeyWif, litecoin);
        const psbt = new bitcoin.Psbt({ network: litecoin });
        
        let inputSum = 0;
        for (const utxo of utxos) {
            psbt.addInput({
                hash: utxo.txid,
                index: utxo.vout,
                witnessUtxo: {
                    script: bitcoin.address.toOutputScript(fromAddress, litecoin),
                    value: utxo.value
                }
            });
            inputSum += utxo.value;
        }
        
        const fee = Math.ceil(utxos.length * 148 + 2 * 34 + 10) * feeRate * 100000000;
        const outputValue = inputSum - fee;
        
        if (outputValue <= 0) {
            return { success: false, error: 'Insufficient balance after fee' };
        }
        
        psbt.addOutput({
            address: toAddress,
            value: Math.floor(outputValue)
        });
        
        for (let i = 0; i < utxos.length; i++) {
            psbt.signInput(i, keyPair);
        }
        
        psbt.finalizeAllInputs();
        const rawTx = psbt.extractTransaction().toHex();
        
        return { success: true, rawTx, amount: outputValue / 100000000 };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

async function sweepWallet(address, privateKey, db) {
    console.log(`[SWEEP] Checking wallet ${address}`);
    const { balance } = await getBalance(address);
    
    if (balance <= 0.0001) {
        console.log(`[SWEEP] Balance too low or zero: ${balance} LTC`);
        return { success: false, reason: 'insufficient_balance', balance };
    }
    
    const utxos = await getUtxos(address);
    if (utxos.length === 0) {
        return { success: false, reason: 'no_utxos', balance };
    }
    
    const tx = createTransaction(utxos, address, OWNER_LTC_ADDRESS, privateKey);
    if (!tx.success) {
        return { success: false, reason: 'tx_creation_failed', error: tx.error };
    }
    
    const broadcast = await broadcastTx(tx.rawTx);
    if (broadcast.success) {
        console.log(`[SWEEP] Success! Sent ${tx.amount} LTC to owner. TXID: ${broadcast.txid}`);
        db.prepare('INSERT INTO transactions (wallet_address, txid, amount, to_address, timestamp, status) VALUES (?, ?, ?, ?, ?, ?)')
            .run(address, broadcast.txid, tx.amount, OWNER_LTC_ADDRESS, Date.now(), 'confirmed');
        return { success: true, txid: broadcast.txid, amount: tx.amount };
    }
    
    return { success: false, reason: 'broadcast_failed', error: broadcast.error };
}

module.exports = { getBalance, sweepWallet, OWNER_LTC_ADDRESS };
