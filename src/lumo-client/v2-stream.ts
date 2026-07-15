/**
 * Lumo 2.0 chat/completions SSE parser.
 *
 * Normalizes the OpenAI-style stream returned by `ai/v1/chat/completions` into
 * a small message union the LumoClient consumes. Mirrors the dispatch logic of
 * ProtonMail/WebClients applications/lumo/src/app/lib/lumo-api-client/core/streaming.ts
 * (processOpenAiChunk / processDelta / processToolCallDelta / chat.tool_call|result),
 * kept as a local adapter scoped to what this proxy needs (no image handling).
 *
 * Content and reasoning arrive encrypted (U2L) and are decrypted by the caller
 * using the per-request AD; this parser only surfaces the `encrypted` flag.
 */

import type { LumoUsage } from './types.js';

export type V2StreamMessage =
    | { type: 'token_data'; target: 'message' | 'reasoning' | 'tool_call'; content: string; encrypted?: boolean }
    | { type: 'server_tool_call'; call_id?: string; name: string; arguments?: string; encrypted?: boolean }
    | { type: 'server_tool_result'; call_id?: string; content: string; encrypted?: boolean }
    | { type: 'usage'; usage: LumoUsage }
    | { type: 'harmful' }
    | { type: 'error'; message?: string }
    | { type: 'done' };

interface OpenAiDelta {
    content?: string;
    reasoning_content?: string;
    reasoning?: string;
    encrypted?: boolean;
    target?: 'message' | 'reasoning' | 'tool_call';
    tool_calls?: Array<{
        index?: number;
        function?: { name?: string; arguments?: string };
    }>;
}

/**
 * Stateful line-buffered SSE parser. Feed raw decoded chunks to `processChunk`
 * and flush any trailing buffered line with `finalize`.
 */
export class V2StreamProcessor {
    private buffer = '';
    /** Accumulates streamed tool-call name/arguments by index. */
    private toolCalls = new Map<number, { name: string; arguments: string }>();

    processChunk(chunk: string): V2StreamMessage[] {
        this.buffer += chunk;
        const messages: V2StreamMessage[] = [];
        let nl: number;
        while ((nl = this.buffer.indexOf('\n')) >= 0) {
            const line = this.buffer.slice(0, nl);
            this.buffer = this.buffer.slice(nl + 1);
            this.handleLine(line, messages);
        }
        return messages;
    }

    finalize(): V2StreamMessage[] {
        const messages: V2StreamMessage[] = [];
        if (this.buffer.length > 0) {
            this.handleLine(this.buffer, messages);
            this.buffer = '';
        }
        return messages;
    }

    private handleLine(rawLine: string, out: V2StreamMessage[]): void {
        // Tolerate CRLF and the optional "data:" SSE prefix.
        let line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
        line = line.replace(/^data:\s*/, '').trim();
        if (!line || line.startsWith(':')) {
            return; // blank line or SSE comment
        }
        if (line === '[DONE]') {
            out.push({ type: 'done' });
            return;
        }
        let obj: Record<string, unknown>;
        try {
            obj = JSON.parse(line);
        } catch {
            return; // ignore malformed/partial JSON lines
        }
        this.dispatch(obj, out);
    }

    private dispatch(obj: Record<string, unknown>, out: V2StreamMessage[]): void {
        const objectType = obj.object;

        if (objectType === 'chat.tool_call') {
            const tc = (obj.tool_call ?? {}) as { id?: string; name?: string; arguments?: string; encrypted?: boolean };
            if (tc.name) {
                out.push({
                    type: 'server_tool_call',
                    call_id: tc.id,
                    name: tc.name,
                    ...(tc.arguments !== undefined ? { arguments: tc.arguments } : {}),
                    ...(tc.encrypted ? { encrypted: true } : {}),
                });
            }
            return;
        }

        if (objectType === 'chat.tool_result') {
            const tr = (obj.tool_result ?? {}) as { call_id?: string; content?: string; encrypted?: boolean };
            out.push({
                type: 'server_tool_result',
                call_id: tr.call_id,
                content: tr.content ?? '',
                ...(tr.encrypted ? { encrypted: true } : {}),
            });
            return;
        }

        if (objectType === 'lumo.image_data') {
            return; // image generation not surfaced by this proxy
        }

        // OpenAI-style completion chunk.
        if (obj.error) {
            const err = obj.error as { message?: string; code?: string };
            out.push({ type: 'error', message: err.message ?? err.code });
            return;
        }

        if (obj.usage) {
            out.push({ type: 'usage', usage: obj.usage as LumoUsage });
        }

        const choices = obj.choices as Array<{ finish_reason?: string; delta?: OpenAiDelta }> | undefined;
        if (!choices || choices.length === 0) {
            return;
        }
        const choice = choices[0];
        if (choice.finish_reason === 'content_filter') {
            out.push({ type: 'harmful' });
        }
        if (!choice.delta) {
            return;
        }
        this.processDelta(choice.delta, out);
    }

    private processDelta(delta: OpenAiDelta, out: V2StreamMessage[]): void {
        const target = delta.target ?? 'message';
        if (typeof delta.content === 'string' && delta.content.length > 0) {
            out.push({ type: 'token_data', target: target === 'reasoning' ? 'message' : target, content: delta.content, encrypted: delta.encrypted });
        }
        const reasoning = delta.reasoning_content ?? delta.reasoning;
        if (typeof reasoning === 'string' && reasoning.length > 0) {
            out.push({ type: 'token_data', target: 'reasoning', content: reasoning, encrypted: delta.encrypted });
        }
        if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
                const emitted = this.accumulateToolCall(tc);
                if (emitted) {
                    out.push(emitted);
                }
            }
        }
    }

    /** Accumulate a streamed tool-call delta; emit token_data once a name is known. */
    private accumulateToolCall(
        tc: { index?: number; function?: { name?: string; arguments?: string } },
    ): V2StreamMessage | null {
        const index = tc.index ?? 0;
        const existing = this.toolCalls.get(index) ?? { name: '', arguments: '' };
        if (tc.function?.name) {
            existing.name = tc.function.name;
        }
        if (tc.function?.arguments) {
            existing.arguments += tc.function.arguments;
        }
        this.toolCalls.set(index, existing);
        if (!existing.name) {
            return null;
        }
        let args: Record<string, unknown> = {};
        if (existing.arguments) {
            try {
                args = JSON.parse(existing.arguments);
            } catch {
                // arguments still streaming; emit best-effort with raw string
                return { type: 'token_data', target: 'tool_call', content: JSON.stringify({ name: existing.name, arguments: existing.arguments }) };
            }
        }
        return { type: 'token_data', target: 'tool_call', content: JSON.stringify({ name: existing.name, arguments: args }) };
    }
}
