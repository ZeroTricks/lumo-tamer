/**
 * API Factory - Creates ProtonApi functions for all auth methods
 *
 */

import type { ProtonApi, ProtonApiOptions } from '../lumo-client/types.js';
import { protonConfig } from '../config.js';

interface ApiFactoryOptions {
    uid: string;
    accessToken: string;
    /** Cookie header string for browser auth (optional) */
    cookies?: string;
}

/**
 * Create a ProtonApi function for making authenticated API calls
 *
 * @param options - UID, access token, and optional cookies
 * @returns ProtonApi function
 */
export function createProtonApi(options: ApiFactoryOptions): ProtonApi {
    const { uid, accessToken, cookies } = options;
    const baseUrl = protonConfig.baseUrl;
    const appVersion = protonConfig.appVersion;

    return async function api(apiOptions: ProtonApiOptions): Promise<ReadableStream<Uint8Array> | unknown> {
        const { url, method, data, signal, output = 'json' } = apiOptions;

        const fullUrl = url.startsWith('http') ? url : `${baseUrl}/${url}`;

        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'x-pm-uid': uid,
            'x-pm-appversion': appVersion,
            'Authorization': `Bearer ${accessToken}`,
        };

        // Add cookies for browser auth
        if (cookies) {
            headers['Cookie'] = cookies;
        }

        // Add streaming accept header
        if (output === 'stream') {
            headers['Accept'] = 'text/event-stream';
        }

        const fetchOptions: RequestInit = {
            method: method.toUpperCase(),
            headers,
            signal,
        };

        if (data && method !== 'get') {
            fetchOptions.body = JSON.stringify(data);
        }

        const response = await fetch(fullUrl, fetchOptions);

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
