import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestServer, type TestServer } from '../helpers/test-server.js';

describe('model tier + reasoning (chat/completions)', () => {
    let ts: TestServer;
    beforeAll(async () => { ts = await createTestServer('success'); });
    afterAll(async () => { await ts.close(); });

    async function chat(body: object) {
        return fetch(`${ts.baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    }

    it('accepts a valid tier model', async () => {
        const res = await chat({ model: 'lumo-max', messages: [{ role: 'user', content: 'hi' }] });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.choices[0].message.content).toContain('Mocked');
    });

    it('accepts a provider-prefixed tier model', async () => {
        const res = await chat({ model: 'proton/lumo-lite', messages: [{ role: 'user', content: 'hi' }] });
        expect(res.status).toBe(200);
    });

    it('rejects an unknown model with a 400', async () => {
        const res = await chat({ model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error.type).toBe('invalid_request_error');
        expect(body.error.code).toBe('model_not_found');
        expect(body.error.param).toBe('model');
    });

    it('accepts reasoning_effort', async () => {
        const res = await chat({ model: 'lumo-max', reasoning_effort: 'high', messages: [{ role: 'user', content: 'hi' }] });
        expect(res.status).toBe(200);
    });

    it('rejects an invalid reasoning_effort with a 400', async () => {
        const res = await chat({ reasoning_effort: 'ludicrous', messages: [{ role: 'user', content: 'hi' }] });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error.code).toBe('invalid_reasoning_effort');
        expect(body.error.param).toBe('reasoning_effort');
    });

    it('rejects a non-string model with a 400 (not a 500)', async () => {
        const res = await chat({ model: 123, messages: [{ role: 'user', content: 'hi' }] });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error.code).toBe('model_not_found');
    });
});
