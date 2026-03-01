/**
 * Local Key Generator
 *
 * Generates PGP keys in Proton-compatible format for local-only encryption.
 * These keys allow KeyManager to work identically for all auth methods,
 * but cannot sync with Proton (sync requires real Proton keys).
 */

import * as openpgp from 'openpgp';
import { generateMasterKeyBytes } from '@lumo/crypto/index.js';
import type { CachedUserKey, CachedMasterKey } from './types.js';

export interface GeneratedKeys {
    userKeys: CachedUserKey[];
    masterKeys: CachedMasterKey[];
}

/**
 * Generate local encryption keys in Proton-compatible format
 *
 * Creates a PGP keypair and master key that KeyManager can use.
 * These keys are local-only and cannot sync with Proton.
 *
 * @param keyPassword - The password to encrypt the PGP private key
 */
export async function generateLocalKeys(keyPassword: string): Promise<GeneratedKeys> {
    // 1. Generate PGP keypair
    const { privateKey, publicKey } = await openpgp.generateKey({
        type: 'ecc',
        curve: 'curve25519Legacy',
        userIDs: [{ name: 'Local User', email: 'local@lumo-tamer.local' }],
        passphrase: keyPassword,
        format: 'armored',
    });

    // 2. Generate master key bytes (AES-256)
    const masterKeyBytes = generateMasterKeyBytes();

    // 3. PGP-encrypt master key with the public key
    const pubKey = await openpgp.readKey({ armoredKey: publicKey });
    const message = await openpgp.createMessage({ binary: masterKeyBytes });
    const encrypted = await openpgp.encrypt({
        message,
        encryptionKeys: pubKey,
        format: 'binary',
    });
    const encryptedMasterKey = Buffer.from(encrypted as Uint8Array).toString('base64');

    // 4. Return in Proton-compatible format with local-only markers
    const userId = crypto.randomUUID();
    const createdAt = new Date().toISOString();

    return {
        userKeys: [{
            ID: userId,
            PrivateKey: privateKey,
            Primary: 1,
            Active: 1,
            isLocalOnly: true,
            createdAt,
        }],
        masterKeys: [{
            ID: crypto.randomUUID(),
            MasterKey: encryptedMasterKey,
            IsLatest: true,
            Version: 1,
            isLocalOnly: true,
            createdAt,
        }],
    };
}
