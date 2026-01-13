/**
 * Shim for @proton/crypto/lib/subtle/hash
 * Provides SHA-256 hashing using Node.js WebCrypto
 */

// Extend Uint8Array with toBase64 method
interface Uint8ArrayWithBase64 extends Uint8Array {
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
 * Compute SHA-256 hash of data
 */
export async function computeSHA256(data: Uint8Array): Promise<Uint8ArrayWithBase64> {
    // Create a copy to ensure ArrayBuffer type compatibility
    const buffer = new ArrayBuffer(data.byteLength);
    new Uint8Array(buffer).set(data);
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    return withBase64(new Uint8Array(hashBuffer));
}
