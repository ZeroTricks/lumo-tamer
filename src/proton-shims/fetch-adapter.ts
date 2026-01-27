/**
 * Fetch Adapter
 *
 * Bridges upstream LumoApi's fetch() calls to lumo-tamer's authenticated Api.
 *
 * The upstream LumoApi calls fetch() with:
 * - URL: '/api/lumo/v1/...'
 * - method: 'GET'/'POST'/'PUT'/'DELETE'
 * - headers: including x-pm-uid, x-pm-appversion (ignored - our Api handles auth)
 * - body: JSON string
 *
 * We intercept these and route through our Api adapter.
 *
 * IMPORTANT: We only intercept URLs starting with '/api/' (relative Proton API calls).
 * All other URLs (including full URLs like 'https://...') are passed through to
 * the original fetch. This prevents infinite recursion since our api-adapter.ts
 * uses absolute URLs when calling fetch.
 */

import type { ProtonApi } from '../lumo-client/types.js';
import { logger } from '../app/logger.js';

// Store the original fetch before any modifications
const originalFetch = globalThis.fetch;

/**
 * Creates a fetch-like function that intercepts Proton API calls.
 *
 * Only intercepts relative URLs starting with '/api/' (used by upstream LumoApi).
 * All other requests (including absolute URLs) pass through to original fetch.
 *
 * @param api - The authenticated Api function from lumo-tamer
 * @returns A fetch-compatible function
 */
export function createFetchAdapter(protonApi: ProtonApi): typeof globalThis.fetch {
    return async function adaptedFetch(
        input: RequestInfo | URL,
        init?: RequestInit
    ): Promise<Response> {
        const url = typeof input === 'string' ? input : input.toString();

        // Only intercept relative Proton API calls (starting with '/api/')
        // Pass through all absolute URLs to avoid infinite recursion
        if (!url.startsWith('/api/')) {
            return originalFetch(input, init);
        }

        const method = (init?.method?.toLowerCase() || 'get') as 'get' | 'post' | 'put' | 'delete';

        // Strip '/api/' prefix - our Api adds the base URL
        const apiUrl = url.replace(/^\/api\//, '');

        // Parse request body if present
        let data: unknown = undefined;
        if (init?.body && typeof init.body === 'string') {
            try {
                data = JSON.parse(init.body);
            } catch {
                data = init.body;
            }
        }

        logger.debug(`API: ${apiUrl}`);

        try {
            const result = await protonApi({
                url: apiUrl,
                method,
                data,
            });

            // Wrap result in Response-like object
            return new Response(JSON.stringify(result), {
                status: 200,
                statusText: 'OK',
                headers: { 'content-type': 'application/json' },
            });
        } catch (error: unknown) {
            // Convert errors to Response with appropriate status
            const err = error as { status?: number; code?: number; Code?: number; message?: string };
            const status = err.status || err.code || err.Code || 500;

            logger.debug(
                { url: apiUrl, method, status, error: err.message },
                'Fetch adapter: request failed'
            );

            // Return error response that LumoApi can handle
            const errorBody = {
                Code: status === 409 ? 409 : (err.Code || 2501),
                Error: err.message || 'Unknown error',
            };

            return new Response(JSON.stringify(errorBody), {
                status,
                statusText: status === 409 ? 'Conflict' : 'Error',
                headers: { 'content-type': 'application/json' },
            });
        }
    };
}

/**
 * Installs the fetch adapter globally.
 * Call this before creating LumoApi instances.
 *
 * @param api - The authenticated Api function from lumo-tamer
 * @returns A cleanup function to restore the original fetch
 */
export function installFetchAdapter(protonApi: ProtonApi): () => void {
    globalThis.fetch = createFetchAdapter(protonApi);

    return () => {
        globalThis.fetch = originalFetch;
    };
}
