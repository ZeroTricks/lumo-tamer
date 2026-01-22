/**
 * Console Shim
 *
 * Redirects console methods to pino logger.
 * Install early in application startup before importing upstream modules.
 */

import { logger } from '../logger.js';

const originalConsole = { ...console };

export function installConsoleShim(): void {
    console.log = (...args) => logger.debug({ args }, 'console.log');
    console.debug = (...args) => logger.debug({ args }, 'console.debug');
    console.info = (...args) => logger.info({ args }, 'console.info');
    console.warn = (...args) => logger.warn({ args }, 'console.warn');
    console.error = (...args) => logger.error({ args }, 'console.error');
    console.assert = (condition, ...args) => {
        if (!condition) logger.error({ args }, 'Assertion failed');
    };
}

export function restoreConsole(): void {
    Object.assign(console, originalConsole);
}
