/**
 * Browser Auth Provider
 *
 * Uses tokens extracted from browser session via Playwright.
 * No automatic refresh - user must re-run npm run extract-tokens.
 */

import { readFileSync, existsSync } from 'fs';
import { logger } from '../../logger.js';
import { authConfig } from '../../config.js';
import { decryptPersistedSession } from '../../persistence/session-keys.js';
import { createProtonApi } from '../api-factory.js';
import type {
    AuthProvider,
    AuthProviderStatus,
    StoredTokens,
    ProtonApi,
    CachedUserKey,
    CachedMasterKey,
} from '../types.js';

export class BrowserAuthProvider implements AuthProvider {
    readonly method = 'browser' as const;

    private tokens: StoredTokens | null = null;
    private tokenCachePath: string;
    private keyPassword?: string;

    constructor() {
        this.tokenCachePath = authConfig?.tokenCachePath ?? 'sessions/auth-tokens.json';
    }

    async initialize(): Promise<void> {
        if (!existsSync(this.tokenCachePath)) {
            throw new Error(
                `Token file not found: ${this.tokenCachePath}\n` +
                'Run: npm run extract-tokens'
            );
        }

        const data = readFileSync(this.tokenCachePath, 'utf-8');
        this.tokens = JSON.parse(data) as StoredTokens;

        // Validate we have required fields
        if (!this.tokens.uid || !this.tokens.accessToken) {
            throw new Error(
                'Token file missing uid or accessToken.\n' +
                'Run: npm run extract-tokens'
            );
        }

        const tokenAge = this.getTokenAgeHours();
        logger.info({
            extractedAt: this.tokens.extractedAt,
            ageHours: tokenAge.toFixed(1),
            uid: this.tokens.uid.slice(0, 8) + '...',
        }, 'Browser tokens loaded');

        if (!this.isValid()) {
            logger.warn('Tokens likely expired (>24h old). Re-run extract-tokens if you get auth errors.');
        }

        // Try to extract keyPassword from persisted session
        if (this.tokens.persistedSession?.blob && this.tokens.persistedSession?.clientKey) {
            try {
                const decrypted = await decryptPersistedSession(this.tokens.persistedSession);
                this.keyPassword = decrypted.keyPassword;
                logger.info('Extracted keyPassword from browser session');
            } catch (err) {
                logger.warn({ err }, 'Failed to decrypt browser session - keyPassword unavailable');
            }
        } else {
            logger.debug({
                hasBlob: !!this.tokens.persistedSession?.blob,
                hasClientKey: !!this.tokens.persistedSession?.clientKey,
            }, 'Browser session missing blob or clientKey - keyPassword unavailable');
        }

        if (this.tokens.userKeys && this.tokens.userKeys.length > 0) {
            logger.info({ keyCount: this.tokens.userKeys.length }, 'Loaded cached user keys');
        }

        if (this.tokens.masterKeys && this.tokens.masterKeys.length > 0) {
            logger.info({ keyCount: this.tokens.masterKeys.length }, 'Loaded cached master keys');
        }
    }

    getUid(): string {
        if (!this.tokens?.uid) {
            throw new Error('Not authenticated');
        }
        return this.tokens.uid;
    }

    getKeyPassword(): string | undefined {
        return this.keyPassword;
    }

    createApi(): ProtonApi {
        if (!this.tokens?.uid || !this.tokens?.accessToken) {
            throw new Error('Not authenticated');
        }

        return createProtonApi({
            uid: this.tokens.uid,
            accessToken: this.tokens.accessToken,
            // No cookies needed - API works with uid + accessToken headers only
        });
    }

    isValid(): boolean {
        if (!this.tokens?.uid || !this.tokens?.accessToken) return false;
        // Tokens typically valid for ~24h
        const ageHours = this.getTokenAgeHours();
        return ageHours < 24;
    }

    isNearExpiry(): boolean {
        if (!this.tokens) return false;
        const ageHours = this.getTokenAgeHours();
        // Consider "near expiry" if within last hour of 24h window
        return ageHours > 23;
    }

    getStatus(): AuthProviderStatus {
        const status: AuthProviderStatus = {
            method: 'browser',
            source: this.tokenCachePath,
            valid: false,
            details: {},
            warnings: [],
        };

        if (!this.tokens) {
            status.warnings.push(`Token file not found: ${this.tokenCachePath}`);
            status.warnings.push('Run: npm run extract-tokens');
            return status;
        }

        status.details.extractedAt = this.tokens.extractedAt;
        status.details.hasPersistedSession = !!this.tokens.persistedSession;

        const ageHours = this.getTokenAgeHours();
        status.details.age = this.formatDuration(ageHours);

        if (!this.isValid()) {
            status.warnings.push('Tokens likely expired (>24h old)');
            status.warnings.push('Run: npm run extract-tokens');
        } else {
            status.valid = true;
        }

        // Show UID
        if (this.tokens.uid) {
            status.details.uid = this.tokens.uid.slice(0, 12) + '...';
        }

        // Check keyPassword availability
        status.details.hasKeyPassword = !!this.keyPassword;
        if (!this.keyPassword) {
            if (!this.tokens.persistedSession?.blob) {
                status.warnings.push('No persisted session blob found');
            }
            if (!this.tokens.persistedSession?.clientKey) {
                status.warnings.push('No clientKey available - run extract-tokens');
            }
        }

        return status;
    }

    getCachedUserKeys(): CachedUserKey[] | undefined {
        return this.tokens?.userKeys;
    }

    getCachedMasterKeys(): CachedMasterKey[] | undefined {
        return this.tokens?.masterKeys;
    }

    private getTokenAgeHours(): number {
        if (!this.tokens?.extractedAt) return 0;
        const extractedAt = new Date(this.tokens.extractedAt).getTime();
        return (Date.now() - extractedAt) / (1000 * 60 * 60);
    }

    private formatDuration(hours: number): string {
        if (hours < 1) {
            return `${Math.round(hours * 60)} minutes`;
        } else if (hours < 24) {
            return `${hours.toFixed(1)} hours`;
        } else {
            return `${(hours / 24).toFixed(1)} days`;
        }
    }
}
