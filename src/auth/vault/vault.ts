/**
 * Encrypted Vault for Auth Tokens
 *
 * Stores authentication tokens encrypted with AES-256-GCM.
 * Key is retrieved from secure sources via key-provider.
 *
 * File format: [12-byte nonce][ciphertext][16-byte auth tag]
 *
 * Inspired by proton-bridge vault implementation.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, statSync } from 'fs';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { dirname } from 'path';
import { logger } from '../../app/logger.js';
import { getVaultKey, setVaultKey, generateVaultKey, isKeychainAvailable, isKeyFileAvailable, type VaultKeyConfig } from './key-provider.js';
import type { StoredTokens } from '../types.js';

const ALGORITHM = 'aes-256-gcm';
const NONCE_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

export interface VaultConfig {
    path: string;
    keyConfig: VaultKeyConfig;
}

/**
 * Encrypt data with AES-256-GCM.
 * Returns: [12-byte nonce][ciphertext][16-byte auth tag]
 */
function encrypt(plaintext: Buffer, key: Buffer): Buffer {
    const nonce = randomBytes(NONCE_LENGTH);
    const cipher = createCipheriv(ALGORITHM, key, nonce);

    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return Buffer.concat([nonce, encrypted, authTag]);
}

/**
 * Decrypt data with AES-256-GCM.
 * Input: [12-byte nonce][ciphertext][16-byte auth tag]
 */
function decrypt(ciphertext: Buffer, key: Buffer): Buffer {
    if (ciphertext.length < NONCE_LENGTH + AUTH_TAG_LENGTH) {
        throw new Error('Invalid vault file: too short');
    }

    const nonce = ciphertext.subarray(0, NONCE_LENGTH);
    const authTag = ciphertext.subarray(-AUTH_TAG_LENGTH);
    const encrypted = ciphertext.subarray(NONCE_LENGTH, -AUTH_TAG_LENGTH);

    const decipher = createDecipheriv(ALGORITHM, key, nonce);
    decipher.setAuthTag(authTag);

    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

/**
 * Read tokens from encrypted vault.
 */
export async function readVault(vaultPath: string, keyConfig?: VaultKeyConfig): Promise<StoredTokens> {
    if (!existsSync(vaultPath)) {
        throw new Error(`Vault not found: ${vaultPath}`);
    }

    const key = await getVaultKey(keyConfig);
    const ciphertext = readFileSync(vaultPath);

    try {
        const plaintext = decrypt(ciphertext, key);
        const tokens = JSON.parse(plaintext.toString('utf8')) as StoredTokens;
        logger.debug({ vaultPath }, 'Tokens loaded from vault');
        return tokens;
    } catch (err) {
        if (err instanceof Error && err.message.includes('Unsupported state')) {
            throw new Error('Failed to decrypt vault: wrong key or corrupted file');
        }
        throw err;
    }
}

/**
 * Write tokens to encrypted vault.
 * Creates directory if needed. Uses atomic write (temp file + rename).
 */
export async function writeVault(vaultPath: string, tokens: StoredTokens, keyConfig?: VaultKeyConfig): Promise<void> {
    // Ensure key exists (generate if needed on first write)
    let key: Buffer;
    try {
        key = await getVaultKey(keyConfig);
    } catch {
        // No key exists, try to generate one
        key = await ensureVaultKey(keyConfig);
    }

    const plaintext = Buffer.from(JSON.stringify(tokens, null, 2), 'utf8');
    const ciphertext = encrypt(plaintext, key);

    // Ensure directory exists
    const dir = dirname(vaultPath);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }

    // Check vaultPath isn't a directory (could happen if misconfigured)
    if (existsSync(vaultPath) && !statSync(vaultPath).isFile()) {
        throw new Error(
            `Vault ${vaultPath} is a directory, not a file.\n` +
            `Remove ${vaultPath} and try again.`
        );
    }

    // Atomic write: write to temp file, then rename
    const tempPath = `${vaultPath}.tmp`;
    writeFileSync(tempPath, ciphertext, { mode: 0o600 });

    // Rename (atomic on most filesystems)
    const { renameSync } = await import('fs');
    renameSync(tempPath, vaultPath);

    logger.debug({ vaultPath }, 'Tokens written to vault');
}

/**
 * Delete the vault file.
 */
export async function deleteVault(vaultPath: string): Promise<void> {
    if (existsSync(vaultPath)) {
        unlinkSync(vaultPath);
        logger.info({ vaultPath }, 'Vault deleted');
    }
}

/**
 * Ensure a vault key exists. Generate and store one if needed.
 */
export async function ensureVaultKey(keyConfig?: VaultKeyConfig): Promise<Buffer> {
    // First check if key already exists
    try {
        return await getVaultKey(keyConfig);
    } catch {
        // No key exists, continue to generate
    }

    // Check if keychain is available
    if (await isKeychainAvailable()) {
        const key = generateVaultKey();
        await setVaultKey(key, keyConfig);
        logger.info('Generated new vault key and stored in keychain');
        return key;
    }

    // Check if key file exists (user must have pre-created it)
    if (isKeyFileAvailable(keyConfig)) {
        // Key file exists but getVaultKey failed - something is wrong with the file
        throw new Error(
            'Key file exists but is invalid. Ensure it contains exactly 32 bytes (or base64 encoded).\n' +
            'Generate with: openssl rand -base64 32 > /path/to/key'
        );
    }

    // No secure storage available
    throw new Error(
        'Cannot generate vault key: no secure storage available.\n' +
        '- Desktop: Install system keychain (gnome-keyring, macOS Keychain, Windows Credential Manager)\n' +
        '- Docker: Create a secret with: openssl rand 32 > secrets/vault-key\n' +
        '  Then mount it at /run/secrets/lumo-vault-key in docker-compose.yml'
    );
}

/**
 * Decrypt vault and return JSON string (for debugging).
 */
export async function decryptVaultToJson(vaultPath: string, keyConfig?: VaultKeyConfig): Promise<string> {
    const tokens = await readVault(vaultPath, keyConfig);
    return JSON.stringify(tokens, null, 2);
}

/**
 * Check if a file looks like an encrypted vault (vs plaintext JSON).
 */
export function isEncryptedVault(filePath: string): boolean {
    if (!existsSync(filePath)) return false;

    const content = readFileSync(filePath);

    // Encrypted vault is binary, starts with random nonce
    // Plaintext JSON starts with '{' (0x7b)
    return content.length > 0 && content[0] !== 0x7b;
}
