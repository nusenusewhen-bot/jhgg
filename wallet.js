const bip39 = require('bip39');
const bitcoin = require('bitcoinjs-lib');
const crypto = require('crypto');

// Try to load ECPair
let ECPair;
try {
    const ECPairFactory = require('ecpair').default;
    const tinysecp = require('tiny-secp256k1');
    ECPair = ECPairFactory(tinysecp);
    console.log('[WALLET] ECPair loaded successfully');
} catch(e) {
    console.error('[WALLET] ECPair load failed:', e.message);
    // Fallback attempt
    try {
        ECPair = require('ecpair');
        console.log('[WALLET] ECPair fallback loaded');
    } catch(e2) {
        console.error('[WALLET] All ECPair loads failed');
        throw e;
    }
}

const litecoin = {
    messagePrefix: '\x19Litecoin Signed Message:\n',
    bech32: 'ltc',
    bip32: { public: 0x019da462, private: 0x019d9cfe },
    pubKeyHash: 0x30,
    scriptHash: 0x32,
    wif: 0xb0
};

function generateLTCAddress(index = 0) {
    console.log('[WALLET] Generating address with index:', index);
    
    let mnemonic = process.env.WALLET_MNEMONIC;

    if (!mnemonic) {
        mnemonic = bip39.generateMnemonic();
        console.log('[WALLET] Generated random mnemonic');
    } else {
        console.log('[WALLET] Using env mnemonic');
    }

    const seed = bip39.mnemonicToSeedSync(mnemonic);
    const seedWithIndex = crypto.createHash('sha256')
        .update(Buffer.concat([seed, Buffer.from(index.toString())]))
        .digest();

    const keyPair = ECPair.fromPrivateKey(seedWithIndex.slice(0, 32), { network: litecoin });
    const { address } = bitcoin.payments.p2pkh({ 
        pubkey: keyPair.publicKey, 
        network: litecoin 
    });

    console.log('[WALLET] Generated address:', address);

    return { 
        address, 
        privateKey: keyPair.toWIF(), 
        mnemonic 
    };
}

module.exports = { generateLTCAddress };
