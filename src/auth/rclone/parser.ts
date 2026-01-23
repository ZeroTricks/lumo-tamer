/**
 * Parser for rclone protondrive config files
 *
 * Extracts authentication tokens from an existing rclone config,
 * including the keyPassword (stored as base64-encoded client_salted_key_pass).
 */

import { readFileSync } from 'fs';
import { homedir } from 'os';
import { logger } from '../../app/logger.js';
import type { SRPAuthTokens } from '../go-proton-api/types.js';
import type { RcloneProtonConfig } from './types.js';
import { REQUIRED_RCLONE_FIELDS } from './types.js';

/**
 * Expand ~ to home directory
 */
function expandPath(path: string): string {
    if (path.startsWith('~/')) {
        return path.replace('~', homedir());
    }
    return path;
}

/**
 * Parse an INI section from config content
 */
function parseIniSection(content: string, sectionName: string): Record<string, string> {
    // Match section header and content until next section or EOF
    const escapedName = sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const sectionRegex = new RegExp(`\\[${escapedName}\\]([\\s\\S]*?)(?=\\n\\[|$)`);
    const match = content.match(sectionRegex);

    if (!match) {
        throw new Error(`Section [${sectionName}] not found in rclone config`);
    }

    const result: Record<string, string> = {};
    const lines = match[1].split('\n');

    for (const line of lines) {
        const trimmed = line.trim();
        // Skip empty lines and comments
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) {
            continue;
        }
        // Match key = value pairs
        const kvMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.*)$/);
        if (kvMatch) {
            result[kvMatch[1]] = kvMatch[2].trim();
        }
    }

    return result;
}

/**
 * Parse rclone config and extract auth tokens
 *
 * @param configPath - Path to rclone.conf (supports ~ expansion)
 * @param remoteName - Name of the remote section (e.g., "proton-test")
 * @returns SRPAuthTokens compatible with AuthManager
 */
export function parseRcloneConfig(configPath: string, remoteName: string): SRPAuthTokens {
    const expandedPath = expandPath(configPath);

    logger.debug({ configPath: expandedPath, remoteName }, 'Parsing rclone config');

    let content: string;
    try {
        content = readFileSync(expandedPath, 'utf-8');
    } catch (err) {
        throw new Error(`Failed to read rclone config at ${expandedPath}: ${err}`);
    }

    const section = parseIniSection(content, remoteName);

    // Validate it's a protondrive remote
    if (section.type !== 'protondrive') {
        throw new Error(
            `Remote "${remoteName}" is type "${section.type}", expected "protondrive"`
        );
    }

    // Check for required fields
    const missing = REQUIRED_RCLONE_FIELDS.filter(field => !section[field]);
    if (missing.length > 0) {
        throw new Error(
            `Remote "${remoteName}" is missing required fields: ${missing.join(', ')}. ` +
            'Run "rclone config reconnect" to refresh credentials.'
        );
    }

    const config = section as unknown as RcloneProtonConfig;

    // Decode the salted key pass from base64
    let keyPassword: string;
    try {
        keyPassword = Buffer.from(config.client_salted_key_pass, 'base64').toString('utf-8');
    } catch (err) {
        throw new Error(`Failed to decode client_salted_key_pass: ${err}`);
    }

    logger.info(
        { remoteName, uid: config.client_uid.slice(0, 8) + '...' },
        'Loaded auth tokens from rclone config'
    );

    return {
        accessToken: config.client_access_token,
        refreshToken: config.client_refresh_token,
        uid: config.client_uid,
        userID: '', // Not stored in rclone config
        keyPassword,
        expiresAt: '', // Not tracked by rclone - tokens refreshed externally
        extractedAt: new Date().toISOString(),
    };
}
