/**
 * Safe logger for Node.js
 *
 * The browser version may strip sensitive data.
 * For lumo-tamer, we just use a no-op in production-like scenarios.
 */

export function createSafeStringify(): (value: unknown) => string {
    return (value: unknown) => JSON.stringify(value);
}

// Default logger instance
export const safeLogger = {
    stringify: createSafeStringify(),
    log: (...args: unknown[]) => console.log(...args),
    warn: (...args: unknown[]) => console.warn(...args),
    error: (...args: unknown[]) => console.error(...args),
};
