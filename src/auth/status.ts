/**
 * Auth Status - Display current authentication configuration and status
 *
 * Usage: npm run auth-status
 */

import { existsSync, readFileSync } from 'fs';
import { authConfig } from '../config.js';
import { parseRcloneConfig } from './rclone/index.js';
import type { SRPAuthTokens } from './go-proton-api/types.js';
import { loadAuthTokens, areTokensExpired, getTokenAgeHours } from '../lumo-client/api-adapter.js';

interface StatusInfo {
    method: string;
    source: string;
    valid: boolean;
    details: Record<string, string | number | boolean>;
    warnings: string[];
}

function formatDuration(hours: number): string {
    if (hours < 1) {
        return `${Math.round(hours * 60)} minutes`;
    } else if (hours < 24) {
        return `${hours.toFixed(1)} hours`;
    } else {
        return `${(hours / 24).toFixed(1)} days`;
    }
}

function checkSrpTokens(cachePath: string): StatusInfo {
    const info: StatusInfo = {
        method: 'srp',
        source: cachePath,
        valid: false,
        details: {},
        warnings: [],
    };

    if (!existsSync(cachePath)) {
        info.warnings.push(`Token cache not found: ${cachePath}`);
        info.warnings.push('Run: ./bin/proton-auth -o sessions/auth-tokens.json');
        return info;
    }

    try {
        const tokens: SRPAuthTokens = JSON.parse(readFileSync(cachePath, 'utf-8'));

        info.details.uid = tokens.uid?.slice(0, 12) + '...';
        info.details.userID = tokens.userID?.slice(0, 12) + '...';
        info.details.hasKeyPassword = !!tokens.keyPassword;
        info.details.extractedAt = tokens.extractedAt;

        if (tokens.expiresAt) {
            const expiresAt = new Date(tokens.expiresAt);
            const now = new Date();
            const hoursRemaining = (expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60);

            info.details.expiresAt = tokens.expiresAt;

            if (hoursRemaining <= 0) {
                info.warnings.push('Tokens have expired');
                info.warnings.push('Re-run: ./bin/proton-auth -o sessions/auth-tokens.json');
            } else if (hoursRemaining < 1) {
                info.warnings.push(`Tokens expire in ${formatDuration(hoursRemaining)}`);
                info.valid = true;
            } else {
                info.details.expiresIn = formatDuration(hoursRemaining);
                info.valid = true;
            }
        } else {
            info.details.expiresAt = 'unknown';
            info.valid = true;
        }

        if (!tokens.keyPassword) {
            info.warnings.push('keyPassword missing - conversation persistence disabled');
        }
    } catch (err) {
        info.warnings.push(`Failed to parse token cache: ${err}`);
    }

    return info;
}

function checkBrowserTokens(tokenCachePath: string): StatusInfo {
    const info: StatusInfo = {
        method: 'browser',
        source: tokenCachePath,
        valid: false,
        details: {},
        warnings: [],
    };

    if (!existsSync(tokenCachePath)) {
        info.warnings.push(`Token file not found: ${tokenCachePath}`);
        info.warnings.push('Run: npm run extract-tokens');
        return info;
    }

    try {
        const tokens = loadAuthTokens();

        info.details.cookieCount = tokens.cookies.length;
        info.details.extractedAt = tokens.extractedAt;
        info.details.hasLocalStorage = !!tokens.localStorage;
        info.details.hasPersistedSession = !!tokens.persistedSession;

        const ageHours = getTokenAgeHours(tokens);
        info.details.age = formatDuration(ageHours);

        if (areTokensExpired(tokens)) {
            info.warnings.push('Some cookies have expired');
            info.warnings.push('Run: npm run extract-tokens');
        } else {
            info.valid = true;
        }

        // Find AUTH cookie to show UID
        const authCookie = tokens.cookies.find(c => c.name.startsWith('AUTH-'));
        if (authCookie) {
            const uid = authCookie.name.replace('AUTH-', '');
            info.details.uid = uid.slice(0, 12) + '...';
        }

        // Browser method cannot get keyPassword
        info.details.hasKeyPassword = false;
        info.warnings.push('keyPassword not available - conversation persistence disabled');
    } catch (err) {
        info.warnings.push(`Failed to load tokens: ${err}`);
    }

    return info;
}

function checkRcloneTokens(rclonePath: string, remoteName: string): StatusInfo {
    const defaultPath = '~/.config/rclone/rclone.conf';
    const configPath = rclonePath || defaultPath;

    const info: StatusInfo = {
        method: 'rclone',
        source: `${configPath} [${remoteName}]`,
        valid: false,
        details: {},
        warnings: [],
    };

    if (!remoteName) {
        info.warnings.push('auth.rcloneRemote not configured');
        return info;
    }

    try {

        const tokens = parseRcloneConfig(configPath, remoteName);

        info.details.uid = tokens.uid?.slice(0, 12) + '...';
        info.details.hasKeyPassword = !!tokens.keyPassword;
        info.details.extractedAt = tokens.extractedAt;

        // rclone doesn't track expiry
        info.details.expiresAt = 'not tracked (managed by rclone)';

        if (!tokens.keyPassword) {
            info.warnings.push('keyPassword missing');
        } else {
            info.valid = true;
        }

        if (!tokens.accessToken || !tokens.refreshToken) {
            info.warnings.push('Missing access/refresh tokens');
            info.warnings.push('Run: rclone config reconnect ' + remoteName + ':');
            info.valid = false;
        }
    } catch (err) {
        info.warnings.push(`${err}`);
    }

    return info;
}

function printStatus(info: StatusInfo): void {
    const statusIcon = info.valid ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';

    console.log(`\n${statusIcon} Auth Method: \x1b[1m${info.method}\x1b[0m`);
    console.log(`  Source: ${info.source}`);
    console.log('  Details:');

    for (const [key, value] of Object.entries(info.details)) {
        const displayValue = typeof value === 'boolean'
            ? (value ? '\x1b[32myes\x1b[0m' : '\x1b[33mno\x1b[0m')
            : value;
        console.log(`    ${key}: ${displayValue}`);
    }

    if (info.warnings.length > 0) {
        console.log('  Warnings:');
        for (const warning of info.warnings) {
            console.log(`    \x1b[33m⚠\x1b[0m ${warning}`);
        }
    }
}

function main(): void {
    console.log('=== Lumo Bridge Auth Status ===');

    const method = authConfig?.method || 'browser';
    console.log(`\nConfigured method: ${method}`);

    let info: StatusInfo;

    switch (method) {
        case 'srp':
            info = checkSrpTokens(authConfig?.tokenCachePath || 'sessions/auth-tokens.json');
            break;

        case 'rclone':
            info = checkRcloneTokens(
                authConfig?.rclonePath || '',
                authConfig?.rcloneRemote || ''
            );
            break;

        case 'browser':
        default:
            info = checkBrowserTokens(authConfig.tokenCachePath);
            break;
    }

    printStatus(info);

    // Summary
    console.log('\n--- Summary ---');
    if (info.valid) {
        console.log('\x1b[32mAuthentication is configured and valid.\x1b[0m');
        if (info.details.hasKeyPassword) {
            console.log('Conversation persistence: \x1b[32menabled\x1b[0m');
        } else {
            console.log('Conversation persistence: \x1b[33mdisabled\x1b[0m (no keyPassword)');
        }
    } else {
        console.log('\x1b[31mAuthentication needs attention.\x1b[0m');
        console.log('See warnings above for remediation steps.');
    }

    console.log('');
    process.exit(info.valid ? 0 : 1);
}

main();
