/**
 * Unit tests for ConversationStore
 *
 * Tests in-memory conversation management, LRU eviction,
 * message deduplication, and Turn conversion.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ConversationStore } from '../../src/conversations/store.js';

let store: ConversationStore;

beforeEach(() => {
  store = new ConversationStore({ maxConversationsInMemory: 5 });
});

describe('ConversationStore', () => {
  describe('getOrCreate', () => {
    it('creates new conversation when none exists', () => {
      const state = store.getOrCreate('conv-1');
      expect(state).toBeDefined();
      expect(state.title).toBe('New Conversation');
      expect(state.messages).toEqual([]);
      expect(state.status).toBe('completed');
    });

    it('returns existing conversation on second call', () => {
      const first = store.getOrCreate('conv-1');
      first.title = 'Modified';
      const second = store.getOrCreate('conv-1');
      expect(second.title).toBe('Modified');
    });

    it('marks new conversations as dirty', () => {
      const state = store.getOrCreate('conv-1');
      expect(state.dirty).toBe(true);
    });
  });

  describe('get / has', () => {
    it('returns undefined for non-existent conversation', () => {
      expect(store.get('nonexistent')).toBeUndefined();
    });

    it('returns state for existing conversation', () => {
      store.getOrCreate('conv-1');
      expect(store.get('conv-1')).toBeDefined();
    });

    it('has returns true for existing conversation', () => {
      store.getOrCreate('conv-1');
      expect(store.has('conv-1')).toBe(true);
      expect(store.has('nonexistent')).toBe(false);
    });
  });

  describe('appendMessages', () => {
    it('appends messages to empty conversation', () => {
      const added = store.appendMessages('conv-1', [
        { role: 'user', content: 'Hello' },
      ]);
      expect(added).toHaveLength(1);
      expect(added[0].role).toBe('user');
      expect(added[0].content).toBe('Hello');
    });

    it('deduplicates previously stored messages', () => {
      store.appendMessages('conv-1', [
        { role: 'user', content: 'Hello' },
      ]);
      // Send same message again (typical API re-send pattern)
      const added = store.appendMessages('conv-1', [
        { role: 'user', content: 'Hello' },
      ]);
      expect(added).toHaveLength(0);
    });

    it('returns only newly added messages', () => {
      store.appendMessages('conv-1', [
        { role: 'user', content: 'Hello' },
      ]);
      const added = store.appendMessages('conv-1', [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi!' },
        { role: 'user', content: 'New message' },
      ]);
      expect(added).toHaveLength(2);
      expect(added[0].content).toBe('Hi!');
      expect(added[1].content).toBe('New message');
    });

    it('sets parentId chain correctly', () => {
      const added = store.appendMessages('conv-1', [
        { role: 'user', content: 'First' },
        { role: 'assistant', content: 'Second' },
      ]);
      expect(added[0].parentId).toBeUndefined();
      expect(added[1].parentId).toBe(added[0].id);
    });
  });

  describe('appendAssistantResponse', () => {
    it('appends response and marks conversation completed', () => {
      store.appendMessages('conv-1', [{ role: 'user', content: 'Hi' }]);
      const msg = store.appendAssistantResponse('conv-1', 'Hello there!');

      expect(msg.role).toBe('assistant');
      expect(msg.content).toBe('Hello there!');
      expect(msg.status).toBe('completed');

      const state = store.get('conv-1')!;
      expect(state.status).toBe('completed');
    });

    it('marks conversation dirty', () => {
      store.getOrCreate('conv-1');
      store.markSynced('conv-1');
      expect(store.get('conv-1')!.dirty).toBe(false);

      store.appendAssistantResponse('conv-1', 'Response');
      expect(store.get('conv-1')!.dirty).toBe(true);
    });

    it('sets parentId to last message', () => {
      const [userMsg] = store.appendMessages('conv-1', [
        { role: 'user', content: 'Hi' },
      ]);
      const assistantMsg = store.appendAssistantResponse('conv-1', 'Hello');
      expect(assistantMsg.parentId).toBe(userMsg.id);
    });
  });

  describe('toTurns', () => {
    it('converts messages to Turn[] format', () => {
      store.appendMessages('conv-1', [
        { role: 'user', content: 'Hello' },
      ]);
      store.appendAssistantResponse('conv-1', 'Hi!');

      const turns = store.toTurns('conv-1');
      expect(turns).toEqual([
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi!' },
      ]);
    });

    it('filters to user and assistant roles only', () => {
      // Manually add a system message via the store internals
      const state = store.getOrCreate('conv-1');
      state.messages.push({
        id: 'sys-1',
        conversationId: 'conv-1',
        createdAt: Date.now(),
        role: 'system',
        status: 'completed',
        content: 'You are helpful',
      });
      store.appendMessages('conv-1', [
        { role: 'user', content: 'Hello' },
      ]);

      const turns = store.toTurns('conv-1');
      expect(turns).toHaveLength(1);
      expect(turns[0].role).toBe('user');
    });

    it('returns empty array for non-existent conversation', () => {
      expect(store.toTurns('nonexistent')).toEqual([]);
    });
  });

  describe('LRU eviction', () => {
    it('evicts least recently used when max exceeded', () => {
      // Create 5 conversations (at max)
      for (let i = 0; i < 5; i++) {
        const state = store.getOrCreate(`conv-${i}`);
        store.markSynced(`conv-${i}`);  // Mark clean so they can be evicted
        state.dirty = false;
      }

      // Access conv-0 to make it most recent
      store.get('conv-0');

      // Add 6th conversation, should evict conv-1 (oldest non-recently-used)
      store.getOrCreate('conv-5');
      store.markSynced('conv-5');

      expect(store.has('conv-0')).toBe(true);   // accessed recently
      expect(store.has('conv-1')).toBe(false);   // evicted (LRU)
      expect(store.has('conv-5')).toBe(true);    // just created
    });

    it('skips dirty conversations during eviction', () => {
      // Create 5 conversations, all clean except conv-1
      for (let i = 0; i < 5; i++) {
        store.getOrCreate(`conv-${i}`);
        if (i !== 1) {
          store.markSynced(`conv-${i}`);
          store.get(`conv-${i}`)!.dirty = false;
        }
      }

      // Add 6th: conv-0 is LRU but let's check dirty skipping
      // conv-0 should be evicted since it's clean
      store.getOrCreate('conv-5');

      expect(store.has('conv-1')).toBe(true);  // dirty, not evicted
    });
  });

  describe('deduplication helpers', () => {
    it('isDuplicateFunctionCallId detects duplicates', () => {
      store.setLastFunctionCallId('conv-1', 'call-abc');
      expect(store.isDuplicateFunctionCallId('conv-1', 'call-abc')).toBe(true);
      expect(store.isDuplicateFunctionCallId('conv-1', 'call-xyz')).toBe(false);
    });

    it('hasGeneratedCallId tracks generated IDs', () => {
      expect(store.hasGeneratedCallId('conv-1', 'call-1')).toBe(false);
      store.addGeneratedCallId('conv-1', 'call-1');
      expect(store.hasGeneratedCallId('conv-1', 'call-1')).toBe(true);
    });
  });

  describe('setTitle', () => {
    it('updates title and marks dirty', () => {
      store.getOrCreate('conv-1');
      store.markSynced('conv-1');
      store.get('conv-1')!.dirty = false;

      store.setTitle('conv-1', 'My Chat');
      expect(store.get('conv-1')!.title).toBe('My Chat');
      expect(store.get('conv-1')!.dirty).toBe(true);
    });
  });

  describe('delete', () => {
    it('removes conversation', () => {
      store.getOrCreate('conv-1');
      expect(store.delete('conv-1')).toBe(true);
      expect(store.has('conv-1')).toBe(false);
    });

    it('returns false for non-existent conversation', () => {
      expect(store.delete('nonexistent')).toBe(false);
    });
  });

  describe('getStats', () => {
    it('returns correct statistics', () => {
      store.getOrCreate('conv-1');
      store.getOrCreate('conv-2');
      store.markSynced('conv-1');
      store.get('conv-1')!.dirty = false;

      const stats = store.getStats();
      expect(stats.total).toBe(2);
      expect(stats.dirty).toBe(1);  // conv-2 is dirty
      expect(stats.maxSize).toBe(5);
    });
  });
});
