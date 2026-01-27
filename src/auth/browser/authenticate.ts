/**
 * Browser Token Extractor - Core extraction logic
 *
 * Extracts auth tokens from an existing browser session via CDP.
 * This module exports functions that can be called programmatically
 * (by AuthManager for scheduled refresh) or via CLI (npm run extract-tokens).
 */

import * as readline from 'readline';
import { chromium, type Page, type BrowserContext, type Browser } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { promises as dns, ADDRCONFIG } from 'dns';
import type { PersistedSessionData } from '../../lumo-client/types.js';
import type { StoredTokens } from '../types.js';
import { authConfig, getConversationsConfig } from '../../app/config.js';
import { APP_VERSION_HEADER } from '../../proton-upstream/config.js';
import { PROTON_URLS } from '../../app/urls.js';
import { logger } from '../../app/logger.js';
import { decryptPersistedSession } from '../../conversations/session-keys.js';

export interface ExtractionOptions {
    /** CDP endpoint to connect to browser */
    cdpEndpoint: string;
    /** Target URL (Lumo) */
    targetUrl: string;
    /** Whether to fetch persistence keys (userKeys, masterKeys) */
    fetchPersistenceKeys: boolean;
    /** Proton app version for API calls */
    appVersion: string;
    /** Timeout for waiting for login (ms) */
    loginTimeout?: number;
}

export interface ExtractionResult {
    tokens: StoredTokens;
    warnings: string[];
    /** The CDP endpoint that was used (for saving back to config) */
    cdpEndpoint: string;
}

/**
 * Resolve CDP endpoint hostname to IP if needed
 */
async function resolveCdpEndpoint(endpoint: string): Promise<string> {
    const url = new URL(endpoint);
    const host = url.hostname;

    // Skip DNS resolution for localhost/IP addresses
    if (host === 'localhost' || host === '127.0.0.1' || /^\d+\.\d+\.\d+\.\d+$/.test(host)) {
        return endpoint;
    }

    try {
        const { address } = await dns.lookup(host, { family: 4, hints: ADDRCONFIG });
        return endpoint.replace(host, address);
    } catch {
        logger.warn(`DNS resolution failed for ${host}, using original endpoint`);
        return endpoint;
    }
}

/**
 * Extract persisted session from localStorage
 * Sessions are stored with key format: ps-{localID}
 */
function extractPersistedSession(
    localStorage: Record<string, string>,
    targetUid?: string
): PersistedSessionData | undefined {
    const sessionKeys = Object.keys(localStorage).filter(k => k.startsWith('ps-'));

    if (sessionKeys.length === 0) {
        if (!targetUid) {
            logger.warn('No persisted sessions found in localStorage');
        }
        return undefined;
    }

    if (!targetUid) {
        logger.info({ count: sessionKeys.length }, 'Found persisted session keys');
    }

    // Sort by localID to get the primary session first
    const sortedKeys = sessionKeys.sort((a, b) => {
        const idA = parseInt(a.replace('ps-', ''));
        const idB = parseInt(b.replace('ps-', ''));
        return idA - idB;
    });

    for (const key of sortedKeys) {
        try {
            const session = JSON.parse(localStorage[key]);
            if (!session.UID || !session.UserID) continue;

            // If target UID specified, only match that one
            if (targetUid && session.UID !== targetUid) continue;

            const persistedSession: PersistedSessionData = {
                localID: session.localID ?? parseInt(key.replace('ps-', '')),
                UserID: session.UserID,
                UID: session.UID,
                blob: session.blob,
                payloadVersion: session.payloadVersion ?? 1,
                persistedAt: session.persistedAt ?? Date.now(),
            };

            logger.info({
                key,
                UID: persistedSession.UID.slice(0, 12) + '...',
                hasBlob: !!persistedSession.blob,
                payloadVersion: persistedSession.payloadVersion,
                matchedTarget: !!targetUid,
            }, 'Found persisted session');

            return persistedSession;
        } catch {
            continue;
        }
    }

    return undefined;
}

/**
 * Fetch ClientKey from Proton API via browser context
 */
async function fetchClientKey(
    page: Page,
    uid: string,
    accessToken: string,
    appVersion: string
): Promise<string | undefined> {
    try {
        const currentUrl = page.url();
        logger.debug({ currentUrl, uid: uid.slice(0, 8) + '...' }, 'Fetching ClientKey');

        const result = await page.evaluate(async ({ uid, accessToken, appVersion }) => {
            try {
                const response = await fetch('/api/auth/v4/sessions/local/key', {
                    method: 'GET',
                    headers: {
                        'x-pm-uid': uid,
                        'x-pm-appversion': appVersion,
                        'Authorization': `Bearer ${accessToken}`,
                    },
                    credentials: 'include',
                });

                if (!response.ok) {
                    const text = await response.text().catch(() => '');
                    return { error: `HTTP ${response.status}`, status: response.status, body: text };
                }

                const data = await response.json();
                return { clientKey: data.ClientKey };
            } catch (err) {
                return { error: String(err) };
            }
        }, { uid, accessToken, appVersion });

        if ('error' in result) {
            logger.debug({ error: result.error, body: (result as { body?: string }).body?.slice(0, 200) }, 'ClientKey fetch failed from current domain');

            // If we're on Lumo, try navigating to account.proton.me
            if (currentUrl.includes('lumo.proton.me')) {
                logger.debug('Trying account.proton.me API');
                await page.goto(PROTON_URLS.ACCOUNT_BASE, { waitUntil: 'domcontentloaded' });
                await page.waitForTimeout(500);

                const retryResult = await page.evaluate(async ({ uid, accessToken, appVersion }) => {
                    try {
                        const response = await fetch('/api/auth/v4/sessions/local/key', {
                            method: 'GET',
                            headers: {
                                'x-pm-uid': uid,
                                'x-pm-appversion': appVersion,
                                'Authorization': `Bearer ${accessToken}`,
                            },
                            credentials: 'include',
                        });

                        if (!response.ok) {
                            return { error: `HTTP ${response.status}` };
                        }

                        const data = await response.json();
                        return { clientKey: data.ClientKey };
                    } catch (err) {
                        return { error: String(err) };
                    }
                }, { uid, accessToken, appVersion });

                await page.goto(currentUrl, { waitUntil: 'domcontentloaded' });

                if (!('error' in retryResult)) {
                    logger.info('Successfully fetched ClientKey from account.proton.me');
                    return retryResult.clientKey;
                }

                logger.warn({ error: retryResult.error }, 'ClientKey fetch also failed from account.proton.me');
            }

            return undefined;
        }

        logger.info('Successfully fetched ClientKey from API');
        return result.clientKey;
    } catch (error) {
        logger.warn({ error }, 'Failed to fetch ClientKey');
        return undefined;
    }
}

/**
 * Fetch user info (including keys) from Proton API via browser
 */
async function fetchUserInfo(
    page: Page,
    uid: string,
    accessToken: string,
    appVersion: string
): Promise<{ User: { Keys: Array<{ ID: string; PrivateKey: string; Primary: number; Active: number }> } } | undefined> {
    try {
        logger.info('Fetching user info via browser...');

        const currentUrl = page.url();
        if (!currentUrl.includes('account.proton.me')) {
            await page.goto(PROTON_URLS.ACCOUNT_BASE, { waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(500);
        }

        const result = await page.evaluate(async ({ uid, accessToken, appVersion }) => {
            try {
                const response = await fetch('/api/core/v4/users', {
                    method: 'GET',
                    headers: {
                        'x-pm-uid': uid,
                        'x-pm-appversion': appVersion,
                        'Authorization': `Bearer ${accessToken}`,
                    },
                    credentials: 'include',
                });

                if (!response.ok) {
                    const text = await response.text().catch(() => '');
                    return { error: `HTTP ${response.status}`, body: text };
                }

                const data = await response.json();
                return { user: data };
            } catch (err) {
                return { error: String(err) };
            }
        }, { uid, accessToken, appVersion });

        if (!currentUrl.includes('account.proton.me')) {
            await page.goto(currentUrl, { waitUntil: 'domcontentloaded' });
        }

        if ('error' in result) {
            logger.warn({ error: result.error }, 'Failed to fetch user info');
            return undefined;
        }

        const keyCount = result.user?.User?.Keys?.length ?? 0;
        logger.info({ keyCount }, 'Successfully fetched user info');
        return result.user;
    } catch (error) {
        logger.warn({ error }, 'Failed to fetch user info');
        return undefined;
    }
}

/**
 * Fetch master keys from Lumo API via browser
 */
async function fetchMasterKeys(
    page: Page,
    uid: string,
    accessToken: string,
    appVersion: string
): Promise<Array<{ ID: string; MasterKey: string; IsLatest: boolean; Version: number }> | undefined> {
    try {
        logger.info('Fetching master keys via browser...');

        const currentUrl = page.url();
        if (!currentUrl.includes('lumo.proton.me')) {
            await page.goto(PROTON_URLS.LUMO_BASE, { waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(500);
        }

        const result = await page.evaluate(async ({ uid, accessToken, appVersion }) => {
            try {
                const response = await fetch('/api/lumo/v1/masterkeys', {
                    method: 'GET',
                    headers: {
                        'x-pm-uid': uid,
                        'x-pm-appversion': appVersion,
                        'Authorization': `Bearer ${accessToken}`,
                    },
                    credentials: 'include',
                });

                if (!response.ok) {
                    const text = await response.text().catch(() => '');
                    return { error: `HTTP ${response.status}`, body: text };
                }

                const data = await response.json();
                return { masterKeys: data };
            } catch (err) {
                return { error: String(err) };
            }
        }, { uid, accessToken, appVersion });

        if (!currentUrl.includes('lumo.proton.me')) {
            await page.goto(currentUrl, { waitUntil: 'domcontentloaded' });
        }

        if ('error' in result) {
            logger.warn({ error: result.error }, 'Failed to fetch master keys');
            return undefined;
        }

        const masterKeys = result.masterKeys?.MasterKeys ?? [];
        logger.info({ count: masterKeys.length }, 'Successfully fetched master keys');
        return masterKeys.map((k: { ID: string; MasterKey: string; IsLatest: boolean; Version: number }) => ({
            ID: k.ID,
            MasterKey: k.MasterKey,
            IsLatest: k.IsLatest,
            Version: k.Version,
        }));
    } catch (error) {
        logger.warn({ error }, 'Failed to fetch master keys');
        return undefined;
    }
}

/**
 * Connect to browser and get page for extraction
 */
async function connectAndGetPage(
    cdpEndpoint: string,
    targetUrl: string,
    loginTimeout: number
): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
    const resolvedEndpoint = await resolveCdpEndpoint(cdpEndpoint);
    logger.info({ cdpEndpoint, resolvedEndpoint }, 'Connecting to browser');

    const browser = await chromium.connectOverCDP(resolvedEndpoint);

    const contexts = browser.contexts();
    if (contexts.length === 0) {
        await browser.close();
        throw new Error('No browser contexts found. Is the browser running?');
    }

    const context = contexts[0];
    const pages = context.pages();

    logger.info({ pageCount: pages.length }, 'Found pages in browser context');

    // Check if already on Lumo
    let page = pages.find(p => p.url().includes('lumo.proton.me'));

    if (!page) {
        logger.info({ targetUrl }, 'No Lumo page found, navigating...');
        page = pages[0] || await context.newPage();
        await page.goto(targetUrl);
    }

    const currentUrl = page.url();
    logger.info({ currentUrl }, 'Current URL');

    // Check if logged in
    if (currentUrl.includes('account.proton') || currentUrl.includes('/login')) {
        logger.warn('Not logged in. Please log in manually in the browser.');
        logger.info('Waiting for login...');

        try {
            await page.waitForURL(/lumo\.proton\.me\/(chat|c\/|$)/, { timeout: loginTimeout });
            logger.info('Login detected!');
        } catch {
            await browser.close();
            throw new Error('Login timeout. Please log in and try again.');
        }
    }

    return { browser, context, page };
}

/**
 * Extract tokens from browser session
 *
 * This is the main extraction function that can be called programmatically.
 * It connects to the browser, extracts cookies and localStorage, and optionally
 * fetches persistence keys.
 *
 * @param options - Extraction options
 * @returns Extracted tokens and any warnings
 */
export async function extractBrowserTokens(options: ExtractionOptions): Promise<ExtractionResult> {
    const warnings: string[] = [];
    const { cdpEndpoint, targetUrl, fetchPersistenceKeys, appVersion, loginTimeout = 120000 } = options;

    logger.info('=== Browser Token Extraction ===');

    const { browser, context, page } = await connectAndGetPage(cdpEndpoint, targetUrl, loginTimeout);

    try {
        // Extract storage state (cookies + localStorage)
        logger.info('Extracting authentication data...');
        const state = await context.storageState();

        // Filter relevant cookies
        const relevantCookies = state.cookies.filter(c =>
            c.domain.includes('proton.me') ||
            c.domain.includes('proton.ch')
        );

        logger.info({ cookieCount: relevantCookies.length }, 'Found Proton cookies');

        // Find all AUTH cookies (we'll select the right one after determining active session)
        const lumoAuthCookies = relevantCookies.filter(
            c => c.name.startsWith('AUTH-') && c.domain.includes('lumo.proton.me')
        );
        const accountAuthCookies = relevantCookies.filter(
            c => c.name.startsWith('AUTH-') && c.domain.includes('account.proton.me')
        );

        if (lumoAuthCookies.length === 0) {
            throw new Error('No AUTH-* cookie found for lumo.proton.me. Make sure you are logged in to Lumo.');
        }

        logger.info({ lumoAuthCount: lumoAuthCookies.length, accountAuthCount: accountAuthCookies.length }, 'Found AUTH cookies');

        // Extract localStorage from origins
        const lumoOrigin = state.origins.find(o => o.origin.includes('lumo.proton.me'));
        const accountOrigin = state.origins.find(o => o.origin.includes('account.proton.me'));

        const localStorage: Record<string, string> = {};
        const accountLocalStorage: Record<string, string> = {};

        if (lumoOrigin) {
            for (const item of lumoOrigin.localStorage) {
                localStorage[item.name] = item.value;
            }
            logger.info({ count: Object.keys(localStorage).length, origin: 'lumo.proton.me' }, 'Found localStorage items');
        }

        if (accountOrigin) {
            for (const item of accountOrigin.localStorage) {
                accountLocalStorage[item.name] = item.value;
            }
            logger.info({ count: Object.keys(accountLocalStorage).length, origin: 'account.proton.me' }, 'Found localStorage items');
        }

        // Try direct page evaluation for localStorage and active session UID
        let directLocalStorage: Record<string, string> = {};
        let activeSessionUid: string | undefined;
        try {
            const result = await page.evaluate(() => {
                const items: Record<string, string> = {};
                for (let i = 0; i < window.localStorage.length; i++) {
                    const key = window.localStorage.key(i);
                    if (key) {
                        items[key] = window.localStorage.getItem(key) || '';
                    }
                }
                const activeUid = window.sessionStorage.getItem('ua_uid') || undefined;
                return { localStorage: items, activeUid };
            });
            directLocalStorage = result.localStorage;
            activeSessionUid = result.activeUid;
            logger.info({ count: Object.keys(directLocalStorage).length }, 'Direct localStorage extraction');
            if (activeSessionUid) {
                logger.info({ activeSessionUid: activeSessionUid.slice(0, 12) + '...' }, 'Found active session UID');
            }
        } catch (e) {
            logger.warn({ error: e }, 'Failed to extract localStorage directly from page');
        }

        // Determine which AUTH cookie to use based on active session
        // Priority: active session > first available
        let primaryLumoAuthCookie: typeof lumoAuthCookies[0] | undefined;
        let primaryAccountAuthCookie: typeof accountAuthCookies[0] | undefined;

        if (activeSessionUid) {
            // Try to find AUTH cookie matching the active session
            primaryLumoAuthCookie = lumoAuthCookies.find(c => c.name === `AUTH-${activeSessionUid}`);
            primaryAccountAuthCookie = accountAuthCookies.find(c => c.name === `AUTH-${activeSessionUid}`);

            if (!primaryLumoAuthCookie) {
                throw new Error(
                    'Browser session is not authenticated.\n' +
                    'The active session has no valid AUTH cookie. Please log in to Lumo in your browser.'
                );
            }

            logger.info({ uid: activeSessionUid.slice(0, 8) + '...' }, 'Using active session auth');
        } else {
            // Fallback to first available
            primaryLumoAuthCookie = lumoAuthCookies[0];
            primaryAccountAuthCookie = accountAuthCookies[0];
            logger.info({ uid: primaryLumoAuthCookie.name.replace('AUTH-', '').slice(0, 8) + '...' }, 'Using first available Lumo auth (no active session)');
        }

        // Extract persisted session - prioritize matching active session UID
        let persistedSession: PersistedSessionData | undefined;

        if (activeSessionUid) {
            persistedSession = extractPersistedSession(directLocalStorage, activeSessionUid);
            if (!persistedSession) {
                persistedSession = extractPersistedSession(localStorage, activeSessionUid);
            }
            if (!persistedSession) {
                persistedSession = extractPersistedSession(accountLocalStorage, activeSessionUid);
            }
        }

        // Fallback to any available session
        if (!persistedSession) {
            persistedSession = extractPersistedSession(directLocalStorage);
        }
        if (!persistedSession) {
            persistedSession = extractPersistedSession(localStorage);
        }
        if (!persistedSession) {
            persistedSession = extractPersistedSession(accountLocalStorage);
        }

        // Fetch persistence keys if requested
        let userKeys: StoredTokens['userKeys'];
        let masterKeys: StoredTokens['masterKeys'];

        if (fetchPersistenceKeys) {
            logger.info('Fetching encryption keys for persistence...');

            // Fetch ClientKey if we have a persisted session with a blob
            if (persistedSession?.blob) {
                const matchingAuthCookie = relevantCookies.find(
                    c => c.name === `AUTH-${persistedSession.UID}` && c.domain.includes('account.proton.me')
                ) || relevantCookies.find(
                    c => c.name === `AUTH-${persistedSession.UID}` && c.domain.includes('lumo.proton.me')
                );

                const authCookie = matchingAuthCookie || primaryAccountAuthCookie || primaryLumoAuthCookie;
                if (authCookie) {
                    const uid = authCookie.name.replace('AUTH-', '');
                    const accessToken = authCookie.value;

                    logger.info({ uid: uid.slice(0, 8) + '...' }, 'Fetching ClientKey from API...');
                    const clientKey = await fetchClientKey(page, uid, accessToken, appVersion);

                    if (clientKey) {
                        persistedSession.clientKey = clientKey;

                        // Verify decryption works
                        try {
                            const decrypted = await decryptPersistedSession(persistedSession);
                            logger.info({ type: decrypted.type }, 'Successfully verified keyPassword extraction');
                        } catch (err) {
                            logger.error({ err }, 'ClientKey fetch succeeded but decryption failed');
                            persistedSession.clientKey = undefined;
                            warnings.push('ClientKey fetch succeeded but decryption failed');
                        }
                    }
                }
            }

            // Fetch user keys
            if (persistedSession?.clientKey) {
                const matchingAuthCookie = relevantCookies.find(
                    c => c.name === `AUTH-${persistedSession.UID}` && c.domain.includes('account.proton.me')
                ) || relevantCookies.find(
                    c => c.name === `AUTH-${persistedSession.UID}` && c.domain.includes('lumo.proton.me')
                );
                const authCookieForUserInfo = matchingAuthCookie || primaryAccountAuthCookie || primaryLumoAuthCookie;

                if (authCookieForUserInfo) {
                    const uid = authCookieForUserInfo.name.replace('AUTH-', '');
                    const accessToken = authCookieForUserInfo.value;
                    const userInfo = await fetchUserInfo(page, uid, accessToken, appVersion);
                    if (userInfo?.User?.Keys) {
                        userKeys = userInfo.User.Keys.map(k => ({
                            ID: k.ID,
                            PrivateKey: k.PrivateKey,
                            Primary: k.Primary,
                            Active: k.Active,
                        }));
                        logger.info({ keyCount: userKeys.length }, 'Cached user keys');
                    }
                }
            }

            // Fetch master keys
            if (persistedSession?.clientKey) {
                const lumoAuthForMasterKeys = relevantCookies.find(
                    c => c.name === `AUTH-${persistedSession.UID}` && c.domain.includes('lumo.proton.me')
                ) || primaryLumoAuthCookie;

                if (lumoAuthForMasterKeys) {
                    const uid = lumoAuthForMasterKeys.name.replace('AUTH-', '');
                    const accessToken = lumoAuthForMasterKeys.value;
                    const fetchedMasterKeys = await fetchMasterKeys(page, uid, accessToken, appVersion);
                    if (fetchedMasterKeys && fetchedMasterKeys.length > 0) {
                        masterKeys = fetchedMasterKeys;
                        logger.info({ keyCount: masterKeys.length }, 'Cached master keys');
                    }
                }
            }
        } else {
            logger.info('Skipping encryption key extraction (persistence disabled)');
        }

        // Determine output uid/accessToken - use the primary (active session) auth
        let outputUid = primaryLumoAuthCookie!.name.replace('AUTH-', '');
        let outputAccessToken = primaryLumoAuthCookie!.value;

        if (persistedSession) {
            const matchingLumoAuth = relevantCookies.find(
                c => c.name === `AUTH-${persistedSession.UID}` && c.domain.includes('lumo.proton.me')
            );
            if (matchingLumoAuth) {
                outputUid = matchingLumoAuth.name.replace('AUTH-', '');
                outputAccessToken = matchingLumoAuth.value;
                logger.info({ uid: outputUid.slice(0, 8) + '...' }, 'Using session-matching auth for output');
            }
        }

        // Extract REFRESH cookie for token refresh without browser
        // The REFRESH-{uid} cookie contains the refresh token in JSON format
        // Cookie is set on account.proton.me with path /api/auth/refresh
        const allRefreshCookies = relevantCookies.filter(c => c.name.startsWith('REFRESH-'));
        logger.debug({
            count: allRefreshCookies.length,
            cookies: allRefreshCookies.map(c => ({ name: c.name, domain: c.domain }))
        }, 'Found REFRESH cookies');

        const refreshCookie = allRefreshCookies.find(c => c.name === `REFRESH-${outputUid}`);

        let refreshToken: string | undefined;
        if (refreshCookie) {
            try {
                const decoded = JSON.parse(decodeURIComponent(refreshCookie.value));
                refreshToken = decoded.RefreshToken;
                logger.info({ uid: outputUid.slice(0, 8) + '...' }, 'Extracted refresh token from REFRESH cookie');
            } catch (e) {
                logger.warn({ error: e }, 'Failed to parse REFRESH cookie');
            }
        } else {
            logger.warn({ uid: outputUid.slice(0, 8) + '...', availableRefresh: allRefreshCookies.map(c => c.name) },
                'No REFRESH cookie found for active session - token refresh will require re-extraction');
        }

        // Build result
        const tokens: StoredTokens = {
            method: 'browser',
            uid: outputUid,
            accessToken: outputAccessToken,
            refreshToken,
            extractedAt: new Date().toISOString(),
            persistedSession,
            userKeys,
            masterKeys,
        };

        // Add warnings for missing data (only if persistence was requested)
        if (fetchPersistenceKeys) {
            if (persistedSession?.blob && !persistedSession?.clientKey) {
                warnings.push('Persisted session blob found but ClientKey fetch failed');
            } else if (!persistedSession?.blob) {
                warnings.push('No persisted session blob found - local-only encryption will be used');
            }
        }

        return { tokens, warnings, cdpEndpoint };
    } finally {
        // Don't close the browser - it's shared with lumo-bridge
        logger.debug('Browser connection closed, browser continues running');
    }
}

/**
 * Prompt user for CDP endpoint
 */
async function promptForCdpEndpoint(defaultEndpoint?: string): Promise<string> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const defaultValue = defaultEndpoint || 'http://localhost:9222';

    return new Promise(resolve => {
        rl.question(`CDP endpoint [${defaultValue}]: `, answer => {
            rl.close();
            resolve(answer.trim() || defaultValue);
        });
    });
}

/**
 * Run browser authentication
 *
 * Prompts for CDP endpoint, extracts tokens from browser session, and saves to file.
 * Used by CLI (npm run auth) for browser authentication method.
 *
 * @param outputPath - Path to save tokens
 * @returns Extraction result
 */
export async function runBrowserAuthentication(outputPath: string): Promise<ExtractionResult> {
    const configEndpoint = authConfig.browser?.cdpEndpoint;
    const cdpEndpoint = await promptForCdpEndpoint(configEndpoint);

    const syncEnabled = getConversationsConfig().sync.enabled;

    const result = await extractBrowserTokens({
        cdpEndpoint,
        targetUrl: PROTON_URLS.LUMO_BASE,
        fetchPersistenceKeys: syncEnabled,
        appVersion: APP_VERSION_HEADER,
    });

    // Ensure output directory exists
    mkdirSync(dirname(outputPath), { recursive: true });

    // Write tokens
    writeFileSync(outputPath, JSON.stringify(result.tokens, null, 2));
    logger.info({ outputPath }, 'Tokens saved');

    return result;
}
