import { describe, it, expect } from 'vitest';
import { V2StreamProcessor, type V2StreamMessage } from '../../src/lumo-client/v2-stream.js';

/** Feed whole input then finalize, returning all emitted messages. */
function run(input: string): V2StreamMessage[] {
    const p = new V2StreamProcessor();
    return [...p.processChunk(input), ...p.finalize()];
}

const chunk = (delta: object) =>
    `data:${JSON.stringify({ object: 'CompletionChunk', model: 'lumo-max', choices: [{ index: 0, delta }] })}\n`;

describe('V2StreamProcessor', () => {
    it('parses content deltas into message token_data', () => {
        const msgs = run(chunk({ content: 'pong' }));
        expect(msgs).toContainEqual({ type: 'token_data', target: 'message', content: 'pong', encrypted: undefined });
    });

    it('maps reasoning_content and reasoning to the reasoning target', () => {
        expect(run(chunk({ reasoning_content: 'think' }))).toContainEqual(
            { type: 'token_data', target: 'reasoning', content: 'think', encrypted: undefined });
        expect(run(chunk({ reasoning: 'ponder' }))).toContainEqual(
            { type: 'token_data', target: 'reasoning', content: 'ponder', encrypted: undefined });
    });

    it('carries the encrypted flag', () => {
        const msgs = run(chunk({ content: 'X', encrypted: true }));
        expect(msgs).toContainEqual({ type: 'token_data', target: 'message', content: 'X', encrypted: true });
    });

    it('reassembles a line split across chunk boundaries', () => {
        const line = chunk({ content: 'hello' });
        const p = new V2StreamProcessor();
        const out = [
            ...p.processChunk(line.slice(0, 20)),
            ...p.processChunk(line.slice(20)),
            ...p.finalize(),
        ];
        expect(out).toContainEqual({ type: 'token_data', target: 'message', content: 'hello', encrypted: undefined });
    });

    it('tolerates CRLF line endings', () => {
        const line = chunk({ content: 'crlf' }).replace('\n', '\r\n');
        expect(run(line)).toContainEqual({ type: 'token_data', target: 'message', content: 'crlf', encrypted: undefined });
    });

    it('emits done on [DONE]', () => {
        expect(run('data: [DONE]\n')).toEqual([{ type: 'done' }]);
    });

    it('ignores malformed JSON and SSE comments', () => {
        expect(run(': keep-alive\ndata: {not json}\n')).toEqual([]);
    });

    it('emits usage, including after a finish_reason chunk', () => {
        const finish = `data:${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n`;
        const usage = `data:${JSON.stringify({ choices: [], usage: { completion_tokens: 2, applied_limit_category: 'max' } })}\n`;
        const msgs = run(finish + usage);
        expect(msgs).toContainEqual({ type: 'usage', usage: { completion_tokens: 2, applied_limit_category: 'max' } });
    });

    it('maps content_filter finish_reason to harmful', () => {
        const line = `data:${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'content_filter' }] })}\n`;
        expect(run(line)).toContainEqual({ type: 'harmful' });
    });

    it('surfaces top-level errors', () => {
        const line = `data:${JSON.stringify({ error: { code: 'CONTEXT_LENGTH_EXCEEDED', message: 'too long' } })}\n`;
        expect(run(line)).toContainEqual({ type: 'error', message: 'too long' });
    });

    it('normalizes chat.tool_call and chat.tool_result objects', () => {
        const call = `data:${JSON.stringify({ object: 'chat.tool_call', tool_call: { id: 'c1', name: 'proton_info', arguments: '{}', encrypted: true } })}\n`;
        const result = `data:${JSON.stringify({ object: 'chat.tool_result', tool_result: { call_id: 'c1', content: 'RES', encrypted: true } })}\n`;
        const msgs = run(call + result);
        expect(msgs).toContainEqual({ type: 'server_tool_call', call_id: 'c1', name: 'proton_info', arguments: '{}', encrypted: true });
        expect(msgs).toContainEqual({ type: 'server_tool_result', call_id: 'c1', content: 'RES', encrypted: true });
    });

    it('accumulates streamed tool_call deltas into one JSON tool_call', () => {
        const c1 = chunk({ tool_calls: [{ index: 0, function: { name: 'web_search' } }] });
        const c2 = chunk({ tool_calls: [{ index: 0, function: { arguments: '{"q":' } }] });
        const c3 = chunk({ tool_calls: [{ index: 0, function: { arguments: '"cats"}' } }] });
        const msgs = run(c1 + c2 + c3);
        const toolCalls = msgs.filter((m) => m.type === 'token_data' && m.target === 'tool_call');
        const last = toolCalls[toolCalls.length - 1];
        expect(last).toEqual({ type: 'token_data', target: 'tool_call', content: JSON.stringify({ name: 'web_search', arguments: { q: 'cats' } }) });
    });

    it('routes content with an explicit reasoning target to reasoning', () => {
        const line = `data:${JSON.stringify({ choices: [{ delta: { target: 'reasoning', content: 'secret' } }] })}\n`;
        expect(run(line)).toContainEqual({ type: 'token_data', target: 'reasoning', content: 'secret', encrypted: undefined });
    });

    it('honors a top-level chunk target', () => {
        const line = `data:${JSON.stringify({ target: 'reasoning', choices: [{ delta: { content: 't' } }] })}\n`;
        expect(run(line)).toContainEqual({ type: 'token_data', target: 'reasoning', content: 't', encrypted: undefined });
    });

    it('copies the top-level model into the usage message', () => {
        const line = `data:${JSON.stringify({ model: 'lumo-max', choices: [], usage: { completion_tokens: 1 } })}\n`;
        expect(run(line)).toContainEqual({ type: 'usage', usage: { completion_tokens: 1, model: 'lumo-max' } });
    });

    it('emits a single complete tool_call only at finalize (not mid-stream)', () => {
        const p = new V2StreamProcessor();
        const during = [
            ...p.processChunk(chunk({ tool_calls: [{ index: 0, function: { name: 'web_search' } }] })),
            ...p.processChunk(chunk({ tool_calls: [{ index: 0, function: { arguments: '{"q":"x"}' } }] })),
        ];
        expect(during.filter((m) => m.type === 'token_data' && m.target === 'tool_call')).toHaveLength(0);
        const fin = p.finalize();
        expect(fin).toContainEqual({ type: 'token_data', target: 'tool_call', content: JSON.stringify({ name: 'web_search', arguments: { q: 'x' } }) });
    });

    it('ignores image_data objects', () => {
        const line = `data:${JSON.stringify({ object: 'lumo.image_data', image: { id: 'i', data: 'x' } })}\n`;
        expect(run(line)).toEqual([]);
    });
});
