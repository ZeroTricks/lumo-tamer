/**
 * Rclone Auth Provider
 *
 * Uses tokens extracted from rclone config via npm run extract-rclone.
 * Supports automatic token refresh since rclone extraction includes refreshToken.
 */

import { logger } from '../../app/logger.js';
import { authConfig } from '../../app/config.js';
import { resolveProjectPath } from '../../app/paths.js';
import { BaseAuthProvider, type ProviderConfig } from './base.js';
import type { AuthProviderStatus } from '../types.js';

function getProviderConfig(): ProviderConfig {
    return {
        vaultPath: resolveProjectPath(authConfig.vault.path),
        keyConfig: {
            keychain: authConfig.vault.keychain,
            keyFilePath: authConfig.vault.keyFilePath,
        },
    };
}

export class RcloneAuthProvider extends BaseAuthProvider {
    readonly method = 'rclone' as const;

    constructor() {
        super(getProviderConfig());
    }

    protected override validateMethod(): void {
        if (this.tokens?.method !== 'rclone') {
            throw new Error(
                `Token file is not from rclone extraction (method: ${this.tokens?.method}).\n` +
                'Run: npm run auth and select rclone'
            );
        }
    }

    protected override async onAfterLoad(): Promise<void> {
        logger.debug({
            uid: this.tokens!.uid.slice(0, 12) + '...',
            hasKeyPassword: !!this.tokens!.keyPassword,
            extractedAt: this.tokens!.extractedAt,
        }, 'Rclone tokens loaded');
    }

    isValid(): boolean {
        // Rclone doesn't track expiry - tokens are managed externally
        // We assume valid if we have tokens
        return !!this.tokens?.accessToken;
    }

    isNearExpiry(): boolean {
        // Check if tokens are near expiry (if we have expiresAt from a previous refresh)
        if (!this.tokens?.expiresAt) return false;
        const expiresAt = new Date(this.tokens.expiresAt);
        const fiveMinutesFromNow = new Date(Date.now() + 5 * 60 * 1000);
        return expiresAt <= fiveMinutesFromNow;
    }

    supportsPersistence(): boolean {
        return false;  // Rclone tokens lack lumo scope for spaces API
    }

    getStatus(): AuthProviderStatus {
        const status: AuthProviderStatus = {
            method: 'rclone',
            source: this.config.vaultPath,
            valid: false,
            details: {},
            warnings: [],
        };

        if (!this.tokens) {
            status.warnings.push(`Vault not found: ${this.config.vaultPath}`);
            status.warnings.push('Run: npm run auth');
            return status;
        }

        status.details.uid = this.tokens.uid?.slice(0, 12) + '...';
        status.details.hasKeyPassword = !!this.tokens.keyPassword;
        status.details.extractedAt = this.tokens.extractedAt;
        status.details.expiresAt = 'not tracked (managed by rclone)';

        if (!this.tokens.keyPassword) {
            status.warnings.push('keyPassword missing - conversation persistence disabled');
        }

        if (!this.tokens.accessToken) {
            status.warnings.push('Missing access token');
            status.warnings.push('Run: npm run extract-rclone');
        } else {
            status.valid = true;
        }

        return status;
    }
}
