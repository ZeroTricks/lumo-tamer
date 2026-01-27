/**
 * Shim for @proton/crypto/lib/utils
 *
 * Replaces: packages/crypto/lib/utils.ts
 *
 * Function mapping:
 * - utf8StringToUint8Array(): lines 9-11 → original lines 53-57
 * - uint8ArrayToUtf8String(): lines 13-15 → original lines 66-70
 *
 * Not shimmed (not used by lumo-tamer):
 * - uint8ArrayToBinaryString() - original lines 16-26
 * - binaryStringToUint8Array() - original lines 35-45
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8');

export function utf8StringToUint8Array(str: string): Uint8Array {
    return textEncoder.encode(str);
}

export function uint8ArrayToUtf8String(bytes: Uint8Array): string {
    return textDecoder.decode(bytes);
}
