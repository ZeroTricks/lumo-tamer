/**
 * Tests for message deduplication logic
 */

import { describe, it, expect } from 'vitest';
import {
    hashMessage,
    findNewMessages,
} from '../../src/conversations/deduplication.js';
import type { Message, MessageForStore } from '../../src/conversations/types.js';

function createStoredMessage(
    role: string,
    content: string,
    index: number,
    semanticId?: string,
): MessageForStore {
    return {
        id: `msg-${index}`,
        conversationId: 'conv-1',
        createdAt: Date.now(),
        role: role as Message['role'],
        status: 'completed',
        content,
        // Use provided semanticId or compute hash substring (matching store.ts behavior)
        semanticId: semanticId ?? hashMessage(role, content).slice(0, 16),
    };
}

describe('hashMessage', () => {
    it('should produce consistent hashes', () => {
        const hash1 = hashMessage('user', 'Hello');
        const hash2 = hashMessage('user', 'Hello');
        expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different content', () => {
        const hash1 = hashMessage('user', 'Hello');
        const hash2 = hashMessage('user', 'Hello!');
        expect(hash1).not.toBe(hash2);
    });

    it('should produce different hashes for different roles', () => {
        const hash1 = hashMessage('user', 'Hello');
        const hash2 = hashMessage('assistant', 'Hello');
        expect(hash1).not.toBe(hash2);
    });
});

describe('findNewMessages', () => {
    it('should return all messages when stored is empty', () => {
        const incoming: MessageForStore[] = [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi there!' },
        ];

        const result = findNewMessages(incoming, []);
        expect(result).toHaveLength(2);
        expect(result[0].content).toBe('Hello');
    });

    it('should return empty array when no new messages', () => {
        const incoming: MessageForStore[] = [
            { role: 'user', content: 'Hello' },
        ];
        const stored: Message[] = [
            createStoredMessage('user', 'Hello', 0),
        ];

        const result = findNewMessages(incoming, stored);
        expect(result).toHaveLength(0);
    });

    it('should return only new messages at the end', () => {
        const incoming: MessageForStore[] = [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi there!' },
            { role: 'user', content: 'How are you?' },
        ];
        const stored: Message[] = [
            createStoredMessage('user', 'Hello', 0),
            createStoredMessage('assistant', 'Hi there!', 1),
        ];

        const result = findNewMessages(incoming, stored);
        expect(result).toHaveLength(1);
        expect(result[0].content).toBe('How are you?');
    });

    it('should handle multiple new messages', () => {
        const incoming: MessageForStore[] = [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi!' },
            { role: 'user', content: 'Question 1' },
            { role: 'assistant', content: 'Answer 1' },
        ];
        const stored: Message[] = [
            createStoredMessage('user', 'Hello', 0),
            createStoredMessage('assistant', 'Hi!', 1),
        ];

        const result = findNewMessages(incoming, stored);
        expect(result).toHaveLength(2);
        expect(result[0].content).toBe('Question 1');
        expect(result[1].content).toBe('Answer 1');
    });
});



describe('ID-based deduplication', () => {
    it('should deduplicate tool messages by call_id even when content changes', () => {
        // This is the core fix for issue #52 - Home Assistant modifies tool output content
        const callId = 'tool-call-123';

        // Stored message has original content
        const stored: Message[] = [
            createStoredMessage('user', 'Turn on the light', 0),
            createStoredMessage('user', '```json\n{"type":"function_call_output","call_id":"tool-call-123","output":{"speech":{}}}\n```', 1, callId),
        ];

        // Incoming message has modified content (Home Assistant added speech.plain)
        const incoming: MessageForStore[] = [
            { role: 'user', content: 'Turn on the light' },
            {
                role: 'user',
                content: '```json\n{"type":"function_call_output","call_id":"tool-call-123","output":{"speech":{"plain":{"speech":"Light turned on"}}}}\n```',
                id: callId,  // Same call_id - should match
            },
            { role: 'user', content: 'Thanks!' },
        ];

        const result = findNewMessages(incoming, stored);
        expect(result).toHaveLength(1);
        expect(result[0].content).toBe('Thanks!');
    });

    it('should deduplicate function_call messages by call_id', () => {
        const callId = 'fc-456';

        const stored: Message[] = [
            createStoredMessage('user', 'What time is it?', 0),
            createStoredMessage('assistant', '{"type":"function_call","call_id":"fc-456","name":"get_time","arguments":"{}"}', 1, callId),
        ];

        const incoming: MessageForStore[] = [
            { role: 'user', content: 'What time is it?' },
            { role: 'assistant', content: '{"type":"function_call","call_id":"fc-456","name":"get_time","arguments":"{}"}', id: callId },
            { role: 'user', content: '{"type":"function_call_output","call_id":"fc-456","output":"10:30 AM"}', id: callId },
        ];

        const result = findNewMessages(incoming, stored);
        expect(result).toHaveLength(1);
        expect(result[0].content).toContain('10:30 AM');
    });

    it('should fall back to hash for messages without id', () => {
        const stored: Message[] = [
            createStoredMessage('user', 'Hello', 0),
            createStoredMessage('assistant', 'Hi there!', 1),
        ];

        const incoming: MessageForStore[] = [
            { role: 'user', content: 'Hello' },  // No id, uses hash
            { role: 'assistant', content: 'Hi there!' },  // No id, uses hash
            { role: 'user', content: 'New message' },
        ];

        const result = findNewMessages(incoming, stored);
        expect(result).toHaveLength(1);
        expect(result[0].content).toBe('New message');
    });

});