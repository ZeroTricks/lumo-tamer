/**
 * Key Manager for conversation persistence
 *
 * Handles:
 * - Master key decryption using PGP private keys
 * - Space key management (wrapping/unwrapping)
 * - Data encryption key derivation
 *
 * Key hierarchy:
 * User PGP Key -> Master Key -> Space Key -> Data Encryption Key -> Content
 */

import { CryptoProxy, type PrivateKey } from '../../proton-shims/crypto.js';
import {
    importKey,
    importWrappingKey,
    unwrapKey,
    generateKey,
    exportKey,
    deriveKey,
} from '../../proton-shims/aesGcm.js';
import { logger } from '../../logger.js';
import type { SpaceId } from '../types.js';
import type { Api } from '../../lumo-client/types.js';

// Constants for key derivation
const SPACE_KEY_SALT = new Uint8Array([0x6c, 0x75, 0x6d, 0x6f, 0x2d, 0x73, 0x70, 0x61, 0x63, 0x65]); // 'lumo-space'
const SPACE_KEY_INFO = new Uint8Array([0x64, 0x61, 0x74, 0x61, 0x2d, 0x65, 0x6e, 0x63]); // 'data-enc'

/**
 * Decode base64 to Uint8Array
 */
function base64ToBytes(b64: string): Uint8Array {
    return Uint8Array.from(Buffer.from(b64, 'base64'));
}

/**
 * Encode Uint8Array to base64
 */
function bytesToBase64(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('base64');
}

/**
 * Master key response from API
 */
interface MasterKeyResponse {
    Eligibility: number;
    MasterKeys: Array<{
        ID: string;
        IsLatest: boolean;
        Version: number;
        CreateTime: number;
        MasterKey: string;  // PGP-encrypted master key (armored)
    }>;
}

/**
 * User keys response from API
 */
interface UserKeysResponse {
    User: {
        Keys: Array<{
            ID: string;
            PrivateKey: string;  // Armored PGP private key (encrypted with keyPassword)
            Primary: number;
            Active: number;
        }>;
    };
}

export interface KeyManagerConfig {
    api: Api;
}

/**
 * Key Manager class
 */
export class KeyManager {
    private api: Api;
    private masterKey?: CryptoKey;
    private spaceKeys = new Map<SpaceId, CryptoKey>();
    private initialized = false;

    constructor(config: KeyManagerConfig) {
        this.api = config.api;
    }

    /**
     * Initialize the key manager by decrypting the master key
     *
     * @param keyPassword - The mailbox password (from decrypted session)
     */
    async initialize(keyPassword: string): Promise<void> {
        if (this.initialized) {
            logger.warn('KeyManager already initialized');
            return;
        }

        try {
            // 1. Fetch user keys
            logger.info('Fetching user keys...');
            // BUG: this is most likely not the right endpoint to call here. we can add an email but its returning public keys for addresses
            const userKeysResponse = await this.api({
                url: 'core/v4/keys/all',
                method: 'get',
            }) as UserKeysResponse;

            const userKeys = userKeysResponse.User?.Keys ?? [];
            if (userKeys.length === 0) {
                throw new Error('No user keys found');
            }

            logger.info({ count: userKeys.length }, 'Found user keys');

            // 2. Decrypt PGP private keys
            const decryptedKeys: PrivateKey[] = [];
            for (const key of userKeys) {
                if (!key.Active) continue;

                try {
                    const privateKey = await CryptoProxy.importPrivateKey({
                        armoredKey: key.PrivateKey,
                        passphrase: keyPassword,
                    });
                    decryptedKeys.push(privateKey);
                    logger.debug({ keyId: key.ID, primary: key.Primary }, 'Decrypted user key');
                } catch (error) {
                    logger.warn({ keyId: key.ID, error }, 'Failed to decrypt user key');
                }
            }

            if (decryptedKeys.length === 0) {
                throw new Error('Failed to decrypt any user keys');
            }

            logger.info({ count: decryptedKeys.length }, 'Decrypted user keys');

            // 3. Fetch master key
            logger.info('Fetching master key...');
            const masterKeyResponse = await this.api({
                url: 'lumo/v1/masterkeys',
                method: 'get',
            }) as MasterKeyResponse;

            if (!masterKeyResponse.MasterKeys?.length) {
                throw new Error('No master keys found');
            }

            // Find the latest/best master key
            const masterKeyEntry = masterKeyResponse.MasterKeys.reduce((best, current) => {
                if (!best) return current;
                if (current.IsLatest && !best.IsLatest) return current;
                if (current.Version > best.Version) return current;
                return best;
            });

            logger.info({
                keyId: masterKeyEntry.ID,
                version: masterKeyEntry.Version,
                isLatest: masterKeyEntry.IsLatest,
            }, 'Found master key');

            // 4. Decrypt master key using PGP
            const decryptedMasterKeyBytes = await this.decryptMasterKey(
                masterKeyEntry.MasterKey,
                decryptedKeys
            );

            // 5. Import as AES-KW key (for unwrapping space keys)
            this.masterKey = await importWrappingKey(decryptedMasterKeyBytes);
            this.initialized = true;

            logger.info('KeyManager initialized successfully');
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            const errorStack = error instanceof Error ? error.stack : undefined;
            logger.error({ errorMessage, errorStack }, 'Failed to initialize KeyManager');
            throw error;
        }
    }

    /**
     * Check if initialized
     */
    isInitialized(): boolean {
        return this.initialized;
    }

    /**
     * Get or create a space key
     *
     * @param spaceId - Space ID
     * @param wrappedKey - Optional wrapped key from server (base64)
     * @returns Data encryption key for the space
     */
    async getSpaceKey(spaceId: SpaceId, wrappedKey?: string): Promise<CryptoKey> {
        if (!this.masterKey) {
            throw new Error('KeyManager not initialized');
        }

        // Check cache
        let spaceKey = this.spaceKeys.get(spaceId);
        if (spaceKey) {
            return spaceKey;
        }

        if (wrappedKey) {
            // Unwrap existing space key
            const wrappedBytes = base64ToBytes(wrappedKey);
            spaceKey = await unwrapKey(wrappedBytes, this.masterKey, { extractable: true });
            logger.debug({ spaceId }, 'Unwrapped space key');
        } else {
            // Generate new space key
            const keyBytes = generateKey();
            spaceKey = await importKey(keyBytes, { extractable: true });
            logger.debug({ spaceId }, 'Generated new space key');
        }

        this.spaceKeys.set(spaceId, spaceKey);
        return spaceKey;
    }

    /**
     * Derive data encryption key from space key
     * This is the key actually used to encrypt/decrypt content
     */
    async getDataEncryptionKey(spaceId: SpaceId, wrappedKey?: string): Promise<CryptoKey> {
        const spaceKey = await this.getSpaceKey(spaceId, wrappedKey);
        const keyBytes = await exportKey(spaceKey);
        return deriveKey(keyBytes, SPACE_KEY_SALT, SPACE_KEY_INFO);
    }

    /**
     * Wrap a space key for storage on server
     */
    async wrapSpaceKey(spaceId: SpaceId): Promise<string> {
        if (!this.masterKey) {
            throw new Error('KeyManager not initialized');
        }

        const spaceKey = this.spaceKeys.get(spaceId);
        if (!spaceKey) {
            throw new Error(`Space key not found: ${spaceId}`);
        }

        const wrapped = await crypto.subtle.wrapKey(
            'raw',
            spaceKey,
            this.masterKey,
            'AES-KW'
        );

        return bytesToBase64(new Uint8Array(wrapped));
    }

    /**
     * Decrypt a PGP-encrypted master key
     */
    private async decryptMasterKey(
        encryptedMasterKey: string,
        decryptionKeys: PrivateKey[]
    ): Promise<Uint8Array> {
        // The master key is PGP-encrypted (armored message)
        // We need to decrypt it using the user's private keys
        const decrypted = await CryptoProxy.decryptMessage({
            armoredMessage: encryptedMasterKey,
            decryptionKeys,
            format: 'binary',
        });

        return decrypted.data as Uint8Array;
    }
}

// Singleton instance
let keyManagerInstance: KeyManager | null = null;

/**
 * Get the global KeyManager instance
 */
export function getKeyManager(config?: KeyManagerConfig): KeyManager {
    if (!keyManagerInstance && config) {
        keyManagerInstance = new KeyManager(config);
    }
    if (!keyManagerInstance) {
        throw new Error('KeyManager not initialized - call with config first');
    }
    return keyManagerInstance;
}

/**
 * Reset the KeyManager (for testing)
 */
export function resetKeyManager(): void {
    keyManagerInstance = null;
}
