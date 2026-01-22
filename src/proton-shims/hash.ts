/**
 * Shim for @proton/crypto/lib/subtle/hash
 *
 * Replaces: packages/crypto/lib/subtle/hash.ts
 *
 * Function mapping:
 * - computeSHA256(): lines 22-28 → original lines 9-12
 *
 * Key difference: Shim adds .toBase64() method to result.
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
