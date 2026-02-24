/**
 * Console Shim
 *
 * Redirects console methods to pino logger.
 * Install early in application startup before importing upstream modules.
 */

import { logger } from '../app/logger.js';
import { Level } from 'pino';

const originalConsole = { ...console };

// Since Proton/Lumo is ~ the only one using console, this is a good place to set their log levels:
// Suppressed logs go to trace

const suppressPatterns = [
    'Saga triggered:',
    'Action triggered:',
    'waitForSpace:',
    'waitForMapping:',
    'waitForConversation:',
    'Updating space ',
    'Soft delete skipped:',
    'listSpaces:',
    'refreshConversationFromRemote:',
    'refreshSpaceFromRemote',
    'space [a-f0-9-]+ updated successfully',
    'deserializeConversationSaga',
    '\\[STREAM\\] Parsed item:',
    'API:',
    'deserializeMessageSaga',
];
const suppressMatch = new RegExp(`^(?:${suppressPatterns.join('|')})`);

function extractError(args: unknown[]) {
    const result: unknown[] & { error?: Error } = [];
    for (const arg of args) {
        if (arg instanceof Error)
            result.error = arg;
        else
            result.push(arg);
    }
    return result;
}

function log(levelOrLog: Level | 'log', args: unknown[]) {
    const [first, ...rest] = args;
    let level = (levelOrLog == 'log') ? 'debug' : levelOrLog;

    if (typeof first == 'string') {
        if (levelOrLog == 'log' && suppressMatch.test(first))
            level = 'trace';
        const ee = extractError(rest);
        logger[level](ee, first);
    }
    else {
        const ee = extractError(args);
        logger[level](ee);
    }
}

export function installConsoleShim(): void {
    const levels = ['log', 'debug', 'info', 'warn', 'error'] as const;
    for (const level of levels) {
        console[level] = (...args) => { log(level, args) };
    }
    console.assert = (condition, ...args) => {
        if (!condition) logger.error({ args }, 'Assertion failed');
    };

}

export function restoreConsole(): void {
    Object.assign(console, originalConsole);
}
