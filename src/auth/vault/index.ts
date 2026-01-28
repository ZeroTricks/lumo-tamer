/**
 * Vault module exports
 */

export {
    readVault,
    writeVault,
    deleteVault,
    decryptVaultToJson,
    isEncryptedVault,
    ensureVaultKey,
    type VaultConfig,
} from './vault.js';

export {
    getVaultKey,
    setVaultKey,
    generateVaultKey,
    deleteVaultKey,
    getKeySource,
    isKeychainAvailable,
    isKeyFileAvailable,
    clearKeyCache,
    defaultKeyConfig,
    type KeySource,
    type VaultKeyConfig,
} from './key-provider.js';
