/**
 * Vault Key Provider
 *
 * Resolves the vault encryption key from secure sources only:
 * 1. OS Keychain (via keytar) - Desktop/interactive use
 * 2. Docker Secret file - Containerized/headless use
 *
 * Environment variables and plain key files are NOT supported
 * to avoid the "key taped to the door" anti-pattern.
 */

import { existsSync, readFileSync } from 'fs';
import { randomBytes } from 'crypto';
import { logger } from '../../app/logger.js';
import { authConfig } from '../../app/config.js';

// Lazy-load keytar to handle environments where native deps aren't available
let keytar: typeof import('keytar') | null = null;
async function loadKeytar(): Promise<typeof import('keytar') | null> {
    if (keytar !== null) return keytar;
    try {
        const mod = await import('keytar');
        // Handle both ESM default export and CommonJS module.exports
        keytar = (mod as any).default ?? mod;
        return keytar;
    } catch {
        return null;
    }
}

export type KeySource = 'keychain' | 'file';

export interface VaultKeyConfig {
    keychain: {
        service: string;
        account: string;
    };
    keyFilePath: string;
}

function getDefaultKeyConfig(): VaultKeyConfig {
    return {
        keychain: authConfig.vault.keychain,
        keyFilePath: authConfig.vault.keyFilePath,
    };
}

let cachedKey: Buffer | null = null;
let cachedSource: KeySource | null = null;

/**
 * Get the vault encryption key from a secure source.
 * Tries keychain first, then Docker secret.
 * Throws if no secure source is available.
 */
export async function getVaultKey(config: VaultKeyConfig = getDefaultKeyConfig()): Promise<Buffer> {
    if (cachedKey) return cachedKey;

    // Try keychain first
    const kt = await loadKeytar();
    if (kt) {
        try {
            const password = await kt.getPassword(config.keychain.service, config.keychain.account);
            if (password) {
                cachedKey = Buffer.from(password, 'base64');
                if (cachedKey.length !== 32) {
                    throw new Error(`Invalid vault key length: expected 32 bytes, got ${cachedKey.length}`);
                }
                cachedSource = 'keychain';
                logger.debug({ source: 'keychain' }, 'Vault key loaded from keychain');
                return cachedKey;
            }
        } catch (err) {
            logger.debug({ err }, 'Failed to get key from keychain');
        }
    }

    // Try key file (fallback for Docker/headless)
    if (existsSync(config.keyFilePath)) {
        try {
            const content = readFileSync(config.keyFilePath);
            // Support both raw binary (32 bytes) and base64 (44 chars)
            if (content.length === 32) {
                cachedKey = content;
            } else {
                // Assume base64, trim whitespace
                cachedKey = Buffer.from(content.toString('utf8').trim(), 'base64');
            }
            if (cachedKey.length !== 32) {
                throw new Error(`Invalid key file length: expected 32 bytes, got ${cachedKey.length}`);
            }
            cachedSource = 'file';
            logger.debug({ source: 'file', path: config.keyFilePath }, 'Vault key loaded from file');
            return cachedKey;
        } catch (err) {
            logger.debug({ err }, 'Failed to read key file');
        }
    }

    // No secure source available
    throw new Error(
        'No secure key storage available.\n' +
        '- Desktop: Install system keychain (gnome-keyring, macOS Keychain, Windows Credential Manager)\n' +
        `- Docker: Mount a secret at ${config.keyFilePath}\n`
    );
}

/**
 * Store a vault key in the keychain.
 * Only works if keytar is available (desktop environments).
 */
export async function setVaultKey(key: Buffer, config: VaultKeyConfig = getDefaultKeyConfig()): Promise<void> {
    if (key.length !== 32) {
        throw new Error(`Invalid vault key length: expected 32 bytes, got ${key.length}`);
    }

    const kt = await loadKeytar();
    if (!kt) {
        throw new Error('Keytar not available - cannot store key in keychain');
    }

    await kt.setPassword(config.keychain.service, config.keychain.account, key.toString('base64'));
    cachedKey = key;
    cachedSource = 'keychain';
    logger.info({ service: config.keychain.service }, 'Vault key stored in keychain');
}

/**
 * Generate a new random vault key (32 bytes for AES-256).
 */
export function generateVaultKey(): Buffer {
    return randomBytes(32);
}

/**
 * Delete the vault key from keychain.
 */
export async function deleteVaultKey(config: VaultKeyConfig = getDefaultKeyConfig()): Promise<boolean> {
    const kt = await loadKeytar();
    if (!kt) return false;

    try {
        const deleted = await kt.deletePassword(config.keychain.service, config.keychain.account);
        if (deleted) {
            cachedKey = null;
            cachedSource = null;
            logger.info({ service: config.keychain.service }, 'Vault key deleted from keychain');
        }
        return deleted;
    } catch {
        return false;
    }
}

/**
 * Get the source of the current vault key.
 */
export function getKeySource(): KeySource | null {
    return cachedSource;
}

/**
 * Check if keytar (OS keychain) is available.
 */
export async function isKeychainAvailable(): Promise<boolean> {
    const kt = await loadKeytar();
    if (!kt) return false;

    // Try a dummy operation to see if keychain is actually working
    try {
        // getPassword returns null if not found, but throws if keychain unavailable
        await kt.getPassword('lumo-tamer-test', 'connectivity-check');
        return true;
    } catch {
        return false;
    }
}

/**
 * Check if a key file exists at the configured path.
 */
export function isKeyFileAvailable(config: VaultKeyConfig = getDefaultKeyConfig()): boolean {
    return existsSync(config.keyFilePath);
}

/**
 * Clear the cached key (useful for testing or re-initialization).
 */
export function clearKeyCache(): void {
    cachedKey = null;
    cachedSource = null;
}

export { getDefaultKeyConfig as defaultKeyConfig };
