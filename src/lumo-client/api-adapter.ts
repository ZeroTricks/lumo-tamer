/**
 * API adapter for Proton Lumo
 * Implements fetch wrapper with auth token handling
 */

import { readFileSync } from 'fs';
import type { AuthTokens, Api, ApiOptions } from './types.js';
import { protonConfig, authConfig } from '../config.js';

/**
 * Load auth tokens from file
 */
export function loadAuthTokens(path: string = authConfig.tokenCachePath): AuthTokens {
    const content = readFileSync(path, 'utf-8');
    return JSON.parse(content) as AuthTokens;
}

/**
 * Create an API adapter function compatible with Proton's Api interface
 */
  // TODO: refactor and share common code with createApiFromTokens
export function createApiAdapter(
    tokens: AuthTokens,
    baseUrl: string = protonConfig.baseUrl
): Api {
    // Build Cookie header from tokens
    const cookieHeader = tokens.cookies
        .map((c) => `${c.name}=${c.value}`)
        .join('; ');

    // Find the AUTH cookie for lumo.proton.me domain
    // Cookie name format: AUTH-{uid}, value is the access token
    // Prefer the cookie matching the persisted session UID (that's the active session)
    const persistedSessionUid = tokens.persistedSession?.UID;
    let lumoAuthCookie = persistedSessionUid
        ? tokens.cookies.find(
            (c) => c.name === `AUTH-${persistedSessionUid}` && c.domain.includes('lumo.proton.me')
        )
        : undefined;

    // Fallback to any lumo AUTH cookie
    if (!lumoAuthCookie) {
        lumoAuthCookie = tokens.cookies.find(
            (c) => c.name.startsWith('AUTH-') && c.domain.includes('lumo.proton.me')
        );
    }

    if (!lumoAuthCookie) {
        throw new Error('No AUTH cookie found for lumo.proton.me. Re-run extract-tokens.');
    }

    // Extract UID from cookie name (AUTH-{uid})
    const uid = lumoAuthCookie.name.replace('AUTH-', '');
    const accessToken = lumoAuthCookie.value;

    return async function api(options: ApiOptions): Promise<ReadableStream<Uint8Array> | unknown> {
        const { url, method, data, signal, output = 'json' } = options;

        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'Cookie': cookieHeader,
            'x-pm-uid': uid,
            'x-pm-appversion': protonConfig.appVersion,
            'Authorization': `Bearer ${accessToken}`,
            // Accept SSE for streaming
            ...(output === 'stream' ? { 'Accept': 'text/event-stream' } : {}),
        };

        const fullUrl = url.startsWith('http') ? url : `${baseUrl}/${url}`;

        const response = await fetch(fullUrl, {
            method: method.toUpperCase(),
            headers,
            body: data ? JSON.stringify(data) : undefined,
            signal,
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => '');
            throw new Error(
                `API error: ${response.status} ${response.statusText}` +
                (errorBody ? `\n${errorBody}` : '')
            );
        }

        if (output === 'stream') {
            if (!response.body) {
                throw new Error('Expected streaming response but got no body');
            }
            return response.body;
        }

        return response.json();
    };
}

/**
 * Helper to check if tokens are expired
 */
export function areTokensExpired(tokens: AuthTokens): boolean {
    const now = Date.now() / 1000; // Convert to seconds
    return tokens.cookies.some((c) => c.expires > 0 && c.expires < now);
}

/**
 * Get token age in hours
 */
export function getTokenAgeHours(tokens: AuthTokens): number {
    const extractedAt = new Date(tokens.extractedAt).getTime();
    return (Date.now() - extractedAt) / (1000 * 60 * 60);
}
