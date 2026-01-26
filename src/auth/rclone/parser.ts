/**
 * Parser for rclone protondrive config sections
 *
 * Extracts authentication tokens from pasted rclone config content,
 * including the keyPassword (stored as base64-encoded client_salted_key_pass).
 */

import { logger } from '../../app/logger.js';
import type { SRPAuthTokens } from '../go-proton-api/types.js';
import type { RcloneProtonConfig } from './types.js';
import { REQUIRED_RCLONE_FIELDS } from './types.js';

/**
 * Parse key-value pairs from INI-style content
 */
function parseKeyValues(content: string): Record<string, string> {
    const result: Record<string, string> = {};
    const lines = content.split('\n');

    for (const line of lines) {
        const trimmed = line.trim();
        // Skip empty lines, comments, and section headers
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';') || trimmed.startsWith('[')) {
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
 * Extract section name from content (e.g., "[proton-test]" -> "proton-test")
 */
function extractSectionName(content: string): string | undefined {
    const match = content.match(/^\[([^\]]+)\]/m);
    return match?.[1];
}

/**
 * Parse rclone config section content and extract auth tokens
 *
 * @param content - Pasted rclone config section content
 * @returns SRPAuthTokens compatible with AuthManager
 */
export function parseRcloneSection(content: string): SRPAuthTokens {
    const sectionName = extractSectionName(content) ?? 'unknown';
    const section = parseKeyValues(content);

    logger.debug({ sectionName }, 'Parsing rclone config section');

    // Validate it's a protondrive remote
    if (section.type !== 'protondrive') {
        throw new Error(
            `Remote is type "${section.type || 'undefined'}", expected "protondrive"`
        );
    }

    // Check for required fields
    const missing = REQUIRED_RCLONE_FIELDS.filter(field => !section[field]);
    if (missing.length > 0) {
        throw new Error(
            `Config is missing required fields: ${missing.join(', ')}. ` +
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
        { sectionName, uid: config.client_uid.slice(0, 8) + '...' },
        'Parsed auth tokens from rclone config'
    );

    return {
        accessToken: config.client_access_token,
        refreshToken: config.client_refresh_token,
        uid: config.client_uid,
        userID: '', // Not stored in rclone config
        keyPassword,
        expiresAt: '', // Not tracked by rclone
        extractedAt: new Date().toISOString(),
    };
}
