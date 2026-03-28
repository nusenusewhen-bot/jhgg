const bip39 = require('bip39');
const bitcoin = require('bitcoinjs-lib');
const litecoin = bitcoin.networks.litecoin;

function generateLTCAddress() {
    const mnemonic = bip39.generateMnemonic();
    const seed = bip39.mnemonicToSeedSync(mnemonic);
    const root = bitcoin.bip32.fromSeed(seed, litecoin);
    const child = root.derivePath("m/44'/2'/0'/0/0");
    const { address } = bitcoin.payments.p2pkh({ 
        pubkey: child.publicKey, 
        network: litecoin 
    });
    const privateKey = child.toWIF();
    return { address, privateKey, mnemonic };
}

function generateAddressFromMnemonic(mnemonic, index = 0) {
    const seed = bip39.mnemonicToSeedSync(mnemonic);
    const root = bitcoin.bip32.fromSeed(seed, litecoin);
    const child = root.derivePath(`m/44'/2'/0'/0/${index}`);
    const { address } = bitcoin.payments.p2pkh({ 
        pubkey: child.publicKey, 
        network: litecoin 
    });
    const privateKey = child.toWIF();
    return { address, privateKey, mnemonic };
}

module.exports = { generateLTCAddress, generateAddressFromMnemonic };
