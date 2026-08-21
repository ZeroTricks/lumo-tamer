import { describe, it, expect } from 'vitest';
import { buildChatCompletionsBody, resolveChatModel } from '../../src/lumo-client/v2-body.js';
import { Role } from '../../src/lumo-client/types.js';

describe('resolveChatModel', () => {
    it('maps tiers to wire model ids', () => {
        expect(resolveChatModel('auto')).toBe('lumo');
        expect(resolveChatModel('lumo-lite')).toBe('lumo-lite');
        expect(resolveChatModel('lumo-max')).toBe('lumo-max');
    });
});

describe('buildChatCompletionsBody', () => {
    const baseTurns = [{ role: Role.User, content: 'hi' }];

    it('builds a minimal plaintext body', () => {
        const body = buildChatCompletionsBody({
            turns: baseTurns,
            tier: 'lumo-max',
            enableReasoning: false,
            encrypted: false,
        });
        expect(body.model).toBe('lumo-max');
        expect(body.stream).toBe(true);
        expect(body.stream_options).toEqual({ include_usage: true });
        expect(body.reasoning_effort).toBe('none');
        expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
        expect(body.lumo).toEqual({ client_type: 'frontend' });
        expect(body.tools).toBeUndefined();
        expect(body.tool_choice).toBeUndefined();
    });

    it('sets reasoning_effort high when reasoning enabled', () => {
        const body = buildChatCompletionsBody({
            turns: baseTurns, tier: 'auto', enableReasoning: true, encrypted: false,
        });
        expect(body.reasoning_effort).toBe('high');
    });

    it('folds encryption keys into the lumo extension and flags messages', () => {
        const body = buildChatCompletionsBody({
            turns: [{ role: Role.User, content: 'CIPHERTEXT' }],
            tier: 'auto',
            enableReasoning: false,
            encrypted: true,
            encryption: { requestKeyEncB64: 'KEY', requestId: 'RID' },
        });
        expect(body.messages[0]).toEqual({ role: 'user', content: 'CIPHERTEXT', encrypted: true });
        expect(body.lumo).toEqual({ client_type: 'frontend', request_key: 'KEY', request_id: 'RID' });
    });

    it('normalizes tools and sets tool_choice', () => {
        const body = buildChatCompletionsBody({
            turns: baseTurns, tier: 'auto', enableReasoning: false, encrypted: false,
            tools: ['proton_info', 'web_search'],
        });
        expect(body.tools).toEqual([{ name: 'proton_info' }, { name: 'web_search' }]);
        expect(body.tool_choice).toBe('auto');
    });

    it('carries the title target in the lumo extension', () => {
        const body = buildChatCompletionsBody({
            turns: baseTurns, tier: 'auto', enableReasoning: false, encrypted: false, target: 'title',
        });
        expect(body.lumo.target).toBe('title');
    });

    it('maps tool roles to wire roles', () => {
        const body = buildChatCompletionsBody({
            turns: [
                { role: Role.System, content: 's' },
                { role: Role.Assistant, content: 'a' },
                { role: Role.ToolCall, content: 'tc' },
                { role: Role.ToolResult, content: 'tr' },
            ],
            tier: 'auto', enableReasoning: false, encrypted: false,
        });
        expect(body.messages.map((m) => m.role)).toEqual(['system', 'assistant', 'lumo_tool_call', 'tool']);
    });
});
