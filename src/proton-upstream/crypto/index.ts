/**
 * Crypto Shim
 *
 * Replaces: applications/lumo/src/app/crypto/index.ts
 *
 * Bridges @proton/* shim imports to the API expected by upstream files.
 * Uses Buffer.from() for base64 conversion instead of Uint8Array.fromBase64().
 *
 * Key exports (shim line → original line):
 * - generateMasterKeyBytes(): 33 → 19
 * - generateSpaceKeyBytes(): 34 → 20
 * - encryptString(): 40 → 26
 * - encryptUint8Array(): 51 → 37
 * - cryptoKeyToBase64(): 61 → 47
 * - bytesToAesGcmCryptoKey(): 66 → 52
 * - base64ToSpaceKey(): 85 → 71
 * - bytesToAesWrapKey(): 87 → 73
 * - base64ToMasterKey(): 100 → 86
 * - decryptUint8Array(): 103 → 89
 * - decryptString(): 134 → 134
 * - deriveDataEncryptionKey(): 150 → 150
 * - wrapAesKey(): 162 → 166
 * - unwrapAesKey(): 170 → 174
 * - computeSha256AsBase64(): 187 → 194
 */

import {
    decryptData,
    deriveKey,
    encryptData,
    exportKey,
    generateKey as generateAesGcmKeyBytes,
    generateWrappingKey as generateAesWrapKeyBytes,
    importKey as importAesGcmKey,
    importWrappingKey,
    unwrapKey,
    wrapKey,
    type Uint8ArrayWithBase64,
} from '@proton/crypto/lib/subtle/aesGcm';
import { computeSHA256 } from '@proton/crypto/lib/subtle/hash';
import { utf8StringToUint8Array, uint8ArrayToUtf8String } from '@proton/crypto/lib/utils';

import type { AesGcmCryptoKey, AesKwCryptoKey } from './types';

// Type aliases for compatibility
export type Base64 = string;
export type AdString = string;
export type EncryptedData = Base64 | { iv: Base64; data: Base64 };

export function isOldEncryptedData(obj: any): obj is { iv: string; data: string } {
    return typeof obj === 'object' && obj !== null && typeof obj.iv === 'string' && typeof obj.data === 'string';
}

export const generateMasterKeyBytes = (): Uint8ArrayWithBase64 => generateAesWrapKeyBytes();
export const generateSpaceKeyBytes = (): Uint8ArrayWithBase64 => generateAesGcmKeyBytes();
export const generateRequestKeyBytes = (): Uint8ArrayWithBase64 => generateAesGcmKeyBytes();

export const generateSpaceKeyBase64 = () => generateSpaceKeyBytes().toBase64();
export const generateMasterKeyBase64 = () => generateMasterKeyBytes().toBase64();

export async function encryptString(
    plaintext: string,
    { encryptKey }: AesGcmCryptoKey,
    adString?: string
): Promise<string> {
    const plaintextBytes = utf8StringToUint8Array(plaintext);
    const adBytes = adString ? utf8StringToUint8Array(adString) : undefined;
    const result = await encryptData(encryptKey, plaintextBytes, adBytes);
    return result.toBase64();
}

export async function encryptUint8Array(
    plaintextBytes: Uint8Array,
    { encryptKey }: AesGcmCryptoKey,
    adString?: string
): Promise<string> {
    const adBytes = adString ? utf8StringToUint8Array(adString) : undefined;
    const result = await encryptData(encryptKey, plaintextBytes, adBytes);
    return result.toBase64();
}

export async function cryptoKeyToBase64(key: CryptoKey): Promise<Base64> {
    const exportedKey = await exportKey(key);
    return exportedKey.toBase64();
}

export async function bytesToAesGcmCryptoKey(
    bytes: Uint8Array,
    extractable?: boolean
): Promise<AesGcmCryptoKey> {
    if (bytes.length !== 32) {
        throw new Error('Unexpected AES-GCM key size');
    }
    const encryptKey = await importAesGcmKey(bytes, { extractable });
    return {
        type: 'AesGcmCryptoKey',
        encryptKey,
    };
}

async function base64ToAesGcmCryptoKey(base64Key: string, extractable?: boolean): Promise<AesGcmCryptoKey> {
    const bytes = Buffer.from(base64Key, 'base64');
    return bytesToAesGcmCryptoKey(new Uint8Array(bytes), extractable);
}

export const base64ToSpaceKey = base64ToAesGcmCryptoKey;

export async function bytesToAesWrapKey(bytes: Uint8Array): Promise<AesKwCryptoKey> {
    const wrappingKey = await importWrappingKey(bytes);
    return {
        type: 'AesKwCryptoKey',
        wrappingKey,
    };
}

export async function base64ToAesWrapKey(base64Key: string): Promise<AesKwCryptoKey> {
    const bytes = Buffer.from(base64Key, 'base64');
    return bytesToAesWrapKey(new Uint8Array(bytes));
}

export const base64ToMasterKey = base64ToAesWrapKey;
export const bytesToMasterKey = bytesToAesWrapKey;

export async function decryptUint8Array(
    encryptedBase64: EncryptedData,
    { encryptKey }: AesGcmCryptoKey,
    ad: AdString
): Promise<Uint8Array> {
    let encryptedBytes: Uint8Array;
    if (typeof encryptedBase64 === 'string') {
        encryptedBytes = new Uint8Array(Buffer.from(encryptedBase64, 'base64'));
    } else if (isOldEncryptedData(encryptedBase64)) {
        const { iv, data } = encryptedBase64;
        const concat = `${iv}${data}`;
        encryptedBytes = new Uint8Array(Buffer.from(concat, 'base64'));
    } else {
        throw new Error('Unexpected shape for EncryptedData');
    }
    const adBytes = utf8StringToUint8Array(ad);
    try {
        const decryptedBytes = await decryptData(encryptKey, encryptedBytes, adBytes);
        return decryptedBytes;
    } catch (error) {
        if (error instanceof DOMException && error.name === 'OperationError' && ad !== undefined) {
            console.error(
                'Error during decryption. A possible cause is an incorrect AD. ' +
                'This payload was attempted to be decrypted with the following AD, make sure it matches the AD used during encryption.\n' +
                `AD = ${ad}`
            );
        }
        throw error;
    }
}

export async function decryptString(
    encryptedBase64: EncryptedData,
    key: AesGcmCryptoKey,
    ad: AdString
): Promise<string> {
    const decryptedBytes = await decryptUint8Array(encryptedBase64, key, ad);
    return uint8ArrayToUtf8String(decryptedBytes);
}

const SPACE_KEY_DERIVATION_SALT = 'Xd6V94/+5BmLAfc67xIBZcjsBPimm9/j02kHPI7Vsuc=';
const SPACE_DEK_CONTEXT = 'dek.space.lumo';
const HKDF_PARAMS_SPACE_DATA_ENCRYPTION = {
    salt: new Uint8Array(Buffer.from(SPACE_KEY_DERIVATION_SALT, 'base64')),
    info: utf8StringToUint8Array(SPACE_DEK_CONTEXT),
};

export async function deriveDataEncryptionKey(spaceKeyBytes: Uint8Array): Promise<AesGcmCryptoKey> {
    const encryptKey = await deriveKey(
        spaceKeyBytes,
        HKDF_PARAMS_SPACE_DATA_ENCRYPTION.salt,
        HKDF_PARAMS_SPACE_DATA_ENCRYPTION.info
    );
    return {
        type: 'AesGcmCryptoKey',
        encryptKey,
    };
}

export async function wrapAesKey(
    keyToWrap: AesGcmCryptoKey,
    { wrappingKey }: AesKwCryptoKey
): Promise<Uint8Array> {
    const wrappedBytes = await wrapKey(keyToWrap.encryptKey, wrappingKey);
    return wrappedBytes;
}

export async function unwrapAesKey(
    encryptedKeyBytes: Uint8Array,
    masterKey: AesKwCryptoKey,
    extractable?: boolean
): Promise<AesGcmCryptoKey> {
    try {
        const { wrappingKey } = masterKey;
        const encryptKey = await unwrapKey(encryptedKeyBytes, wrappingKey, { extractable });
        return {
            type: 'AesGcmCryptoKey',
            encryptKey,
        };
    } catch (e) {
        throw new Error(`error while unwrapping aes key: are you sure it was wrapped with this wrapping key? ${e}`);
    }
}

export async function computeSha256AsBase64(input: string, urlSafe: boolean = false): Promise<Base64> {
    const data = utf8StringToUint8Array(input);
    const hashBytes = await computeSHA256(data);
    let hashString = hashBytes.toBase64();
    if (urlSafe) {
        hashString = hashString.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }
    return hashString;
}
