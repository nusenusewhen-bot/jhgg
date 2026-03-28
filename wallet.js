const bip39 = require('bip39');
const bitcoin = require('bitcoinjs-lib');
const crypto = require('crypto');

// Litecoin network parameters
const litecoin = {
    messagePrefix: '\x19Litecoin Signed Message:\n',
    bech32: 'ltc',
    bip32: {
        public: 0x019da462,
        private: 0x019d9cfe
    },
    pubKeyHash: 0x30,
    scriptHash: 0x32,
    wif: 0xb0
};

// Simple key generation without bip32
function generateLTCAddress() {
    // Generate mnemonic
    const mnemonic = bip39.generateMnemonic();
    const seed = bip39.mnemonicToSeedSync(mnemonic);
    
    // Use seed to generate key pair directly
    const keyPair = bitcoin.ECPair.fromPrivateKey(seed.slice(0, 32), { network: litecoin });
    const { address } = bitcoin.payments.p2pkh({ 
        pubkey: keyPair.publicKey, 
        network: litecoin 
    });
    const privateKey = keyPair.toWIF();
    
    return { address, privateKey, mnemonic };
}

function generateAddressFromMnemonic(mnemonic, index = 0) {
    const seed = bip39.mnemonicToSeedSync(mnemonic);
    // Add index to seed for different addresses
    const seedWithIndex = crypto.createHash('sha256').update(seed.toString('hex') + index.toString()).digest();
    
    const keyPair = bitcoin.ECPair.fromPrivateKey(seedWithIndex.slice(0, 32), { network: litecoin });
    const { address } = bitcoin.payments.p2pkh({ 
        pubkey: keyPair.publicKey, 
        network: litecoin 
    });
    const privateKey = keyPair.toWIF();
    
    return { address, privateKey, mnemonic };
}

module.exports = { generateLTCAddress, generateAddressFromMnemonic };
