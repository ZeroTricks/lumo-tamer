/**
 * Encryption module for conversation persistence
 *
 * Provides:
 * - Key management (master key, space keys, data encryption keys)
 * - Content encryption/decryption for conversations and messages
 */

export {
    KeyManager,
    getKeyManager,
    resetKeyManager,
    type KeyManagerConfig,
    type CachedUserKey,
    type CachedMasterKey,
} from './key-manager.js';

// Re-export session key utilities
export {
    decryptPersistedSession,
    canDecryptSession,
    getMailboxPassword,
} from '../session-keys.js';
