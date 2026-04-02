/**
 * Unit tests for conversation search
 */

import { describe, it, expect } from 'vitest';
import {
    searchConversations,
    formatSearchResults,
    type SearchResult,
} from '../../src/conversations/search.js';
import type { ConversationStore } from '../../src/conversations/index.js';
import type { ConversationId, ConversationState, Message } from '../../src/conversations/types.js';

/**
 * Create a mock store with test conversations
 */
function createMockStore(conversations: Map<ConversationId, ConversationState>): Pick<ConversationStore, 'entries'> {
    return {
        entries: () => conversations.entries(),
    };
}

function createConversation(
    id: string,
    title: string,
    messages: Array<{ role: string; content: string }>,
    updatedAt = new Date().toISOString()
): [ConversationId, ConversationState] {
    return [
        id,
        {
            metadata: {
                id,
                spaceId: 'space-1',
                createdAt: updatedAt,
                updatedAt,
            },
            title,
            status: 'completed',
            messages: messages.map((m, i) => ({
                id: `msg-${i}`,
                conversationId: id,
                createdAt: updatedAt,
                role: m.role as Message['role'],
                status: 'succeeded' as const,
                content: m.content,
            })),
            dirty: false,
        },
    ];
}

describe('searchConversations', () => {
    it('returns empty array when store is empty', () => {
        const store = createMockStore(new Map());
        const results = searchConversations(store, 'test');
        expect(results).toEqual([]);
    });

    it('matches conversation titles (case-insensitive)', () => {
        const conversations = new Map([
            createConversation('conv-1', 'How to configure Caddy', []),
            createConversation('conv-2', 'Nginx setup guide', []),
        ]);
        const store = createMockStore(conversations);

        const results = searchConversations(store, 'caddy');
        expect(results).toHaveLength(1);
        expect(results[0].title).toBe('How to configure Caddy');
    });

    it('matches message content', () => {
        const conversations = new Map([
            createConversation('conv-1', 'Web Server Setup', [
                { role: 'user', content: 'How do I install nginx?' },
                { role: 'assistant', content: 'You can install nginx using apt...' },
            ]),
            createConversation('conv-2', 'Database Help', [
                { role: 'user', content: 'How do I backup postgres?' },
            ]),
        ]);
        const store = createMockStore(conversations);

        const results = searchConversations(store, 'nginx');
        expect(results).toHaveLength(1);
        expect(results[0].conversationId).toBe('conv-1');
        expect(results[0].snippet).toContain('nginx');
    });

    it('prefers title match over message match', () => {
        const conversations = new Map([
            createConversation('conv-1', 'Caddy Configuration', [
                { role: 'user', content: 'The caddy server is great' },
            ]),
        ]);
        const store = createMockStore(conversations);

        const results = searchConversations(store, 'caddy');
        expect(results).toHaveLength(1);
        // No snippet when title matches
        expect(results[0].snippet).toBeUndefined();
    });

    it('extracts snippet with context around match', () => {
        const longContent = 'This is a long message about various topics. ' +
            'Eventually we discuss how to configure caddy as a reverse proxy. ' +
            'There are many more details after this point.';

        const conversations = new Map([
            createConversation('conv-1', 'General Discussion', [
                { role: 'user', content: longContent },
            ]),
        ]);
        const store = createMockStore(conversations);

        const results = searchConversations(store, 'caddy');
        expect(results).toHaveLength(1);
        expect(results[0].snippet).toContain('caddy');
        expect(results[0].snippet).toContain('...');
    });

    it('respects limit parameter', () => {
        const conversations = new Map(
            Array.from({ length: 30 }, (_, i) =>
                createConversation(`conv-${i}`, `Test conversation ${i}`, [])
            )
        );
        const store = createMockStore(conversations);

        const results = searchConversations(store, 'test', 5);
        expect(results).toHaveLength(5);
    });

    it('sorts results by most recent first', () => {
        const conversations = new Map([
            createConversation('conv-old', 'Test old', [], '2024-01-01T00:00:00Z'),
            createConversation('conv-new', 'Test new', [], '2024-12-01T00:00:00Z'),
            createConversation('conv-mid', 'Test mid', [], '2024-06-01T00:00:00Z'),
        ]);
        const store = createMockStore(conversations);

        const results = searchConversations(store, 'test');
        expect(results).toHaveLength(3);
        expect(results[0].conversationId).toBe('conv-new');
        expect(results[1].conversationId).toBe('conv-mid');
        expect(results[2].conversationId).toBe('conv-old');
    });

    it('excludes specified conversation ID', () => {
        const conversations = new Map([
            createConversation('conv-1', 'Test one', []),
            createConversation('conv-2', 'Test two', []),
            createConversation('conv-3', 'Test three', []),
        ]);
        const store = createMockStore(conversations);

        const results = searchConversations(store, 'test', 20, 'conv-2');
        expect(results).toHaveLength(2);
        expect(results.find(r => r.conversationId === 'conv-2')).toBeUndefined();
    });
});

describe('formatSearchResults', () => {
    it('shows "no results" message for empty results', () => {
        const output = formatSearchResults([], 'test');
        expect(output).toContain('No results found');
        expect(output).toContain('test');
    });

    it('formats single result correctly', () => {
        const results: SearchResult[] = [{
            conversationId: 'conv-123',
            title: 'My Conversation',
            updatedAt: new Date().toISOString(),
        }];

        const output = formatSearchResults(results, 'test');
        expect(output).toContain('Found 1 result');
        expect(output).toContain('My Conversation');
        expect(output).toContain('conv-123');
    });

    it('formats multiple results with snippets', () => {
        const results: SearchResult[] = [
            {
                conversationId: 'conv-1',
                title: 'First Conversation',
                snippet: '...matching text here...',
                updatedAt: new Date().toISOString(),
            },
            {
                conversationId: 'conv-2',
                title: 'Second Conversation',
                updatedAt: new Date().toISOString(),
            },
        ];

        const output = formatSearchResults(results, 'query');
        expect(output).toContain('Found 2 results');
        expect(output).toContain('First Conversation');
        expect(output).toContain('matching text here');
        expect(output).toContain('Second Conversation');
    });
});
