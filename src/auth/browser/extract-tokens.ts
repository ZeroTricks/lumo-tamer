/**
 * Extract auth tokens from existing browser session
 * Uses the same CDP connection as lumo-bridge
 *
 * Extended to also extract persisted session data for conversation persistence
 *
 * Usage: npm run extract-tokens
 */

import { chromium, type Page } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { promises as dns, ADDRCONFIG } from 'dns';
import type { PersistedSessionData } from '../../lumo-client/types.js';
import type { StoredTokens } from '../types.js';
import { browserConfig, authConfig, protonConfig, getPersistenceConfig } from '../../app/config.js';
import { logger } from '../../app/logger.js';
import { decryptPersistedSession } from '../../persistence/session-keys.js';

// Check if persistence is enabled (determines whether to fetch extra keys)
const persistenceEnabled = getPersistenceConfig()?.enabled ?? false;

// Validate required config
if (!browserConfig?.cdpEndpoint) {
    logger.error('browser.cdpEndpoint is required in config.yaml for token extraction');
    process.exit(1);
}
if (!browserConfig?.url) {
    logger.error('browser.url is required in config.yaml for token extraction');
    process.exit(1);
}

const cdpEndpoint = browserConfig.cdpEndpoint;
const targetUrl = browserConfig.url;
const outputPath = join(process.cwd(), authConfig.tokenCachePath);

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
 * If targetUid is provided, only return session if it matches that UID
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
 * Fetch ClientKey from Proton API
 * This key is used to decrypt the persisted session blob
 *
 * The API endpoint is /api/auth/v4/sessions/local/key and must be called
 * from a Proton domain with valid session cookies.
 */
async function fetchClientKey(
    page: Page,
    uid: string,
    accessToken: string,
    appVersion: string
): Promise<string | undefined> {
    try {
        const currentUrl = page.url();

        // Try calling from current page first (if on a Proton domain)
        // This uses the current domain's API proxy
        logger.debug({ currentUrl, uid: uid.slice(0, 8) + '...' }, 'Fetching ClientKey');

        const result = await page.evaluate(async ({ uid, accessToken, appVersion }) => {
            try {
                // Use relative URL - will be proxied by the current domain
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
                await page.goto('https://account.proton.me/', { waitUntil: 'domcontentloaded' });
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

                // Navigate back
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
 * This bypasses the scope limitation since the browser has full access
 */
async function fetchUserInfo(
    page: Page,
    uid: string,
    accessToken: string,
    appVersion: string
): Promise<{ User: { Keys: Array<{ ID: string; PrivateKey: string; Primary: number; Active: number }> } } | undefined> {
    try {
        logger.info('Fetching user info via browser...');

        // Navigate to account.proton.me for API access
        const currentUrl = page.url();
        if (!currentUrl.includes('account.proton.me')) {
            await page.goto('https://account.proton.me/', { waitUntil: 'domcontentloaded' });
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

        // Navigate back to Lumo
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
 * This bypasses the scope limitation since the browser has full access
 */
async function fetchMasterKeys(
    page: Page,
    uid: string,
    accessToken: string,
    appVersion: string
): Promise<Array<{ ID: string; MasterKey: string; IsLatest: boolean; Version: number }> | undefined> {
    try {
        logger.info('Fetching master keys via browser...');

        // Navigate to lumo.proton.me for API access (lumo endpoint needs lumo domain)
        const currentUrl = page.url();
        if (!currentUrl.includes('lumo.proton.me')) {
            await page.goto('https://lumo.proton.me/', { waitUntil: 'domcontentloaded' });
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

        // Navigate back if needed
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

async function extractTokens(): Promise<void> {
    logger.info('=== Lumo Auth Token Extraction (Extended) ===');

    const resolvedEndpoint = await resolveCdpEndpoint(cdpEndpoint);
    logger.info({ cdpEndpoint, resolvedEndpoint }, 'Connecting to browser');

    let browser;
    try {
        browser = await chromium.connectOverCDP(resolvedEndpoint);
    } catch (error) {
        logger.error({ error, resolvedEndpoint }, 'Failed to connect to browser');

        logger.error('Make sure the browser container is running. Check browser.cdpEndpoint in config.yaml.');
        process.exit(1);
    }

    const contexts = browser.contexts();
    if (contexts.length === 0) {
        logger.error('No browser contexts found. Is the browser running?');
        await browser.close();
        process.exit(1);
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

    // Check if logged in (URL should be /chat/* or similar, not login page)
    if (currentUrl.includes('account.proton') || currentUrl.includes('/login')) {
        logger.warn('Not logged in. Please log in manually in the browser.');
        logger.info('Waiting for login (timeout: 2 minutes)...');

        try {
            await page.waitForURL(/lumo\.proton\.me\/(chat|c\/|$)/, { timeout: 120000 });
            logger.info('Login detected!');
        } catch {
            logger.error('Login timeout. Please log in and run this script again.');
            await browser.close();
            process.exit(1);
        }
    }

    // Extract storage state (cookies + localStorage)
    logger.info('Extracting authentication data...');
    const state = await context.storageState();

    // Filter relevant cookies
    const relevantCookies = state.cookies.filter(c =>
        c.domain.includes('proton.me') ||
        c.domain.includes('proton.ch')
    );

    logger.info({ cookieCount: relevantCookies.length }, 'Found Proton cookies');
    for (const cookie of relevantCookies) {
        const expiresIn = cookie.expires > 0
            ? `expires in ${Math.round((cookie.expires - Date.now() / 1000) / 3600)}h`
            : 'session';
        logger.debug({ name: cookie.name, domain: cookie.domain, expiresIn }, 'Cookie');
    }

    // Check for essential cookies
    // UID is embedded in AUTH cookie name: AUTH-{uid}
    const lumoAuthCookie = relevantCookies.find(
        c => c.name.startsWith('AUTH-') && c.domain.includes('lumo.proton.me')
    );
    const accountAuthCookie = relevantCookies.find(
        c => c.name.startsWith('AUTH-') && c.domain.includes('account.proton.me')
    );

    if (!lumoAuthCookie) {
        logger.error('No AUTH-* cookie found for lumo.proton.me. Make sure you are logged in to Lumo.');
        process.exit(1);
    }
    const lumoUid = lumoAuthCookie.name.replace('AUTH-', '');
    logger.info({ uid: lumoUid.slice(0, 8) + '...' }, 'Found Lumo auth');

    // Extract localStorage from both origins
    const lumoOrigin = state.origins.find(o => o.origin.includes('lumo.proton.me'));
    const accountOrigin = state.origins.find(o => o.origin.includes('account.proton.me'));

    logger.debug({ origins: state.origins.map(o => o.origin) }, 'All origins in storage state');

    const localStorage: Record<string, string> = {};

    // Lumo localStorage
    if (lumoOrigin) {
        for (const item of lumoOrigin.localStorage) {
            localStorage[item.name] = item.value;
        }
        logger.info({ count: Object.keys(localStorage).length, origin: 'lumo.proton.me' }, 'Found localStorage items');
        logger.debug({ keys: Object.keys(localStorage) }, 'Lumo localStorage keys');
    } else {
        logger.warn('No lumo.proton.me origin found in storage state');
    }

    // Account localStorage (persisted sessions are often here)
    const accountLocalStorage: Record<string, string> = {};
    if (accountOrigin) {
        for (const item of accountOrigin.localStorage) {
            accountLocalStorage[item.name] = item.value;
        }
        logger.info({ count: Object.keys(accountLocalStorage).length, origin: 'account.proton.me' }, 'Found localStorage items');
        logger.debug({ keys: Object.keys(accountLocalStorage) }, 'Account localStorage keys');
    } else {
        logger.warn('No account.proton.me origin found in storage state');
    }

    // Try direct page evaluation as fallback for localStorage and get active session UID
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
            // Get active session UID from sessionStorage (ua_uid is set by Proton apps)
            const activeUid = window.sessionStorage.getItem('ua_uid') || undefined;
            return { localStorage: items, activeUid };
        });
        directLocalStorage = result.localStorage;
        activeSessionUid = result.activeUid;
        logger.info({ count: Object.keys(directLocalStorage).length }, 'Direct localStorage extraction');
        logger.debug({ keys: Object.keys(directLocalStorage) }, 'Direct localStorage keys');
        if (activeSessionUid) {
            logger.info({ activeSessionUid: activeSessionUid.slice(0, 12) + '...' }, 'Found active session UID');
        }
    } catch (e) {
        logger.warn({ error: e }, 'Failed to extract localStorage directly from page');
    }

    // Extract persisted session - prioritize matching active session UID
    // This ensures the ClientKey we fetch matches the blob we're trying to decrypt
    let persistedSession: PersistedSessionData | undefined;

    if (activeSessionUid) {
        // First try to find a session matching the active UID
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

    // Fetch persistence keys only if persistence is enabled
    let userKeys: StoredTokens['userKeys'];
    let masterKeys: StoredTokens['masterKeys'];

    if (persistenceEnabled) {
        logger.info('Persistence enabled - fetching encryption keys...');

        // Fetch ClientKey if we have a persisted session with a blob
        if (persistedSession?.blob) {
            // Find the AUTH cookie matching the persisted session's UID
            // Try account.proton.me first, then lumo.proton.me
            const matchingAuthCookie = relevantCookies.find(
                c => c.name === `AUTH-${persistedSession.UID}` && c.domain.includes('account.proton.me')
            ) || relevantCookies.find(
                c => c.name === `AUTH-${persistedSession.UID}` && c.domain.includes('lumo.proton.me')
            );

            if (!matchingAuthCookie) {
                logger.debug({ sessionUid: persistedSession.UID.slice(0, 8) + '...' }, 'No AUTH cookie matching session UID, trying fallback');
            }

            const authCookie = matchingAuthCookie || accountAuthCookie || lumoAuthCookie;
            if (authCookie) {
                const uid = authCookie.name.replace('AUTH-', '');
                const accessToken = authCookie.value;

                logger.info({ uid: uid.slice(0, 8) + '...', sessionUid: persistedSession.UID.slice(0, 8) + '...' }, 'Fetching ClientKey from API...');
                const clientKey = await fetchClientKey(page, uid, accessToken, protonConfig.appVersion);

                if (clientKey) {
                    persistedSession.clientKey = clientKey;

                    // Verify decryption works before saving
                    try {
                        const decrypted = await decryptPersistedSession(persistedSession);
                        logger.info({ type: decrypted.type }, 'Successfully verified keyPassword extraction');
                    } catch (err) {
                        logger.error({ err }, 'ClientKey fetch succeeded but decryption failed');
                        // Clear clientKey if decryption fails - don't save broken data
                        persistedSession.clientKey = undefined;
                    }
                }
            } else {
                logger.warn('No AUTH cookie found for ClientKey fetch');
            }
        }

        // Fetch user info (including keys) via browser to bypass scope limitation
        // Use the SAME auth cookie that worked for ClientKey (the matching session)
        if (persistedSession?.clientKey) {
            // Find the same auth cookie we used for ClientKey
            const matchingAuthCookie = relevantCookies.find(
                c => c.name === `AUTH-${persistedSession.UID}` && c.domain.includes('account.proton.me')
            ) || relevantCookies.find(
                c => c.name === `AUTH-${persistedSession.UID}` && c.domain.includes('lumo.proton.me')
            );
            const authCookieForUserInfo = matchingAuthCookie || accountAuthCookie || lumoAuthCookie;

            if (authCookieForUserInfo) {
                const uid = authCookieForUserInfo.name.replace('AUTH-', '');
                const accessToken = authCookieForUserInfo.value;
                logger.info({ uid: uid.slice(0, 8) + '...', domain: authCookieForUserInfo.domain }, 'Fetching user info...');
                const userInfo = await fetchUserInfo(page, uid, accessToken, protonConfig.appVersion);
                if (userInfo?.User?.Keys) {
                    userKeys = userInfo.User.Keys.map(k => ({
                        ID: k.ID,
                        PrivateKey: k.PrivateKey,
                        Primary: k.Primary,
                        Active: k.Active,
                    }));
                    logger.info({ keyCount: userKeys.length }, 'Cached user keys for persistence');
                }
            } else {
                logger.warn('No AUTH cookie found for user info fetch');
            }
        } else {
            logger.warn('No clientKey available - skipping user info fetch');
        }

        // Fetch master keys via browser to bypass scope limitation
        if (persistedSession?.clientKey) {
            // Use the Lumo auth cookie for master keys (it's a lumo endpoint)
            const lumoAuthForMasterKeys = relevantCookies.find(
                c => c.name === `AUTH-${persistedSession.UID}` && c.domain.includes('lumo.proton.me')
            ) || lumoAuthCookie;

            if (lumoAuthForMasterKeys) {
                const uid = lumoAuthForMasterKeys.name.replace('AUTH-', '');
                const accessToken = lumoAuthForMasterKeys.value;
                logger.info({ uid: uid.slice(0, 8) + '...', domain: lumoAuthForMasterKeys.domain }, 'Fetching master keys...');
                const fetchedMasterKeys = await fetchMasterKeys(page, uid, accessToken, protonConfig.appVersion);
                if (fetchedMasterKeys && fetchedMasterKeys.length > 0) {
                    masterKeys = fetchedMasterKeys;
                    logger.info({ keyCount: masterKeys.length }, 'Cached master keys for persistence');
                }
            } else {
                logger.warn('No Lumo AUTH cookie found for master keys fetch');
            }
        }
    } else {
        logger.info('Persistence disabled - skipping encryption key extraction');
    }

    // Determine which uid/accessToken to save
    // Prefer the one matching persistedSession.UID if available (works for encrypted operations)
    // Fall back to lumo.proton.me cookie (works for basic Lumo API)
    let outputUid = lumoUid;
    let outputAccessToken = lumoAuthCookie.value;

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

    // Build output - only save uid/accessToken, not full cookies array
    const tokens: StoredTokens = {
        method: 'browser',
        uid: outputUid,
        accessToken: outputAccessToken,
        extractedAt: new Date().toISOString(),
        persistedSession,
        userKeys,
        masterKeys,
    };

    // Ensure output directory exists
    mkdirSync(join(process.cwd(), 'sessions'), { recursive: true });

    // Write to file
    writeFileSync(outputPath, JSON.stringify(tokens, null, 2));

    logger.info({ outputPath }, 'Tokens saved');

    if (persistedSession?.blob && persistedSession?.clientKey) {
        logger.info('Extended auth data extracted - conversation persistence enabled');
    } else if (persistedSession?.blob) {
        logger.warn('Persisted session blob found but ClientKey fetch failed');
        logger.warn('Conversation persistence may not work without ClientKey');
    } else {
        logger.warn('No persisted session blob found');
        logger.warn('Conversation persistence will use local-only encryption');
    }

    logger.info('You can now run: npm run dev');

    // Don't close the browser - it's shared with lumo-bridge
    logger.debug('Browser connection closed, browser continues running');

    process.exit(0);
}

extractTokens().catch(error => {
    logger.error({ error }, 'Extraction failed');
    process.exit(1);
});
