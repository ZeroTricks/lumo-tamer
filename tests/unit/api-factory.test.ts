import { describe, it, expect, vi, afterEach } from 'vitest';
import { createProtonApi } from '../../src/auth/api-factory.js';
import type { ProtonApiError } from '../../src/lumo-client/types.js';

describe('createProtonApi error handling', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('preserves parsed and raw Proton error body on non-2xx JSON responses', async () => {
        const bodyText = JSON.stringify({ Code: 5003, Error: 'App version outdated' });
        vi.stubGlobal('fetch', vi.fn(async () =>
            new Response(bodyText, { status: 400, statusText: 'Bad Request' })));

        const api = createProtonApi({ uid: 'u', accessToken: 't' });

        await expect(
            api({ url: 'ai/v1/chat/completions', method: 'post', data: {} })
        ).rejects.toMatchObject({
            message: 'App version outdated',
            status: 400,
            Code: 5003,
            data: { Code: 5003, Error: 'App version outdated' },
            body: bodyText,
        });
    });

    it('falls back to status text and keeps the raw body when not JSON', async () => {
        vi.stubGlobal('fetch', vi.fn(async () =>
            new Response('gateway boom', { status: 502, statusText: 'Bad Gateway' })));

        const api = createProtonApi({ uid: 'u', accessToken: 't' });

        let err: ProtonApiError | undefined;
        try {
            await api({ url: 'ai/v1/limits', method: 'get' });
        } catch (e) {
            err = e as ProtonApiError;
        }

        expect(err?.status).toBe(502);
        expect(err?.body).toBe('gateway boom');
        expect(err?.data).toBeUndefined();
        expect(err?.message).toContain('502');
    });

    it('retries once after a transient DNS error', async () => {
        const fetchMock = vi.fn()
            .mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), {
                cause: Object.assign(new Error('getaddrinfo ENOTFOUND lumo.proton.me'), { code: 'ENOTFOUND' }),
            }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);
        vi.useFakeTimers();

        const api = createProtonApi({ uid: 'u', accessToken: 't' });
        const pending = api({ url: 'ai/v1/chat/completions', method: 'post', data: {} });
        await vi.advanceTimersByTimeAsync(1000);
        await expect(pending).resolves.toEqual({ ok: true });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        vi.useRealTimers();
    });
});
