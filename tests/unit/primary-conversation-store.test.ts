/**
 * Unit tests for ConversationStore (Redux + IndexedDB)
 *
 * Tests the primary conversation store implementation using fake-indexeddb.
 * Mirrors FallbackStore tests for consistent behavior verification.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    initializeMockStore,
    type MockStoreResult,
} from '../../src/mock/mock-store.js';

let ctx: MockStoreResult;

beforeEach(async () => {
    // Use unique userId per test for IDB isolation
    const testUserId = 'test-user-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    ctx = await initializeMockStore({
        maxInMemory: 50,
        userId: testUserId,
        spaceId: 'test-space-id',
    });
});

afterEach(async () => {
    await ctx.cleanup();
});

describe('ConversationStore', () => {
    describe('getOrCreate', () => {
        it('creates new conversation when none exists', () => {
            const state = ctx.conversationStore.getOrCreate('conv-1');
            expect(state).toBeDefined();
            expect(state.title).toBe('New Conversation');
            expect(state.messages).toEqual([]);
            expect(state.status).toBe('completed');
        });

        it('returns existing conversation on second call', () => {
            const first = ctx.conversationStore.getOrCreate('conv-1');
            ctx.conversationStore.setTitle('conv-1', 'Modified');
            const second = ctx.conversationStore.getOrCreate('conv-1');
            expect(second.title).toBe('Modified');
        });
    });

    describe('get / has', () => {
        it('returns undefined for non-existent conversation', () => {
            expect(ctx.conversationStore.get('nonexistent')).toBeUndefined();
        });

        it('returns state for existing conversation', () => {
            ctx.conversationStore.getOrCreate('conv-1');
            expect(ctx.conversationStore.get('conv-1')).toBeDefined();
        });

        it('has returns true for existing conversation', () => {
            ctx.conversationStore.getOrCreate('conv-1');
            expect(ctx.conversationStore.has('conv-1')).toBe(true);
            expect(ctx.conversationStore.has('nonexistent')).toBe(false);
        });
    });

    describe('appendMessages', () => {
        it('appends messages to empty conversation', () => {
            const added = ctx.conversationStore.appendMessages('conv-1', [
                { role: 'user', content: 'Hello' },
            ]);
            expect(added).toHaveLength(1);
            expect(added[0].role).toBe('user');
            expect(added[0].content).toBe('Hello');
        });

        it('deduplicates previously stored messages', () => {
            ctx.conversationStore.appendMessages('conv-1', [
                { role: 'user', content: 'Hello' },
            ]);
            // Send same message again (typical API re-send pattern)
            const added = ctx.conversationStore.appendMessages('conv-1', [
                { role: 'user', content: 'Hello' },
            ]);
            expect(added).toHaveLength(0);
        });

        it('returns only newly added messages', () => {
            ctx.conversationStore.appendMessages('conv-1', [
                { role: 'user', content: 'Hello' },
            ]);
            const added = ctx.conversationStore.appendMessages('conv-1', [
                { role: 'user', content: 'Hello' },
                { role: 'assistant', content: 'Hi!' },
                { role: 'user', content: 'New message' },
            ]);
            expect(added).toHaveLength(2);
            expect(added[0].content).toBe('Hi!');
            expect(added[1].content).toBe('New message');
        });

        it('sets parentId chain correctly', () => {
            const added = ctx.conversationStore.appendMessages('conv-1', [
                { role: 'user', content: 'First' },
                { role: 'assistant', content: 'Second' },
            ]);
            expect(added[0].parentId).toBeUndefined();
            expect(added[1].parentId).toBe(added[0].id);
        });
    });

    describe('appendAssistantResponse', () => {
        it('appends response and marks conversation completed', () => {
            ctx.conversationStore.appendMessages('conv-1', [
                { role: 'user', content: 'Hi' },
            ]);
            const msg = ctx.conversationStore.appendAssistantResponse('conv-1', {
                content: 'Hello there!',
            });

            expect(msg.role).toBe('assistant');
            expect(msg.content).toBe('Hello there!');
            expect(msg.status).toBe('succeeded');

            const state = ctx.conversationStore.get('conv-1')!;
            expect(state.status).toBe('completed');
        });

        it('sets parentId to last message', () => {
            const [userMsg] = ctx.conversationStore.appendMessages('conv-1', [
                { role: 'user', content: 'Hi' },
            ]);
            const assistantMsg = ctx.conversationStore.appendAssistantResponse(
                'conv-1',
                { content: 'Hello' }
            );
            expect(assistantMsg.parentId).toBe(userMsg.id);
        });

        it('stores native tool call data', () => {
            ctx.conversationStore.appendMessages('conv-1', [
                { role: 'user', content: 'Search for news' },
            ]);
            const msg = ctx.conversationStore.appendAssistantResponse('conv-1', {
                content: 'Here are the results...',
                toolCall: '{"name":"web_search","arguments":{"query":"news"}}',
                toolResult: '{"results":[]}',
            });

            expect(msg.content).toBe('Here are the results...');
            expect(msg.toolCall).toBe(
                '{"name":"web_search","arguments":{"query":"news"}}'
            );
            expect(msg.toolResult).toBe('{"results":[]}');
        });
    });

    describe('appendUserMessage', () => {
        it('appends user message', () => {
            const msg = ctx.conversationStore.appendUserMessage('conv-1', 'Hello');
            expect(msg.role).toBe('user');
            expect(msg.content).toBe('Hello');
        });

        it('sets parentId to last message', () => {
            const first = ctx.conversationStore.appendUserMessage('conv-1', 'First');
            const second = ctx.conversationStore.appendUserMessage('conv-1', 'Second');
            expect(second.parentId).toBe(first.id);
        });
    });

    describe('toTurns', () => {
        it('converts messages to Turn[] format', () => {
            ctx.conversationStore.appendMessages('conv-1', [
                { role: 'user', content: 'Hello' },
            ]);
            ctx.conversationStore.appendAssistantResponse('conv-1', {
                content: 'Hi!',
            });

            const turns = ctx.conversationStore.toTurns('conv-1');
            expect(turns).toEqual([
                { role: 'user', content: 'Hello' },
                { role: 'assistant', content: 'Hi!' },
            ]);
        });

        it('returns empty array for non-existent conversation', () => {
            expect(ctx.conversationStore.toTurns('nonexistent')).toEqual([]);
        });
    });

    describe('getMessages', () => {
        it('returns all messages in order', () => {
            ctx.conversationStore.appendMessages('conv-1', [
                { role: 'user', content: 'First' },
                { role: 'assistant', content: 'Second' },
            ]);
            ctx.conversationStore.appendUserMessage('conv-1', 'Third');

            const messages = ctx.conversationStore.getMessages('conv-1');
            expect(messages).toHaveLength(3);
            expect(messages[0].content).toBe('First');
            expect(messages[1].content).toBe('Second');
            expect(messages[2].content).toBe('Third');
        });

        it('returns empty array for non-existent conversation', () => {
            expect(ctx.conversationStore.getMessages('nonexistent')).toEqual([]);
        });
    });

    describe('getMessage', () => {
        it('returns message by ID', () => {
            const [msg] = ctx.conversationStore.appendMessages('conv-1', [
                { role: 'user', content: 'Hello' },
            ]);

            const retrieved = ctx.conversationStore.getMessage('conv-1', msg.id);
            expect(retrieved).toBeDefined();
            expect(retrieved!.content).toBe('Hello');
        });

        it('returns undefined for non-existent message', () => {
            ctx.conversationStore.getOrCreate('conv-1');
            expect(
                ctx.conversationStore.getMessage('conv-1', 'nonexistent')
            ).toBeUndefined();
        });
    });

    describe('setTitle', () => {
        it('updates title', () => {
            ctx.conversationStore.getOrCreate('conv-1');
            ctx.conversationStore.setTitle('conv-1', 'My Chat');
            expect(ctx.conversationStore.get('conv-1')!.title).toBe('My Chat');
        });
    });

    describe('setGenerating', () => {
        it('sets conversation status to generating', () => {
            ctx.conversationStore.getOrCreate('conv-1');
            ctx.conversationStore.setGenerating('conv-1');
            expect(ctx.conversationStore.get('conv-1')!.status).toBe('generating');
        });
    });

    describe('delete', () => {
        it('removes conversation', () => {
            ctx.conversationStore.getOrCreate('conv-1');
            expect(ctx.conversationStore.delete('conv-1')).toBe(true);
            expect(ctx.conversationStore.has('conv-1')).toBe(false);
        });

        it('returns false for non-existent conversation', () => {
            expect(ctx.conversationStore.delete('nonexistent')).toBe(false);
        });
    });

    describe('entries', () => {
        it('iterates over all conversations', () => {
            ctx.conversationStore.getOrCreate('conv-1');
            ctx.conversationStore.getOrCreate('conv-2');

            const entries = Array.from(ctx.conversationStore.entries());
            expect(entries.length).toBeGreaterThanOrEqual(2);

            const ids = entries.map(([id]) => id);
            expect(ids).toContain('conv-1');
            expect(ids).toContain('conv-2');
        });
    });

    describe('getStats', () => {
        it('returns correct total count', () => {
            ctx.conversationStore.getOrCreate('conv-1');
            ctx.conversationStore.getOrCreate('conv-2');

            const stats = ctx.conversationStore.getStats();
            expect(stats.total).toBeGreaterThanOrEqual(2);
            // dirty is always 0 for ConversationStore (upstream uses IDB flags)
            expect(stats.dirty).toBe(0);
        });
    });

    describe('createFromTurns', () => {
        it('creates conversation from turns', () => {
            const turns = [
                { role: 'user' as const, content: 'Hello' },
                { role: 'assistant' as const, content: 'Hi!' },
            ];

            const result = ctx.conversationStore.createFromTurns(turns, 'Test Chat');
            expect(result.title).toBe('Test Chat');
            expect(result.conversationId).toBeDefined();

            const state = ctx.conversationStore.get(result.conversationId);
            expect(state).toBeDefined();
            expect(state!.title).toBe('Test Chat');
            expect(state!.messages).toHaveLength(2);
        });

        it('auto-generates title from first user message', () => {
            const turns = [
                { role: 'user' as const, content: 'What is the weather?' },
                { role: 'assistant' as const, content: 'I can check that.' },
            ];

            const result = ctx.conversationStore.createFromTurns(turns);
            expect(result.title).toBe('What is the weather?');
        });
    });

    describe('onDirtyCallback', () => {
        it('calls callback when messages are appended', () => {
            let callCount = 0;
            ctx.conversationStore.setOnDirtyCallback(() => {
                callCount++;
            });

            // getOrCreate doesn't call notifyDirty (upstream uses IDB dirty flags)
            ctx.conversationStore.getOrCreate('conv-1');
            expect(callCount).toBe(0);

            // appendMessages does call notifyDirty
            ctx.conversationStore.appendMessages('conv-1', [
                { role: 'user', content: 'Hello' },
            ]);
            expect(callCount).toBe(1);

            // appendAssistantResponse also calls notifyDirty
            ctx.conversationStore.appendAssistantResponse('conv-1', {
                content: 'Hi!',
            });
            expect(callCount).toBe(2);

            // setTitle also calls notifyDirty
            ctx.conversationStore.setTitle('conv-1', 'New Title');
            expect(callCount).toBe(3);
        });
    });

    describe('semantic ID handling', () => {
        it('uses provided ID for tool messages', () => {
            const added = ctx.conversationStore.appendMessages('conv-1', [
                { role: 'user', content: 'Call tool', id: 'custom-semantic-id' },
            ]);
            expect(added[0].semanticId).toBe('custom-semantic-id');
        });

        it('generates hash-based ID when not provided', () => {
            const added = ctx.conversationStore.appendMessages('conv-1', [
                { role: 'user', content: 'Hello' },
            ]);
            expect(added[0].semanticId).toBeDefined();
            expect(added[0].semanticId.length).toBe(16);
        });

        it('uses semanticId for deduplication', () => {
            // Add with explicit ID
            ctx.conversationStore.appendMessages('conv-1', [
                { role: 'user', content: 'Hello', id: 'my-id' },
            ]);

            // Try to add same semantic ID with different content
            const added = ctx.conversationStore.appendMessages('conv-1', [
                { role: 'user', content: 'Different content', id: 'my-id' },
            ]);

            // Should be deduplicated based on semanticId
            expect(added).toHaveLength(0);
        });
    });
});
