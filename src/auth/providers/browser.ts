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
    Cookie,
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

        // Validate we have browser tokens (has cookies)
        if (!this.tokens.cookies || this.tokens.cookies.length === 0) {
            throw new Error(
                'Token file does not contain browser cookies.\n' +
                'Run: npm run extract-tokens'
            );
        }

        const tokenAge = this.getTokenAgeHours();
        logger.info({
            extractedAt: this.tokens.extractedAt,
            ageHours: tokenAge.toFixed(1),
            cookieCount: this.tokens.cookies.length,
        }, 'Browser tokens loaded');

        if (!this.isValid()) {
            logger.warn('Some cookies have expired. Re-run extract-tokens if you get auth errors.');
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
        const authCookie = this.getAuthCookie();
        if (!authCookie) {
            throw new Error('No AUTH cookie found');
        }
        return authCookie.name.replace('AUTH-', '');
    }

    getKeyPassword(): string | undefined {
        return this.keyPassword;
    }

    createApi(): ProtonApi {
        if (!this.tokens?.cookies) {
            throw new Error('Not authenticated');
        }

        const authCookie = this.getAuthCookie();
        if (!authCookie) {
            throw new Error('No AUTH cookie found for lumo.proton.me');
        }

        const uid = authCookie.name.replace('AUTH-', '');
        const accessToken = authCookie.value;

        // Build cookie header from all cookies
        const cookieHeader = this.tokens.cookies
            .map((c) => `${c.name}=${c.value}`)
            .join('; ');

        return createProtonApi({
            uid,
            accessToken,
            cookies: cookieHeader,
        });
    }

    isValid(): boolean {
        if (!this.tokens?.cookies) return false;
        const now = Date.now() / 1000; // Convert to seconds
        // Check if any cookie has expired
        return !this.tokens.cookies.some((c) => c.expires > 0 && c.expires < now);
    }

    isNearExpiry(): boolean {
        if (!this.tokens?.cookies) return false;
        const fiveMinutesFromNow = (Date.now() / 1000) + (5 * 60);
        // Check if any cookie expires within 5 minutes
        return this.tokens.cookies.some((c) => c.expires > 0 && c.expires < fiveMinutesFromNow);
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

        status.details.cookieCount = this.tokens.cookies?.length ?? 0;
        status.details.extractedAt = this.tokens.extractedAt;
        status.details.hasPersistedSession = !!this.tokens.persistedSession;

        const ageHours = this.getTokenAgeHours();
        status.details.age = this.formatDuration(ageHours);

        if (!this.isValid()) {
            status.warnings.push('Some cookies have expired');
            status.warnings.push('Run: npm run extract-tokens');
        } else {
            status.valid = true;
        }

        // Find AUTH cookie to show UID
        const authCookie = this.getAuthCookie();
        if (authCookie) {
            const uid = authCookie.name.replace('AUTH-', '');
            status.details.uid = uid.slice(0, 12) + '...';
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

    private getAuthCookie(): Cookie | undefined {
        if (!this.tokens?.cookies) return undefined;

        // Prefer cookie matching persisted session UID
        const persistedSessionUid = this.tokens.persistedSession?.UID;
        if (persistedSessionUid) {
            const matchingCookie = this.tokens.cookies.find(
                (c) => c.name === `AUTH-${persistedSessionUid}` && c.domain.includes('lumo.proton.me')
            );
            if (matchingCookie) return matchingCookie;
        }

        // Fallback to any lumo AUTH cookie
        return this.tokens.cookies.find(
            (c) => c.name.startsWith('AUTH-') && c.domain.includes('lumo.proton.me')
        );
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
