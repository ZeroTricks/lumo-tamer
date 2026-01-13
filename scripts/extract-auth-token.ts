/**
 * Extract auth tokens from existing browser session
 * Uses the same CDP connection as lumo-bridge
 *
 * Usage: npm run extract-token
 */

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { promises as dns, ADDRCONFIG } from 'dns';
import type { AuthTokens } from '../src/proton/types.js';
import { browserConfig, protonConfig } from '../src/config.js';
import logger from '../src/logger.js';

const cdpEndpoint = browserConfig.cdpEndpoint;
const targetUrl = browserConfig.url;
const outputPath = join(process.cwd(), protonConfig.tokensPath);

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

async function extractTokens(): Promise<void> {
    logger.info('=== Lumo Auth Token Extraction ===');

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

    if (!lumoAuthCookie) {
        logger.warn('No AUTH-* cookie found for lumo.proton.me. Make sure you are logged in to Lumo.');
    } else {
        const uid = lumoAuthCookie.name.replace('AUTH-', '');
        logger.info({ uid: uid.slice(0, 8) + '...' }, 'Found Lumo auth');
    }

    // Extract localStorage for Lumo origin
    const lumoOrigin = state.origins.find(o => o.origin.includes('lumo.proton.me'));
    const localStorage: Record<string, string> = {};
    if (lumoOrigin) {
        for (const item of lumoOrigin.localStorage) {
            localStorage[item.name] = item.value;
        }
        logger.info({ count: Object.keys(localStorage).length }, 'Found localStorage items');
    }

    // Build output
    const tokens: AuthTokens = {
        cookies: relevantCookies,
        localStorage: Object.keys(localStorage).length > 0 ? localStorage : undefined,
        extractedAt: new Date().toISOString(),
    };

    // Ensure output directory exists
    mkdirSync(join(process.cwd(), 'sessions'), { recursive: true });

    // Write to file
    writeFileSync(outputPath, JSON.stringify(tokens, null, 2));

    logger.info({ outputPath }, 'Tokens saved');
    logger.info('You can now run: npm run poc-test "What is 2+2?"');

    // Don't close the browser - it's shared with lumo-bridge
    logger.debug('Browser connection closed, browser continues running');
}

extractTokens().catch(error => {
    logger.error({ error }, 'Extraction failed');
    process.exit(1);
});
