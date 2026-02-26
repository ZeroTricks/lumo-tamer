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

const suppressLogs = [
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
const suppressLogRegex = new RegExp(`^(?:${suppressLogs.join('|')})`);

const suppressErrors = [
    // Sync-disabled errors (login/rclone auth without lumo scope)
    'push conversation failure',
    'push message failure',
    'push space failure',
    'push attachment failure',
    'Error pulling spaces',
    'Sync disabled',
];
const suppressErrorRegex = new RegExp(`^(?:${suppressErrors.join('|')})`);

type EE = unknown[] & { error?: Error };

function extractError(args: unknown[]) {
    const result: EE = [];
    for (const arg of args) {
        if (arg instanceof Error)
            result.error = arg;
        else
            result.push(arg);
    }
    return result;
}

function minimal(ee: EE){
    if(ee.error !== undefined)
        return ee;
    switch (ee.length) {
        case 0:
            return undefined;
        case 1:
            return ee[0]
        default:
            return ee;
    }
}

function log(levelOrLog: Level | 'log', args: unknown[]) {
    const ee = extractError(args);
    const first = ee[0];
    let level = (levelOrLog == 'log') ? 'debug' : levelOrLog;

    if (typeof first == 'string') {
        ee.shift()
        if (    (levelOrLog == 'log' && suppressLogRegex.test(first))
            ||  (levelOrLog == 'error' && suppressErrorRegex.test(first))
        )
            level = 'trace';
        logger[level](minimal(ee), first);
    }
    else {
        logger[level](minimal(ee));
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
