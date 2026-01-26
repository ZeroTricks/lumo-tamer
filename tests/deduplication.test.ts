/**
 * Tests for message deduplication logic
 */

import { describe, it, expect } from 'vitest';
import {
    hashMessage,
    findNewMessages,
    isValidContinuation,
    detectBranching,
    type IncomingMessage,
} from '../src/persistence/deduplication.js';
import type { Message } from '../src/persistence/types.js';

// Helper to create a stored message
function createStoredMessage(
    role: string,
    content: string,
    index: number
): Message {
    return {
        id: `msg-${index}`,
        conversationId: 'conv-1',
        createdAt: Date.now(),
        role: role as Message['role'],
        status: 'completed',
        content,
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
        const incoming: IncomingMessage[] = [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi there!' },
        ];
        const stored: Message[] = [];

        const result = findNewMessages(incoming, stored);
        expect(result).toHaveLength(2);
        expect(result[0].content).toBe('Hello');
    });

    it('should return empty array when no new messages', () => {
        const incoming: IncomingMessage[] = [
            { role: 'user', content: 'Hello' },
        ];
        const stored: Message[] = [
            createStoredMessage('user', 'Hello', 0),
        ];

        const result = findNewMessages(incoming, stored);
        expect(result).toHaveLength(0);
    });

    it('should return only new messages at the end', () => {
        const incoming: IncomingMessage[] = [
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
        const incoming: IncomingMessage[] = [
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

describe('isValidContinuation', () => {
    it('should be valid when stored is empty', () => {
        const incoming: IncomingMessage[] = [
            { role: 'user', content: 'Hello' },
        ];
        const stored: Message[] = [];

        const result = isValidContinuation(incoming, stored);
        expect(result.valid).toBe(true);
    });

    it('should be valid when incoming continues stored', () => {
        const incoming: IncomingMessage[] = [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi!' },
            { role: 'user', content: 'New message' },
        ];
        const stored: Message[] = [
            createStoredMessage('user', 'Hello', 0),
            createStoredMessage('assistant', 'Hi!', 1),
        ];

        const result = isValidContinuation(incoming, stored);
        expect(result.valid).toBe(true);
    });

    it('should be invalid when incoming has fewer messages', () => {
        const incoming: IncomingMessage[] = [
            { role: 'user', content: 'Hello' },
        ];
        const stored: Message[] = [
            createStoredMessage('user', 'Hello', 0),
            createStoredMessage('assistant', 'Hi!', 1),
        ];

        const result = isValidContinuation(incoming, stored);
        expect(result.valid).toBe(false);
        expect(result.reason).toContain('fewer messages');
    });

    it('should be invalid when history is modified', () => {
        const incoming: IncomingMessage[] = [
            { role: 'user', content: 'Hello MODIFIED' },
            { role: 'assistant', content: 'Hi!' },
        ];
        const stored: Message[] = [
            createStoredMessage('user', 'Hello', 0),
            createStoredMessage('assistant', 'Hi!', 1),
        ];

        const result = isValidContinuation(incoming, stored);
        expect(result.valid).toBe(false);
        expect(result.reason).toContain('mismatch');
    });
});

describe('detectBranching', () => {
    it('should not detect branching when empty', () => {
        const result = detectBranching([], []);
        expect(result.isBranching).toBe(false);
    });

    it('should not detect branching for simple continuation', () => {
        const incoming: IncomingMessage[] = [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi!' },
            { role: 'user', content: 'New' },
        ];
        const stored: Message[] = [
            createStoredMessage('user', 'Hello', 0),
            createStoredMessage('assistant', 'Hi!', 1),
        ];

        const result = detectBranching(incoming, stored);
        expect(result.isBranching).toBe(false);
    });

    it('should detect branching when history diverges', () => {
        const incoming: IncomingMessage[] = [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Different response' },
        ];
        const stored: Message[] = [
            createStoredMessage('user', 'Hello', 0),
            createStoredMessage('assistant', 'Original response', 1),
            createStoredMessage('user', 'Follow up', 2),
        ];

        const result = detectBranching(incoming, stored);
        expect(result.isBranching).toBe(true);
        expect(result.branchPoint).toBe(1);
    });
});
