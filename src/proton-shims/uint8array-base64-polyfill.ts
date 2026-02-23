/**
 * Polyfill for Uint8Array.fromBase64 and Uint8Array.prototype.toBase64
 *
 * ES2024 added these methods but they're not widely available yet.
 * This polyfill enables upstream Proton code to work unchanged in Node.js.
 *
 * Import this file once at application entry point.
 * TODO: is this needed in new nodejs versions?
 */

declare global {
    interface Uint8ArrayConstructor {
        fromBase64(base64: string): Uint8Array;
    }
    interface Uint8Array {
        toBase64(): string;
    }
}

if (typeof Uint8Array.fromBase64 !== 'function') {
    Uint8Array.fromBase64 = function (base64: string): Uint8Array {
        return new Uint8Array(Buffer.from(base64, 'base64'));
    };
}

if (typeof Uint8Array.prototype.toBase64 !== 'function') {
    Uint8Array.prototype.toBase64 = function (): string {
        return Buffer.from(this).toString('base64');
    };
}

export {};
