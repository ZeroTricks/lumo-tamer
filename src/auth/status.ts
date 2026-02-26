/**
 * Auth Status - Display helpers for authentication status
 */

import { print } from '../app/terminal.js';
import { createAuthProvider, type AuthProviderStatus } from './index.js';
import { authConfig, getConversationsConfig } from '../app/config.js';

export function printStatus(status: AuthProviderStatus): void {
    const statusIcon = status.valid ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';

    print(`\n${statusIcon} Auth Method: \x1b[1m${status.method}\x1b[0m`);
    print(`  Source: ${status.source}`);
    print('  Details:');

    for (const [key, value] of Object.entries(status.details)) {
        const displayValue = typeof value === 'boolean'
            ? (value ? '\x1b[32myes\x1b[0m' : '\x1b[33mno\x1b[0m')
            : value;
        print(`    ${key}: ${displayValue}`);
    }

    const autoRefresh = authConfig.autoRefresh;
    const autoRefreshDisplay = autoRefresh.enabled
        ? `\x1b[32myes\x1b[0m (every ${autoRefresh.intervalHours}h)`
        : '\x1b[33mno\x1b[0m';
    print(`    autoRefresh: ${autoRefreshDisplay}`);

    if (status.warnings.length > 0) {
        print('  Warnings:');
        for (const warning of status.warnings) {
            print(`    \x1b[33m⚠\x1b[0m ${warning}`);
        }
    }
}

export interface SummaryOptions {
    supportsPersistence: boolean;
    supportsSync: boolean;
}

export function printSummary(status: AuthProviderStatus, options: SummaryOptions): void {
    const { supportsPersistence, supportsSync } = options;
    const conversationsConfig = getConversationsConfig();

    print('\n--- Summary ---');
    if (status.valid) {
        print('\x1b[32mAuthentication is configured and valid.\x1b[0m');

        // Upstream storage status (local encryption)
        if (conversationsConfig.useUpstreamStorage) {
            if (!supportsPersistence) {
                print('Upstream storage: \x1b[33mdisabled\x1b[0m (no cached encryption keys)');
            } else if (!status.details.hasKeyPassword) {
                print('Upstream storage: \x1b[33mdisabled\x1b[0m (no keyPassword)');
            } else {
                print('Upstream storage: \x1b[32menabled\x1b[0m');
            }
        }

        // Sync status (Proton server sync)
        if (conversationsConfig.sync.enabled) {
            if (!supportsSync) {
                print('Conversation sync: \x1b[33mdisabled\x1b[0m (requires browser auth for lumo scope)');
            } else if (!status.details.hasKeyPassword) {
                print('Conversation sync: \x1b[33mdisabled\x1b[0m (no keyPassword)');
            } else {
                print('Conversation sync: \x1b[32menabled\x1b[0m');
            }
        } else {
            print('Conversation sync: \x1b[33mdisabled\x1b[0m (by configuration)');
        }
    } else {
        print('\x1b[31mAuthentication needs attention.\x1b[0m');
        print('See warnings above for remediation steps.');
    }
}

export async function runStatus(): Promise<void> {
    print('=== lumo-tamer auth status ===');

    const method = authConfig.method;
    print(`\nConfigured method: ${method}`);

    try {
        const provider = await createAuthProvider();
        const status = provider.getStatus();
        printStatus(status);
        printSummary(status, {
            supportsPersistence: provider.supportsPersistence(),
            supportsSync: provider.supportsSync(),
        });

        print('');
        process.exit(status.valid ? 0 : 1);
    } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        print(`\n\x1b[31m✗\x1b[0m Failed to initialize auth provider`);
        print(`  Error: ${errorMsg}`);
        print('\n--- Summary ---');
        print('\x1b[31mAuthentication needs attention.\x1b[0m');
        print('');
        process.exit(1);
    }
}
