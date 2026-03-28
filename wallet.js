const bip39 = require('bip39');
const bitcoin = require('bitcoinjs-lib');
const crypto = require('crypto');
const { ECPairFactory } = require('ecpair');
const tinysecp = require('tiny-secp256k1');

const ECPair = ECPairFactory(tinysecp);

// Litecoin network
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

    if (!mnemonic) {
        mnemonic = bip39.generateMnemonic();
        console.log('[WALLET] No WALLET_MNEMONIC in env → generated random');
    } else {
        console.log('[WALLET] Using fixed WALLET_MNEMONIC from env');
    }

    const seed = bip39.mnemonicToSeedSync(mnemonic);
    const seedWithIndex = crypto.createHash('sha256')
        .update(seed.toString('hex') + index.toString())
        .digest();

    const keyPair = ECPair.fromPrivateKey(seedWithIndex.slice(0, 32), { network: litecoin });
    const { address } = bitcoin.payments.p2pkh({ 
        pubkey: keyPair.publicKey, 
        network: litecoin 
    });

    return { 
        address, 
        privateKey: keyPair.toWIF(), 
        mnemonic 
    };
}

module.exports = { generateLTCAddress };
