/**
 * Shim for @proton/crypto/lib/utils
 * Provides string/Uint8Array conversion utilities
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8');

export function utf8StringToUint8Array(str: string): Uint8Array {
    return textEncoder.encode(str);
}

export function uint8ArrayToUtf8String(bytes: Uint8Array): string {
    return textDecoder.decode(bytes);
}
