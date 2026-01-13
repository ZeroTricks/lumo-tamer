/**
 * Shim for @proton/crypto/lib/subtle/aesGcm
 * Provides compatible API using Node.js WebCrypto
 */

const KEY_LENGTH_BYTES = 32;
const IV_LENGTH_BYTES = 12;
const ENCRYPTION_ALGORITHM = 'AES-GCM';

// Helper to merge Uint8Arrays
function mergeUint8Arrays(arrays: Uint8Array[]): Uint8Array {
    const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const arr of arrays) {
        result.set(arr, offset);
        offset += arr.length;
    }
    return result;
}

// Helper to convert Uint8Array to ArrayBuffer (for WebCrypto compatibility)
function toArrayBuffer(arr: Uint8Array): ArrayBuffer {
    const buf = new ArrayBuffer(arr.byteLength);
    new Uint8Array(buf).set(arr);
    return buf;
}

// Extend Uint8Array with toBase64 method (Proton's pattern)
export interface Uint8ArrayWithBase64 extends Uint8Array {
    toBase64(): string;
}

function withBase64(arr: Uint8Array): Uint8ArrayWithBase64 {
    const extended = arr as Uint8ArrayWithBase64;
    extended.toBase64 = function() {
        return Buffer.from(this).toString('base64');
    };
    return extended;
}

/**
 * Generate random key bytes for AES-GCM (returns Uint8Array with toBase64)
 */
export function generateKey(): Uint8ArrayWithBase64 {
    const bytes = crypto.getRandomValues(new Uint8Array(KEY_LENGTH_BYTES));
    return withBase64(bytes);
}

/**
 * Generate random key bytes for AES-KW wrapping key
 */
export function generateWrappingKey(): Uint8ArrayWithBase64 {
    const bytes = crypto.getRandomValues(new Uint8Array(KEY_LENGTH_BYTES));
    return withBase64(bytes);
}

/**
 * Import key bytes into a CryptoKey for AES-GCM operations
 */
export async function importKey(
    keyBytes: Uint8Array,
    options: { extractable?: boolean } = {}
): Promise<CryptoKey> {
    const { extractable = false } = options;
    const keyBuffer = toArrayBuffer(keyBytes);
    return crypto.subtle.importKey(
        'raw',
        keyBuffer,
        ENCRYPTION_ALGORITHM,
        extractable,
        ['encrypt', 'decrypt']
    );
}

/**
 * Import key bytes for AES-KW wrapping operations
 */
export async function importWrappingKey(keyBytes: Uint8Array): Promise<CryptoKey> {
    const keyBuffer = toArrayBuffer(keyBytes);
    return crypto.subtle.importKey(
        'raw',
        keyBuffer,
        'AES-KW',
        false,
        ['wrapKey', 'unwrapKey']
    );
}

/**
 * Export a CryptoKey to raw bytes (returns Uint8Array with toBase64)
 */
export async function exportKey(key: CryptoKey): Promise<Uint8ArrayWithBase64> {
    const keyBuffer = await crypto.subtle.exportKey('raw', key);
    return withBase64(new Uint8Array(keyBuffer));
}

/**
 * Encrypt data using AES-GCM
 * Returns IV prepended to ciphertext (with toBase64 method)
 */
export async function encryptData(
    key: CryptoKey,
    data: Uint8Array,
    additionalData?: Uint8Array
): Promise<Uint8ArrayWithBase64> {
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
    return withBase64(mergeUint8Arrays([iv, new Uint8Array(ciphertext)]));
}

/**
 * Decrypt data using AES-GCM
 * Expects IV prepended to ciphertext
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
 * Derive an AES-GCM key using HKDF
 */
export async function deriveKey(
    keyMaterial: Uint8Array,
    salt: Uint8Array,
    info: Uint8Array
): Promise<CryptoKey> {
    const baseKey = await crypto.subtle.importKey(
        'raw',
        toArrayBuffer(keyMaterial),
        'HKDF',
        false,
        ['deriveKey']
    );
    return crypto.subtle.deriveKey(
        {
            name: 'HKDF',
            hash: 'SHA-256',
            salt: toArrayBuffer(salt),
            info: toArrayBuffer(info),
        },
        baseKey,
        { name: ENCRYPTION_ALGORITHM, length: 256 },
        false,
        ['encrypt', 'decrypt']
    );
}

/**
 * Wrap a key using AES-KW
 */
export async function wrapKey(
    keyToWrap: CryptoKey,
    wrappingKey: CryptoKey
): Promise<Uint8Array> {
    const wrapped = await crypto.subtle.wrapKey(
        'raw',
        keyToWrap,
        wrappingKey,
        'AES-KW'
    );
    return new Uint8Array(wrapped);
}

/**
 * Unwrap a key using AES-KW
 */
export async function unwrapKey(
    wrappedKey: Uint8Array,
    unwrappingKey: CryptoKey,
    options: { extractable?: boolean } = {}
): Promise<CryptoKey> {
    const { extractable = false } = options;
    return crypto.subtle.unwrapKey(
        'raw',
        toArrayBuffer(wrappedKey),
        unwrappingKey,
        'AES-KW',
        ENCRYPTION_ALGORITHM,
        extractable,
        ['encrypt', 'decrypt']
    );
}
