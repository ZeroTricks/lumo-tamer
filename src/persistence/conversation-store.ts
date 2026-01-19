/**
 * In-memory conversation store with LRU eviction
 *
 * Manages active conversations and provides methods for:
 * - Creating/retrieving conversations
 * - Appending messages with deduplication
 * - Converting to Lumo Turn format
 * - Tracking dirty state for sync
 */

import { randomUUID } from 'crypto';
import { logger } from '../logger.js';
import type { Turn } from '../lumo-client/types.js';
import {
    findNewMessages,
    isValidContinuation,
    type IncomingMessage,
} from './deduplication.js';
import type {
    ConversationId,
    ConversationState,
    Message,
    MessageId,
    MessageRole,
    PersistenceConfig,
    SpaceId,
} from './types.js';

const DEFAULT_CONFIG: PersistenceConfig = {
    enabled: true,
    syncInterval: 30000,
    maxConversationsInMemory: 100,
    defaultSpaceName: 'lumo-bridge',
};

/**
 * In-memory conversation store
 */
export class ConversationStore {
    private conversations = new Map<ConversationId, ConversationState>();
    private accessOrder: ConversationId[] = [];  // LRU tracking
    private config: PersistenceConfig;
    private defaultSpaceId: SpaceId;

    constructor(config: Partial<PersistenceConfig> = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.defaultSpaceId = randomUUID();
        logger.info({ spaceId: this.defaultSpaceId }, 'ConversationStore initialized');
    }

    /**
     * Get or create a conversation by ID
     */
    getOrCreate(id: ConversationId): ConversationState {
        let state = this.conversations.get(id);

        if (!state) {
            state = this.createEmptyState(id);
            this.conversations.set(id, state);
            logger.debug({ conversationId: id }, 'Created new conversation');
        }

        this.touchLRU(id);
        this.evictIfNeeded();

        return state;
    }

    /**
     * Get a conversation by ID (returns undefined if not found)
     */
    get(id: ConversationId): ConversationState | undefined {
        const state = this.conversations.get(id);
        if (state) {
            this.touchLRU(id);
        }
        return state;
    }

    /**
     * Check if a conversation exists
     */
    has(id: ConversationId): boolean {
        return this.conversations.has(id);
    }

    /**
     * Append messages from API request (with deduplication)
     *
     * @param id - Conversation ID
     * @param incoming - Messages from API request
     * @returns Array of newly added messages
     * @todo Refactor to share code with appendAssistantResponse()
     */
    appendMessages(
        id: ConversationId,
        incoming: IncomingMessage[]
    ): Message[] {
        const state = this.getOrCreate(id);

        // Validate continuation
        const validation = isValidContinuation(incoming, state.messages);
        if (!validation.valid) {
            logger.warn({
                conversationId: id,
                reason: validation.reason,
                incomingCount: incoming.length,
                storedCount: state.messages.length,
            }, 'Invalid conversation continuation');
            // For now, we continue anyway but log the warning
        }

        // Find new messages
        const newMessages = findNewMessages(incoming, state.messages);

        if (newMessages.length === 0) {
            logger.debug({ conversationId: id }, 'No new messages to append');
            return [];
        }

        // Convert to Message format and append
        const now = Date.now();
        const lastMessageId = state.messages.length > 0
            ? state.messages[state.messages.length - 1].id
            : undefined;

        const addedMessages: Message[] = [];
        let parentId = lastMessageId;

        for (const msg of newMessages) {
            const message: Message = {
                id: randomUUID(),
                conversationId: id,
                createdAt: now,
                role: msg.role as MessageRole,
                parentId,
                status: 'completed',
                content: msg.content,
            };

            state.messages.push(message);
            addedMessages.push(message);
            parentId = message.id;
        }

        // Mark as dirty
        state.dirty = true;
        state.metadata.updatedAt = now;

        logger.debug({
            conversationId: id,
            addedCount: addedMessages.length,
            totalCount: state.messages.length,
        }, 'Appended messages');

        return addedMessages;
    }

    /**
     * Append assistant response after LLM generation
     *
     * @param id - Conversation ID
     * @param content - Assistant's response content
     * @param status - Message status (default: completed)
     * @returns The created message
     * @todo Refactor to share code with appendMessages()
     */
    appendAssistantResponse(
        id: ConversationId,
        content: string,
        status: 'completed' | 'failed' = 'completed'
    ): Message {
        const state = this.getOrCreate(id);
        const now = Date.now();

        // Get parent ID (last message)
        const parentId = state.messages.length > 0
            ? state.messages[state.messages.length - 1].id
            : undefined;

        const message: Message = {
            id: randomUUID(),
            conversationId: id,
            createdAt: now,
            role: 'assistant',
            parentId,
            status,
            content,
        };

        state.messages.push(message);
        state.dirty = true;
        state.metadata.updatedAt = now;
        state.status = 'completed';

        logger.debug({
            conversationId: id,
            messageId: message.id,
            contentLength: content.length,
        }, 'Appended assistant response');

        return message;
    }

    /**
     * Mark conversation as generating (for streaming)
     */
    setGenerating(id: ConversationId): void {
        const state = this.get(id);
        if (state) {
            state.status = 'generating';
        }
    }

    /**
     * Update conversation title
     */
    setTitle(id: ConversationId, title: string): void {
        const state = this.get(id);
        if (state) {
            state.title = title;
            state.dirty = true;
            state.metadata.updatedAt = Date.now();
        }
    }

    /**
     * Convert conversation to Lumo Turn[] format for API call
     */
    toTurns(id: ConversationId): Turn[] {
        const state = this.conversations.get(id);
        if (!state) {
            return [];
        }

        // Filter to user and assistant messages only
        return state.messages
            .filter(m => m.role === 'user' || m.role === 'assistant')
            .map(m => ({
                role: m.role as 'user' | 'assistant',
                content: m.content,
            }));
    }

    /**
     * Get all messages in a conversation
     */
    getMessages(id: ConversationId): Message[] {
        const state = this.conversations.get(id);
        return state?.messages ?? [];
    }

    /**
     * Get message by ID
     */
    getMessage(conversationId: ConversationId, messageId: MessageId): Message | undefined {
        const state = this.conversations.get(conversationId);
        return state?.messages.find(m => m.id === messageId);
    }

    /**
     * Delete a conversation
     */
    delete(id: ConversationId): boolean {
        const existed = this.conversations.delete(id);
        if (existed) {
            this.accessOrder = this.accessOrder.filter(cid => cid !== id);
            logger.debug({ conversationId: id }, 'Deleted conversation');
        }
        return existed;
    }

    /**
     * Get all conversations (for iteration)
     */
    entries(): IterableIterator<[ConversationId, ConversationState]> {
        return this.conversations.entries();
    }

    /**
     * Get all dirty conversations (need sync)
     */
    getDirty(): ConversationState[] {
        return Array.from(this.conversations.values()).filter(c => c.dirty);
    }

    /**
     * Mark a conversation as synced
     */
    markSynced(id: ConversationId): void {
        const state = this.conversations.get(id);
        if (state) {
            state.dirty = false;
            state.lastSyncedAt = Date.now();
        }
    }

    /**
     * Get store statistics
     */
    getStats(): {
        total: number;
        dirty: number;
        maxSize: number;
    } {
        return {
            total: this.conversations.size,
            dirty: this.getDirty().length,
            maxSize: this.config.maxConversationsInMemory,
        };
    }

    // Private methods

    private createEmptyState(id: ConversationId): ConversationState {
        const now = Date.now();
        return {
            metadata: {
                id,
                spaceId: this.defaultSpaceId,
                createdAt: now,
                updatedAt: now,
                starred: false,
            },
            title: 'New Conversation',
            status: 'completed',
            messages: [],
            dirty: true,  // New conversations need sync
        };
    }

    private touchLRU(id: ConversationId): void {
        // Remove from current position
        const index = this.accessOrder.indexOf(id);
        if (index !== -1) {
            this.accessOrder.splice(index, 1);
        }
        // Add to end (most recently used)
        this.accessOrder.push(id);
    }

    private evictIfNeeded(): void {
        while (this.conversations.size > this.config.maxConversationsInMemory) {
            // Evict least recently used
            const toEvict = this.accessOrder.shift();
            if (toEvict) {
                const state = this.conversations.get(toEvict);
                if (state?.dirty) {
                    // Don't evict dirty conversations, move to end
                    this.accessOrder.push(toEvict);
                    logger.warn({
                        conversationId: toEvict,
                        size: this.conversations.size,
                    }, 'Skipping eviction of dirty conversation');

                    // If all are dirty, we have to evict anyway
                    if (this.accessOrder.every(id => this.conversations.get(id)?.dirty)) {
                        const forced = this.accessOrder.shift();
                        if (forced) {
                            this.conversations.delete(forced);
                            logger.warn({ conversationId: forced }, 'Force-evicted dirty conversation');
                        }
                        break;
                    }
                } else {
                    this.conversations.delete(toEvict);
                    logger.debug({ conversationId: toEvict }, 'Evicted conversation from cache');
                }
            }
        }
    }
}

// Singleton instance
let storeInstance: ConversationStore | null = null;

/**
 * Get the global ConversationStore instance
 */
export function getConversationStore(config?: Partial<PersistenceConfig>): ConversationStore {
    if (!storeInstance) {
        storeInstance = new ConversationStore(config);
    }
    return storeInstance;
}

/**
 * Reset the store (for testing)
 */
export function resetConversationStore(): void {
    storeInstance = null;
}
