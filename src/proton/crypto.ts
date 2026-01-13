/**
 * AES-GCM cryptographic utilities using Node.js WebCrypto API
 * Reference: packages/crypto/lib/subtle/aesGcm.ts and applications/lumo/src/app/crypto/index.ts
 * See UPSTREAM.md for version info
 */

import type { AesGcmCryptoKey } from './types.js';

// Constants matching Proton's implementation
export const KEY_LENGTH_BYTES = 32;
const IV_LENGTH_BYTES = 12;
export const ENCRYPTION_ALGORITHM = 'AES-GCM';

// TextEncoder/TextDecoder for string conversion (replaces @proton/crypto/lib/utils)
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8');

export function utf8StringToUint8Array(str: string): Uint8Array {
    return textEncoder.encode(str);
}

export function uint8ArrayToUtf8String(bytes: Uint8Array): string {
    return textDecoder.decode(bytes);
}

// Utility to merge Uint8Arrays (replaces @proton/utils/mergeUint8Arrays)
export function mergeUint8Arrays(arrays: Uint8Array[]): Uint8Array {
    const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const arr of arrays) {
        result.set(arr, offset);
        offset += arr.length;
    }
    return result;
}

/**
 * Generate random key bytes for AES-GCM
 */
export function generateKeyBytes(): Uint8Array {
    return crypto.getRandomValues(new Uint8Array(KEY_LENGTH_BYTES));
}

/**
 * Import key bytes into a CryptoKey for AES-GCM operations
 */
export async function importKey(
    keyBytes: Uint8Array,
    options: { extractable?: boolean } = {}
): Promise<CryptoKey> {
    const { extractable = false } = options;
    // Create a copy as ArrayBuffer for WebCrypto compatibility
    const keyBuffer = new ArrayBuffer(keyBytes.byteLength);
    new Uint8Array(keyBuffer).set(keyBytes);
    return crypto.subtle.importKey(
        'raw',
        keyBuffer,
        ENCRYPTION_ALGORITHM,
        extractable,
        ['encrypt', 'decrypt']
    );
}

/**
 * Export a CryptoKey to raw bytes
 */
export async function exportKey(key: CryptoKey): Promise<Uint8Array> {
    const keyBuffer = await crypto.subtle.exportKey('raw', key);
    return new Uint8Array(keyBuffer);
}

/**
 * Generate and import an AES-GCM key
 */
export async function generateKey(options: { extractable?: boolean } = {}): Promise<AesGcmCryptoKey> {
    const keyBytes = generateKeyBytes();
    const encryptKey = await importKey(keyBytes, options);
    return {
        type: 'AesGcmCryptoKey',
        encryptKey,
    };
}

/**
 * Convert Uint8Array to ArrayBuffer (for WebCrypto compatibility)
 * Creates a copy to avoid SharedArrayBuffer issues
 */
function toArrayBuffer(arr: Uint8Array): ArrayBuffer {
    const buf = new ArrayBuffer(arr.byteLength);
    new Uint8Array(buf).set(arr);
    return buf;
}

/**
 * Encrypt data using AES-GCM
 * @param key - CryptoKey for encryption
 * @param data - Data to encrypt
 * @param additionalData - Optional additional authenticated data (AEAD)
 * @returns IV prepended to ciphertext
 */
export async function encryptData(
    key: CryptoKey,
    data: Uint8Array,
    additionalData?: Uint8Array
): Promise<Uint8Array> {
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH_BYTES));
    const ciphertext = await crypto.subtle.encrypt(
        {
            name: ENCRYPTION_ALGORITHM,
            iv,
            ...(additionalData !== undefined ? { additionalData: toArrayBuffer(additionalData) } : {}),
        },
        key,
        toArrayBuffer(data)
    );
    return mergeUint8Arrays([iv, new Uint8Array(ciphertext)]);
}

/**
 * Decrypt data using AES-GCM
 * @param key - CryptoKey for decryption
 * @param data - IV prepended to ciphertext
 * @param additionalData - Additional authenticated data (must match encryption)
 * @returns Decrypted plaintext
 */
export async function decryptData(
    key: CryptoKey,
    data: Uint8Array,
    additionalData?: Uint8Array
): Promise<Uint8Array> {
    const iv = data.slice(0, IV_LENGTH_BYTES);
    const ciphertext = data.slice(IV_LENGTH_BYTES);
    const result = await crypto.subtle.decrypt(
        {
            name: ENCRYPTION_ALGORITHM,
            iv: toArrayBuffer(iv),
            ...(additionalData !== undefined ? { additionalData: toArrayBuffer(additionalData) } : {}),
        },
        key,
        toArrayBuffer(ciphertext)
    );
    return new Uint8Array(result);
}

/**
 * Encrypt a string using AES-GCM
 * @param plaintext - String to encrypt
 * @param key - AesGcmCryptoKey wrapper
 * @param adString - Optional additional data string for AEAD
 * @returns Base64-encoded encrypted data
 */
export async function encryptString(
    plaintext: string,
    key: AesGcmCryptoKey,
    adString?: string
): Promise<string> {
    const plaintextBytes = utf8StringToUint8Array(plaintext);
    const adBytes = adString ? utf8StringToUint8Array(adString) : undefined;
    const encrypted = await encryptData(key.encryptKey, plaintextBytes, adBytes);
    return uint8ArrayToBase64(encrypted);
}

/**
 * Decrypt a base64-encoded string using AES-GCM
 * @param encryptedBase64 - Base64-encoded encrypted data
 * @param key - AesGcmCryptoKey wrapper
 * @param adString - Additional data string (must match encryption)
 * @returns Decrypted string
 */
export async function decryptString(
    encryptedBase64: string,
    key: AesGcmCryptoKey,
    adString: string
): Promise<string> {
    const encryptedBytes = base64ToUint8Array(encryptedBase64);
    const adBytes = utf8StringToUint8Array(adString);
    try {
        const decryptedBytes = await decryptData(key.encryptKey, encryptedBytes, adBytes);
        return uint8ArrayToUtf8String(decryptedBytes);
    } catch (error) {
        if (error instanceof DOMException && error.name === 'OperationError') {
            console.error(
                'Decryption failed. Possible cause: incorrect AD. ' +
                `AD used: ${adString}`
            );
        }
        throw error;
    }
}

/**
 * Convert Uint8Array to Base64 string
 */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
    // Use Buffer in Node.js for efficiency
    return Buffer.from(bytes).toString('base64');
}

/**
 * Convert Base64 string to Uint8Array
 */
export function base64ToUint8Array(base64: string): Uint8Array {
    return new Uint8Array(Buffer.from(base64, 'base64'));
}

/**
 * Convert bytes to AesGcmCryptoKey wrapper
 */
export async function bytesToAesGcmCryptoKey(
    bytes: Uint8Array,
    extractable?: boolean
): Promise<AesGcmCryptoKey> {
    if (bytes.length !== KEY_LENGTH_BYTES) {
        throw new Error(`Unexpected AES-GCM key size: ${bytes.length}, expected ${KEY_LENGTH_BYTES}`);
    }
    const encryptKey = await importKey(bytes, { extractable });
    return {
        type: 'AesGcmCryptoKey',
        encryptKey,
    };
}
