/**
 * U2L (User-to-Lumo) encryption utilities
 * Reference: applications/lumo/src/app/lib/lumo-api-client/core/encryption.ts
 * See UPSTREAM.md for version info
 */

import * as openpgp from 'openpgp';
import { v4 as uuidv4 } from 'uuid';

import {
    decryptString,
    encryptString,
    exportKey,
    generateKey,
    uint8ArrayToBase64,
} from './crypto.js';
import { LUMO_GPG_PUB_KEY_PROD_2 } from './keys.js';
import type { AesGcmCryptoKey, Base64, EncryptedTurn, RequestId, Turn } from './types.js';

// Default Lumo public key
export const DEFAULT_LUMO_PUB_KEY = LUMO_GPG_PUB_KEY_PROD_2;

// Re-export crypto functions for convenience
export { decryptString as decryptContent, encryptString };

/**
 * Generate a new request ID for encryption (UUID v4)
 */
export function generateRequestId(): RequestId {
    return uuidv4();
}

/**
 * Generate a new AES-GCM encryption key for request
 */
export async function generateRequestKey(): Promise<AesGcmCryptoKey> {
    return generateKey({ extractable: true });
}

/**
 * Encrypt conversation turns for U2L encryption
 * Each turn's content is encrypted with AES-GCM using request-specific AD
 */
export async function encryptTurns(
    turns: Turn[],
    requestKey: AesGcmCryptoKey,
    requestId: RequestId
): Promise<EncryptedTurn[]> {
    return Promise.all(
        turns.map(async (turn) => {
            const content = turn.content ?? '';
            const turnAd = `lumo.request.${requestId}.turn`;
            const contentEnc = await encryptString(content, requestKey, turnAd);
            return {
                ...turn,
                content: contentEnc,
                encrypted: true as const,
            };
        })
    );
}

/**
 * Prepare encrypted request key for transmission
 * The AES-GCM key is PGP-encrypted with Lumo's public key
 */
export async function prepareEncryptedRequestKey(
    requestKey: AesGcmCryptoKey,
    lumoPubKey: string = DEFAULT_LUMO_PUB_KEY
): Promise<Base64> {
    // Read the Lumo public key
    const lumoPublicKey = await openpgp.readKey({ armoredKey: lumoPubKey });

    // Export the AES key to raw bytes
    const requestKeyBytes = await exportKey(requestKey.encryptKey);

    // Encrypt the key bytes with PGP
    const encrypted = await openpgp.encrypt({
        message: await openpgp.createMessage({ binary: requestKeyBytes }),
        encryptionKeys: lumoPublicKey,
        format: 'binary',
    });

    // Convert to base64
    // encrypted is a Uint8Array when format is 'binary'
    return uint8ArrayToBase64(encrypted as Uint8Array);
}
