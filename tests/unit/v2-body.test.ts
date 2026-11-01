import { describe, it, expect } from 'vitest';
import { buildChatCompletionsBody, inferImageMimeType, resolveChatModel } from '../../src/lumo-client/v2-body.js';
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

// Image serialization: vectors mirror upstream chat-completions.test.ts
// (packages/lumo-api-client/core/chat-completions.test.ts).
describe('buildChatCompletionsBody with images', () => {
    const base = { tier: 'auto' as const, enableReasoning: false };

    it('omits empty image arrays from serialized messages', () => {
        const body = buildChatCompletionsBody({
            ...base, encrypted: false,
            turns: [{ role: Role.User, content: 'Hello', images: [] }],
        });
        expect(body.messages).toEqual([{ role: 'user', content: 'Hello' }]);
    });

    it('serializes images as OpenAI content parts with data URLs', () => {
        // "UklGR" base64 prefix -> RIFF/WebP magic bytes
        const body = buildChatCompletionsBody({
            ...base, encrypted: false,
            turns: [{
                role: Role.User,
                content: '<lumo-image id="abc" source="user" name="pic.webp" />',
                images: [{ encrypted: false, image_id: 'abc', data: 'UklGRsAEAAA' }],
            }],
        });
        expect(body.messages).toEqual([{
            role: 'user',
            content: [
                { type: 'text', text: '<lumo-image id="abc" source="user" name="pic.webp" />' },
                { type: 'image_url', image_url: { url: 'data:image/webp;base64,UklGRsAEAAA' } },
            ],
        }]);
    });

    it('carries U2L ciphertext via a data URL with per-part encrypted flags', () => {
        const body = buildChatCompletionsBody({
            ...base, encrypted: true,
            encryption: { requestKeyEncB64: 'KEY', requestId: 'RID' },
            turns: [{
                role: Role.User,
                content: 'cipher-text-refs',
                encrypted: true,
                images: [{ encrypted: true, image_id: 'abc', data: 'cipher-text-bytes' }],
            }],
        });
        expect(body.messages).toEqual([{
            role: 'user',
            content: [
                { type: 'text', text: 'cipher-text-refs', encrypted: true },
                { type: 'image_url', image_url: { url: 'data:application/octet-stream;base64,cipher-text-bytes', encrypted: true } },
            ],
            encrypted: true,
        }]);
    });

    it('omits the text part for image-only turns and keeps multiple images in order', () => {
        const body = buildChatCompletionsBody({
            ...base, encrypted: false,
            turns: [{
                role: Role.User,
                content: '',
                images: [
                    { encrypted: false, image_id: '1', data: 'iVBORw0KGgoAAA' },
                    { encrypted: false, image_id: '2', data: '/9j/4AAQSkZJRg' },
                ],
            }],
        });
        expect(body.messages[0].content).toEqual([
            { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAA' } },
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/4AAQSkZJRg' } },
        ]);
    });
});

describe('inferImageMimeType', () => {
    it('maps base64 magic prefixes to MIME types, falling back to png', () => {
        expect(inferImageMimeType('iVBORw0KGgoAAA')).toBe('image/png');
        expect(inferImageMimeType('/9j/4AAQ')).toBe('image/jpeg');
        expect(inferImageMimeType('R0lGODlh')).toBe('image/gif');
        expect(inferImageMimeType('UklGRsAE')).toBe('image/webp');
        expect(inferImageMimeType('Qk06AAAA')).toBe('image/bmp');
        expect(inferImageMimeType(Buffer.from([0, 0, 0, 24, ...Buffer.from('ftypheic'), 0, 0, 0, 0]).toString('base64'))).toBe('image/heic');
        expect(inferImageMimeType(Buffer.from([0, 0, 0, 24, ...Buffer.from('ftypmif1'), 0, 0, 0, 0]).toString('base64'))).toBe('image/heif');
        expect(inferImageMimeType('AAAA')).toBe('image/png');
    });
});
