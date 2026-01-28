#!/usr/bin/env node
/**
 * Unified authentication script
 *
 * Usage: npm run auth
 *
 * Prompts for auth method (with config value as default) and runs extraction:
 * - browser: Extract tokens from browser session via CDP
 * - rclone: Prompt user to paste rclone config section
 * - srp: Run interactive SRP authentication
 *
 * Updates config.yaml with selected values after successful auth.
 */

// Initialize config mode and logger before other imports
import { initConfig, getLogConfig } from '../app/config.js';
initConfig('cli');

import { initLogger, logger } from '../app/logger.js';
initLogger({...getLogConfig(), target: 'stdout', level: 'warn'}, { consoleShim: false });

import * as readline from 'readline';
import { authConfig, authMethodSchema, getConversationsConfig } from '../app/config.js';
import { runBrowserAuthentication } from './browser/authenticate.js';
import { runRcloneAuthentication } from './rclone/authenticate.js';
import { runLoginAuthentication } from './login/authenticate.js';
import { BrowserAuthProvider } from './providers/browser.js';
import { RcloneAuthProvider } from './providers/rclone.js';
import { LoginAuthProvider } from './providers/login.js';
import { printStatus, printSummary } from './status.js';
import { updateAuthConfig } from './update-config.js';
import type { AuthMethod, AuthProvider } from './types.js';

const numToMethod: Record<string, AuthMethod> = { '1': 'browser', '2': 'login', '3': 'rclone' };
const methodToNum: Record<AuthMethod, string> = { browser: '1', login: '2', rclone: '3' };

/**
 * Prompt user to select authentication method
 */
async function promptForMethod(defaultMethod: AuthMethod): Promise<AuthMethod> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    console.log('Select authentication method:');
    console.log('  1. browser - Extract from logged-in browser session');
    console.log('  2. login   - Enter Proton credentials (requires go binary)');
    console.log('  3. rclone  - Paste rclone config section');
    console.log('');

    const defaultNum = methodToNum[defaultMethod] || '1';

    return new Promise(resolve => {
        rl.question(`Choice [${defaultNum}]: `, answer => {
            rl.close();
            const input = answer.trim() || defaultNum;

            // Try parsing as number first, then as method name
            const method = numToMethod[input] ?? authMethodSchema.safeParse(input).data ?? 'browser';
            resolve(method);
        });
    });
}

interface BrowserAuthResult {
    cdpEndpoint: string;
}

async function authenticateBrowser(): Promise<BrowserAuthResult> {
    const result = await runBrowserAuthentication();

    // Log warnings
    for (const warning of result.warnings) {
        logger.warn(warning);
    }

    // Summary
    const syncEnabled = getConversationsConfig().sync.enabled;
    if (!syncEnabled) {
        logger.info('Sync disabled - encryption keys not fetched');
    } else if (result.tokens.persistedSession?.blob && result.tokens.persistedSession?.clientKey) {
        logger.info('Extended auth data extracted - conversation persistence enabled');
    } else if (result.tokens.persistedSession?.blob) {
        logger.warn('Conversation persistence may not work without ClientKey');
    } else {
        logger.warn('Conversation persistence will use local-only encryption');
    }

    return { cdpEndpoint: result.cdpEndpoint };
}

async function main(): Promise<void> {
    console.log('=== lumo-tamer authentication ===\n');

    // Prompt for method (with config value as default)
    const defaultMethod = authConfig.method;
    const method = await promptForMethod(defaultMethod);

    console.log(`\nUsing method: ${method}\n`);

    try {
        let cdpEndpoint: string | undefined;

        switch (method) {
            case 'browser': {
                const result = await authenticateBrowser();
                cdpEndpoint = result.cdpEndpoint;
                break;
            }
            case 'rclone':
                await runRcloneAuthentication();
                break;
            case 'login':
                await runLoginAuthentication();
                break;
            default:
                throw new Error(`Unknown auth method: ${method}`);
        }

        // Flush logger before showing status (pino is async)
        logger.flush();
        await new Promise(resolve => setTimeout(resolve, 100));

        // Update config.yaml with selected values
        updateAuthConfig({
            method,
            cdpEndpoint,
        });

        // Show status after extraction
        // Create provider directly based on selected method (not from config, which hasn't reloaded)
        let provider: AuthProvider;
        switch (method) {
            case 'login':
                provider = new LoginAuthProvider();
                break;
            case 'rclone':
                provider = new RcloneAuthProvider();
                break;
            default:
                provider = new BrowserAuthProvider();
                break;
        }
        await provider.initialize();
        const status = provider.getStatus();
        printStatus(status);
        printSummary(status, provider.supportsPersistence());

        console.log('\nYou can now run: npm run server or npm run cli');
        process.exit(0);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error({ err: error }, `Authentication failed: ${message}`);
        process.exit(1);
    }
}

main();
