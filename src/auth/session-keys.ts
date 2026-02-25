/**
 * Session key management
 *
 * Decrypts the persisted session blob to extract the mailbox password,
 * which is needed to decrypt PGP private keys for master key access.
 */

import { importKey, decryptData } from '@proton/crypto/lib/subtle/aesGcm';
import { logger } from '../app/logger.js';
import type { PersistedSessionData, DecryptedSessionBlob } from '../lumo-client/types.js';

/**
 * Decode base64 to Uint8Array
 */
function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
    return new Uint8Array(Buffer.from(b64, 'base64')) as Uint8Array<ArrayBuffer>;
}

/**
 * Encode string to UTF-8 bytes
 */
function stringToBytes(str: string): Uint8Array<ArrayBuffer> {
    return new TextEncoder().encode(str) as Uint8Array<ArrayBuffer>;
}

/**
 * Decrypt the persisted session blob using the ClientKey
 *
 * The blob contains the encrypted mailbox password (keyPassword) which
 * is needed to decrypt the user's PGP private keys.
 *
 * @param session - Persisted session data including blob and clientKey
 * @returns Decrypted session blob with keyPassword
 */
export async function decryptPersistedSession(
    session: PersistedSessionData
): Promise<DecryptedSessionBlob> {
    if (!session.blob) {
        throw new Error('Session has no encrypted blob');
    }
    if (!session.clientKey) {
        throw new Error('Session has no clientKey - cannot decrypt');
    }

    try {
        // Import the ClientKey
        const clientKeyBytes = base64ToBytes(session.clientKey);
        logger.debug({ clientKeyLength: clientKeyBytes.length }, 'ClientKey decoded');
        const cryptoKey = await importKey(clientKeyBytes);

        // Decode the blob
        const blobBytes = base64ToBytes(session.blob);
        logger.debug({
            blobLength: blobBytes.length,
            payloadVersion: session.payloadVersion,
        }, 'Blob decoded');

        // Prepare additional data based on payload version
        // Version 2 uses 'session' as additional data for AEAD
        let additionalData: Uint8Array<ArrayBuffer> | undefined;
        if (session.payloadVersion === 2) {
            additionalData = stringToBytes('session');
        }

        // Session blobs use 16-byte IV (non-standard, legacy Proton format)
        const with16ByteIV = true;

        // Try decryption with and without additional data if version 1 fails
        let decryptedBytes: Uint8Array;
        try {
            decryptedBytes = await decryptData(cryptoKey, blobBytes, additionalData, with16ByteIV);
        } catch (firstError) {
            // If version 1 (no additional data) failed, try with version 2 format
            if (session.payloadVersion === 1) {
                logger.debug('Version 1 decryption failed, trying version 2 format');
                try {
                    decryptedBytes = await decryptData(cryptoKey, blobBytes, stringToBytes('session'), with16ByteIV);
                } catch {
                    // Re-throw original error
                    throw firstError;
                }
            } else {
                throw firstError;
            }
        }

        const decryptedJson = new TextDecoder().decode(decryptedBytes);
        const decryptedBlob = JSON.parse(decryptedJson) as DecryptedSessionBlob;

        // Validate
        if (!decryptedBlob.keyPassword) {
            throw new Error('Decrypted blob missing keyPassword');
        }

        logger.info({
            type: decryptedBlob.type,
            hasOfflineKey: !!decryptedBlob.offlineKeyPassword,
        }, 'Successfully decrypted persisted session');

        return decryptedBlob;
    } catch (error) {
        logger.error({ error }, 'Failed to decrypt persisted session');
        throw error;
    }
}

