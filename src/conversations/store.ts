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
import { logger } from '../app/logger.js';
import { deterministicUUID } from '../app/id-generator.js';
import { Role, type Turn, type AssistantMessageData } from '../lumo-client/types.js';
import {
    findNewMessages,
    hashMessage,
    isValidContinuation,
    type IncomingMessage,
} from './deduplication.js';
import type {
    ConversationId,
    ConversationState,
    Message,
    MessageId,
    MessageRole,
    ConversationStoreConfig,
    SpaceId,
} from './types.js';
import { getLogConfig } from 'app/config.js';
import { getMetrics } from '../app/metrics.js';

/**
 * In-memory conversation store
 */
export class ConversationStore {
    private conversations = new Map<ConversationId, ConversationState>();
    private accessOrder: ConversationId[] = [];  // LRU tracking
    private maxConversations: number;
    private defaultSpaceId: SpaceId;
    private onDirtyCallback?: () => void;

    constructor(config: ConversationStoreConfig) {
        this.maxConversations = config.maxConversationsInMemory;
        this.defaultSpaceId = randomUUID();
        logger.info({ spaceId: this.defaultSpaceId }, 'ConversationStore initialized');
    }

    /**
     * Set callback to be called when a conversation becomes dirty
     * Used by AutoSyncService to trigger sync scheduling
     */
    setOnDirtyCallback(callback: () => void): void {
        this.onDirtyCallback = callback;
    }

    /**
     * Get or create a conversation by ID
     */
    getOrCreate(id: ConversationId): ConversationState {
        let state = this.conversations.get(id);

        if (!state) {
            state = this.createEmptyState(id);
            this.conversations.set(id, state);
            getMetrics()?.conversationsCreatedTotal.inc();
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
            getMetrics()?.invalidContinuationsTotal.inc();
            logger.warn({
                conversationId: id,
                reason: validation.reason,
                incomingCount: incoming.length,
                storedCount: state.messages.length,
                ...validation.debugInfo,
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
            // Use provided ID (for tool messages) or compute hash (for regular messages)
            const semanticId = msg.id ?? hashMessage(msg.role, msg.content ?? '').slice(0, 16);

            const message: Message = {
                id: randomUUID(),
                conversationId: id,
                createdAt: now,
                role: msg.role as MessageRole,
                parentId,
                status: 'succeeded',
                content: msg.content,
                semanticId,
            };

            state.messages.push(message);
            addedMessages.push(message);
            parentId = message.id;
        }

        // Mark as dirty
        this.markDirty(state);
        state.metadata.updatedAt = now;

        // Track metrics for new messages only
        const metrics = getMetrics();
        if (metrics) {
            for (const msg of addedMessages) {
                metrics.messagesTotal.inc({ role: msg.role });
            }
        }

        logger.debug({
            conversationId: id,
            addedCount: addedMessages.length,
            totalCount: state.messages.length,
        }, 'Appended messages');

        return addedMessages;
    }

    /**
     * Append an assistant response to a conversation.
     *
     * @param id - Conversation ID
     * @param messageData - Assistant message data (content, optional toolCall/toolResult)
     * @param status - Message status (default: succeeded)
     * @param semanticId - Optional semantic ID for deduplication
     * @returns The created message
     */
    appendAssistantResponse(
        id: ConversationId,
        messageData: AssistantMessageData,
        status: 'succeeded' | 'failed' = 'succeeded',
        semanticId?: string
    ): Message {
        const state = this.getOrCreate(id);
        const now = Date.now();

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
            content: messageData.content,
            toolCall: messageData.toolCall,
            toolResult: messageData.toolResult,
            semanticId: semanticId ?? hashMessage('assistant', messageData.content).slice(0, 16),
        };

        state.messages.push(message);
        this.markDirty(state);
        state.metadata.updatedAt = now;
        state.status = 'completed';

        getMetrics()?.messagesTotal.inc({ role: 'assistant' });

        logger.debug({
            conversationId: id,
            messageId: message.id,
            contentLength: messageData.content.length,
            hasToolCall: !!messageData.toolCall,
            hasToolResult: !!messageData.toolResult,
        }, 'Appended assistant response');

        return message;
    }

    /**
     * Append tool calls as assistant messages.
     * Each tool call stored as separate message with JSON content.
     * Arguments are expected to already be normalized (via streaming-processor).
     *
     * NOTE: Currently unused. persistAssistantTurn() skips persistence when tool calls
     * are present, relying on the client returning the assistant message when responding with tool output.
     * (More robust as order of tool_calls & text may change)
     * Kept for potential future use if we change the persistence strategy.
     * (streaming tool processor should then return text & tool call blocks in order)
     */
    appendAssistantToolCalls(
        id: ConversationId,
        toolCalls: Array<{ name: string; arguments: string; call_id: string }>
    ): void {
        for (const tc of toolCalls) {
            const content = JSON.stringify({
                type: 'function_call',
                call_id: tc.call_id,
                name: tc.name,
                arguments: tc.arguments,
            });
            this.appendAssistantResponse(id, { content }, 'succeeded', tc.call_id);
        }
    }

    /**
     * Append a single user message (CLI mode - no deduplication needed)
     */
    appendUserMessage(id: ConversationId, content: string): Message {
        const state = this.getOrCreate(id);
        const now = Date.now();

        const parentId = state.messages.length > 0
            ? state.messages[state.messages.length - 1].id
            : undefined;

        const message: Message = {
            id: randomUUID(),
            conversationId: id,
            createdAt: now,
            role: 'user',
            parentId,
            status: 'succeeded',
            content,
            semanticId: hashMessage('user', content).slice(0, 16),
        };

        state.messages.push(message);
        this.markDirty(state);
        state.metadata.updatedAt = now;

        logger.debug({
            conversationId: id,
            messageId: message.id,
            contentLength: content.length,
        }, 'Appended user message');

        return message;
    }

    /**
     * Create a conversation from turns (for stateless /save commands).
     *
     * Generates a deterministic conversation ID from the title to allow
     * re-saving the same conversation without creating duplicates.
     *
     * @param turns - Turns to populate the conversation
     * @param title - Optional title (auto-generated if not provided)
     * @returns The created conversation ID and title
     */
    createFromTurns(
        turns: Turn[],
        title?: string
    ): { conversationId: ConversationId; title: string } {
        const effectiveTitle = title?.trim().substring(0, 100) || generateAutoTitle(turns);
        const conversationId = deterministicUUID(`save:${effectiveTitle}`);

        this.getOrCreate(conversationId);
        this.appendMessages(conversationId, turns);
        this.setTitle(conversationId, effectiveTitle);

        logger.info({ conversationId, title: effectiveTitle, turnCount: turns.length }, 'Created conversation from turns');

        return { conversationId, title: effectiveTitle };
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
            this.markDirty(state);
            state.metadata.updatedAt = Date.now();
        }
        logger.debug(`Set title for ${id}${getLogConfig().messageContent ? `: ${title}` : ''}`);
    }

    /**
     * Convert conversation to Lumo Turn[] format for API call
     */
    toTurns(id: ConversationId): Turn[] {
        const roleMap: Record<string, Role> = {
            user: Role.User,
            assistant: Role.Assistant,
            system: Role.System,
            tool_call: Role.ToolCall,
            tool_result: Role.ToolResult,
        };
        return this.getMessages(id).map(({role, content}) => ({
            role: roleMap[role] ?? Role.User,
            content,
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
     * Mark a conversation as dirty (needs sync)
     */
    markDirtyById(id: ConversationId): void {
        const state = this.conversations.get(id);
        if (state) {
            this.markDirty(state);
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
            maxSize: this.maxConversations,
        };
    }

    // Private methods

    /**
     * Mark a conversation as dirty and notify callback
     */
    private markDirty(state: ConversationState): void {
        state.dirty = true;
        this.onDirtyCallback?.();
    }

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
        while (this.conversations.size > this.maxConversations) {
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

/**
 * Generate an auto-title from turns.
 *
 * Unlike other auto-title generation (which uses Lumo to summarize),
 * this uses the first user message truncated to 50 chars.
 * Used for stateless /save where we don't have a Lumo-generated title.
 */
function generateAutoTitle(turns: Turn[]): string {
    const firstUserTurn = turns.find(t => t.role === 'user');
    if (firstUserTurn?.content) {
        const content = firstUserTurn.content.trim();
        return content.length > 50 ? content.slice(0, 47) + '...' : content;
    }
    // Fallback to timestamp if no user message
    const timestamp = new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
    return `Chat (${timestamp})`;
}

// Singleton instance
let storeInstance: ConversationStore | null = null;

/**
 * Get the global ConversationStore instance
 * Config is required on first call to initialize the store
 */
export function getConversationStore(config?: ConversationStoreConfig): ConversationStore {
    if (!storeInstance) {
        if (!config) {
            throw new Error('ConversationStore not initialized - config required on first call');
        }
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
