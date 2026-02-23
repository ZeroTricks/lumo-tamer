/**
 * Base64 utilities for Node.js
 *
 * Provides fromBase64/toBase64 equivalents for Uint8Array since
 * ES2024 Uint8Array.prototype.toBase64 and Uint8Array.fromBase64 are not yet
 * widely supported.
 */

/**
 * Convert a base64 string to Uint8Array
 */
export function fromBase64(base64: string): Uint8Array {
    return Buffer.from(base64, 'base64');
}

/**
 * Convert a Uint8Array to base64 string
 */
export function toBase64(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('base64');
}
