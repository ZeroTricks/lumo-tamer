/**
 * Session key management
 *
 * Decrypts the persisted session blob to extract the mailbox password,
 * which is needed to decrypt PGP private keys for master key access.
 */

import { importKey, decryptData } from '../proton-shims/aesGcm.js';
import { logger } from '../logger.js';
import type { PersistedSessionData, DecryptedSessionBlob } from '../lumo-client/types.js';

/**
 * Decode base64 to Uint8Array
 */
function base64ToBytes(b64: string): Uint8Array {
    return Uint8Array.from(Buffer.from(b64, 'base64'));
}

/**
 * Encode string to UTF-8 bytes
 */
function stringToBytes(str: string): Uint8Array {
    return new TextEncoder().encode(str);
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
        const cryptoKey = await importKey(clientKeyBytes);

        // Decode the blob
        const blobBytes = base64ToBytes(session.blob);

        // Prepare additional data based on payload version
        // Version 2 uses 'session' as additional data for AEAD
        let additionalData: Uint8Array | undefined;
        if (session.payloadVersion === 2) {
            additionalData = stringToBytes('session');
        }

        // Decrypt
        const decryptedBytes = await decryptData(cryptoKey, blobBytes, additionalData);
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

/**
 * Check if we have the required data to decrypt the session
 */
export function canDecryptSession(session?: PersistedSessionData): boolean {
    return !!(session?.blob && session?.clientKey);
}

/**
 * Get the mailbox password from a persisted session
 * This is the main entry point for getting the password needed for PGP decryption
 */
export async function getMailboxPassword(
    session: PersistedSessionData
): Promise<string> {
    const decrypted = await decryptPersistedSession(session);
    return decrypted.keyPassword;
}
