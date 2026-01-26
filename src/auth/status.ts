/**
 * Auth Status - Display current authentication configuration and status
 *
 * Usage: npm run auth-status
 */

import { createAuthProvider, type AuthProviderStatus } from './index.js';
import { authConfig } from '../app/config.js';

export function printStatus(status: AuthProviderStatus): void {
    const statusIcon = status.valid ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';

    console.log(`\n${statusIcon} Auth Method: \x1b[1m${status.method}\x1b[0m`);
    console.log(`  Source: ${status.source}`);
    console.log('  Details:');

    for (const [key, value] of Object.entries(status.details)) {
        const displayValue = typeof value === 'boolean'
            ? (value ? '\x1b[32myes\x1b[0m' : '\x1b[33mno\x1b[0m')
            : value;
        console.log(`    ${key}: ${displayValue}`);
    }

    if (status.warnings.length > 0) {
        console.log('  Warnings:');
        for (const warning of status.warnings) {
            console.log(`    \x1b[33m⚠\x1b[0m ${warning}`);
        }
    }
}

async function main(): Promise<void> {
    console.log('=== Lumo Bridge Auth Status ===');

    const method = authConfig?.method || 'browser';
    console.log(`\nConfigured method: ${method}`);

    try {
        const provider = await createAuthProvider();
        const status = provider.getStatus();
        printStatus(status);

        // Summary
        console.log('\n--- Summary ---');
        if (status.valid) {
            console.log('\x1b[32mAuthentication is configured and valid.\x1b[0m');
            if (status.details.hasKeyPassword) {
                console.log('Conversation persistence: \x1b[32menabled\x1b[0m');
            } else {
                console.log('Conversation persistence: \x1b[33mdisabled\x1b[0m (no keyPassword)');
            }
        } else {
            console.log('\x1b[31mAuthentication needs attention.\x1b[0m');
            console.log('See warnings above for remediation steps.');
        }

        console.log('');
        process.exit(status.valid ? 0 : 1);
    } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error(`\n\x1b[31m✗\x1b[0m Failed to initialize auth provider`);
        console.error(`  Error: ${errorMsg}`);
        console.log('\n--- Summary ---');
        console.log('\x1b[31mAuthentication needs attention.\x1b[0m');
        console.log('');
        process.exit(1);
    }
}

// Only run when invoked directly (not when imported)
const isDirectInvocation = import.meta.url === `file://${process.argv[1]}`;
if (isDirectInvocation) {
    main().catch(err => {
        console.error('Error:', err);
        process.exit(1);
    });
}
