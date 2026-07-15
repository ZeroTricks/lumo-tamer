import { describe, it, expect, vi } from 'vitest';
import { LumoClient } from '../../src/lumo-client/client.js';
import { Role } from '../../src/lumo-client/types.js';
import type { ProtonApiOptions } from '../../src/lumo-client/types.js';

/** Build a fake SSE ReadableStream from CompletionChunk objects, ending with [DONE]. */
function sseStream(chunks: object[]): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    const lines = [...chunks.map((c) => `data:${JSON.stringify(c)}\n`), 'data:[DONE]\n'];
    return new ReadableStream({
        start(controller) {
            for (const l of lines) controller.enqueue(enc.encode(l));
            controller.close();
        },
    });
}

const cc = (delta: object, extra: object = {}) => ({
    object: 'CompletionChunk', model: 'lumo-max', choices: [{ index: 0, delta }], ...extra,
});

/** LumoClient wired to a plaintext fake transport (no encryption). */
function makeClient(handler: (opts: ProtonApiOptions) => object[]) {
    const api = vi.fn(async (opts: ProtonApiOptions) => sseStream(handler(opts)));
    const client = new LumoClient(api as never, { enableEncryption: false });
    return { client, api };
}

describe('LumoClient (Lumo 2.0 chat/completions)', () => {
    it('accumulates reasoning separately from content, even without an onReasoning sink', async () => {
        const { client } = makeClient(() => [cc({ content: 'Answer' }), cc({ reasoning: 'thinking' })]);
        const res = await client.chatWithHistory([{ role: Role.User, content: 'hi' }]);
        expect(res.message.content).toBe('Answer');
        expect(res.reasoning).toBe('thinking');
    });

    it('does not leak reasoning-targeted content into the answer', async () => {
        const { client } = makeClient(() => [
            cc({ content: 'visible' }),
            { object: 'CompletionChunk', choices: [{ delta: { target: 'reasoning', content: 'hidden' } }] },
        ]);
        const res = await client.chatWithHistory([{ role: Role.User, content: 'hi' }]);
        expect(res.message.content).toBe('visible');
        expect(res.reasoning).toBe('hidden');
    });

    it('captures the full tool-call arguments from streamed deltas', async () => {
        const { client } = makeClient(() => [
            cc({ tool_calls: [{ index: 0, function: { name: 'web_search' } }] }),
            cc({ tool_calls: [{ index: 0, function: { arguments: '{"q":' } }] }),
            cc({ tool_calls: [{ index: 0, function: { arguments: '"cats"}' } }] }),
        ]);
        const res = await client.chatWithHistory([{ role: Role.User, content: 'find cats' }]);
        expect(res.message.toolCall).toBeDefined();
        expect(JSON.parse(res.message.toolCall!)).toEqual({ name: 'web_search', arguments: { q: 'cats' } });
    });

    it('captures usage (tier category + serving model)', async () => {
        const { client } = makeClient(() => [
            cc({ content: 'x' }),
            { object: 'CompletionChunk', model: 'lumo-max', choices: [], usage: { completion_tokens: 2, applied_limit_category: 'max' } },
        ]);
        const res = await client.chatWithHistory([{ role: Role.User, content: 'hi' }]);
        expect(res.usage).toEqual({ completion_tokens: 2, applied_limit_category: 'max', model: 'lumo-max' });
    });

    it('issues a separate title completion and uses its content', async () => {
        const { client, api } = makeClient((opts) => {
            const target = (opts.data as { lumo?: { target?: string } }).lumo?.target;
            return target === 'title' ? [cc({ content: 'A Good Title' })] : [cc({ content: 'body' })];
        });
        const res = await client.chatWithHistory([{ role: Role.User, content: 'hi' }], undefined, { requestTitle: true });
        expect(api).toHaveBeenCalledTimes(2);
        expect(res.message.content).toBe('body');
        expect(res.title).toBe('A Good Title');
    });

    it('bounces a misrouted custom tool and requests the title only once', async () => {
        let messageCalls = 0;
        let titleCalls = 0;
        const { client } = makeClient((opts) => {
            const target = (opts.data as { lumo?: { target?: string } }).lumo?.target;
            if (target === 'title') {
                titleCalls++;
                return [cc({ content: 'Title' })];
            }
            messageCalls++;
            return messageCalls === 1
                ? [cc({ tool_calls: [{ index: 0, function: { name: 'my_custom_tool', arguments: '{"a":1}' } }] })]
                : [cc({ content: 'final answer' })];
        });
        const res = await client.chatWithHistory([{ role: Role.User, content: 'hi' }], undefined, { requestTitle: true });
        expect(res.message.content).toBe('final answer');
        expect(res.title).toBe('Title');
        expect(titleCalls).toBe(1);
        expect(messageCalls).toBe(2);
    });

    it('sends tier and reasoning_effort in the request body', async () => {
        const { client, api } = makeClient(() => [cc({ content: 'ok' })]);
        await client.chatWithHistory([{ role: Role.User, content: 'hi' }], undefined, {
            modelTier: 'lumo-max', enableReasoning: true,
        });
        const body = api.mock.calls[0][0].data as { model: string; reasoning_effort: string };
        expect(body.model).toBe('lumo-max');
        expect(body.reasoning_effort).toBe('high');
    });
});
