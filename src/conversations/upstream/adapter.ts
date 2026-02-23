/**
 * Upstream Conversation Store Adapter
 *
 * Implements the existing ConversationStore interface using upstream Redux + IndexedDB.
 * This allows replacing the in-memory store with persistent storage while maintaining
 * backwards compatibility with existing consumers.
 *
 * Architecture:
 * - Redux store holds in-memory state (conversations, messages)
 * - IndexedDB provides local persistence (via indexeddbshim -> SQLite)
 * - Sagas handle async operations (sync to server, load from IDB)
 *
 * Type mapping:
 * - lumo-tamer's Message -> upstream's Message (similar structure, different createdAt type)
 * - lumo-tamer's ConversationState -> upstream's Conversation + messages
 */

import { randomUUID } from 'crypto';
import type { Store } from '@reduxjs/toolkit';
import type { SagaMiddleware } from 'redux-saga';

import { logger } from '../../app/logger.js';
import { deterministicUUID } from '../../app/id-generator.js';
import type { Turn, AssistantMessageData } from '../../lumo-client/types.js';
import {
    findNewMessages,
    hashMessage,
    isValidContinuation,
    type IncomingMessage,
} from '../deduplication.js';
import type {
    ConversationId,
    ConversationState,
    Message,
    MessageId,
    MessageRole,
    ConversationStoreConfig,
    SpaceId,
} from '../types.js';
import { getMetrics } from '../../app/metrics.js';

// Upstream imports
import type { LumoState, LumoStore, LumoSagaContext } from '../../proton-upstream/redux/store.js';
import {
    selectConversationById,
    selectMessagesByConversationId,
} from '../../proton-upstream/redux/selectors.js';
import {
    addConversation,
    changeConversationTitle,
    updateConversationStatus,
    deleteConversation as deleteConversationAction,
} from '../../proton-upstream/redux/slices/core/conversations.js';
import {
    addMessage as addUpstreamMessage,
    appendChunk,
    finishMessage,
    pushMessageRequest,
} from '../../proton-upstream/redux/slices/core/messages.js';
import type {
    Conversation as UpstreamConversation,
    Message as UpstreamMessage,
    ConversationStatus as UpstreamConversationStatus,
} from '../../proton-upstream/types.js';
import { ConversationStatus, Role } from '../../proton-upstream/types.js';

/**
 * Convert lumo-tamer MessageRole to upstream Role
 * TODO: can we replace MessageRole with Role in consumers, we we don't need this mapper
 */
function toUpstreamRole(role: MessageRole): Role {
    switch (role) {
        case 'user':
            return Role.User;
        case 'assistant':
            return Role.Assistant;
        case 'system':
            return Role.User; // System messages stored as user messages
        case 'tool_call':
            return Role.Assistant;
        case 'tool_result':
            return Role.User;
        default:
            return Role.User;
    }
}

/**
 * Convert upstream Role to lumo-tamer MessageRole
 * TODO: can we replace MessageRole with Role in consumers, we we don't need this mapper
 */
function fromUpstreamRole(role: Role): MessageRole {
    switch (role) {
        case Role.User:
            return 'user';
        case Role.Assistant:
            return 'assistant';
        default:
            return 'user';
    }
}

/**
 * Convert upstream Message to lumo-tamer Message
 *
 * @param semanticIdMap - Optional map of messageId -> semanticId for deduplication.
 *   If not provided or missing entry, falls back to hash of role+content.
 */
function fromUpstreamMessage(
    msg: UpstreamMessage,
    conversationId: ConversationId,
    semanticIdMap?: Map<string, string>
): Message {
    // Use cached semanticId if available, otherwise compute from content
    const semanticId = semanticIdMap?.get(msg.id)
        ?? hashMessage(fromUpstreamRole(msg.role), msg.content ?? '').slice(0, 16);

    return {
        id: msg.id,
        conversationId,
        createdAt: new Date(msg.createdAt).getTime(),
        role: fromUpstreamRole(msg.role),
        parentId: msg.parentId,
        status: msg.status,
        content: msg.content,
        context: msg.context,
        toolCall: msg.toolCall,
        toolResult: msg.toolResult,
        semanticId,
    };
}

/**
 * Convert lumo-tamer ConversationState from upstream Conversation + messages
 *
 * @param semanticIdMap - Optional map of messageId -> semanticId for deduplication
 */
function toConversationState(
    conv: UpstreamConversation,
    messages: UpstreamMessage[],
    semanticIdMap?: Map<string, string>
): ConversationState {
    return {
        metadata: {
            id: conv.id,
            spaceId: conv.spaceId,
            createdAt: new Date(conv.createdAt).getTime(),
            updatedAt: new Date(conv.updatedAt).getTime(),
            starred: conv.starred ?? false,
        },
        title: conv.title,
        status: conv.status === ConversationStatus.GENERATING ? 'generating' : 'completed',
        messages: messages.map(m => fromUpstreamMessage(m, conv.id, semanticIdMap)),
        dirty: false, // Upstream uses IDB dirty flag, not in-memory
    };
}

/**
 * Upstream-backed ConversationStore
 *
 * Implements the same interface as the in-memory ConversationStore but uses
 * Redux + IndexedDB for persistence.
 */
export class UpstreamConversationStore {
    private store: LumoStore;
    private spaceId: SpaceId;
    private maxConversations: number;
    private onDirtyCallback?: () => void;

    // LRU tracking (for eviction)
    private accessOrder: ConversationId[] = [];

    /**
     * Map of messageId (UUID) -> semanticId for deduplication.
     *
     * SemanticIds are used to deduplicate messages across requests:
     * - For tool messages: semanticId = call_id (provided by client)
     * - For regular messages: semanticId = hash(role + content)
     *
     * This map is needed because:
     * - Upstream Redux messages don't store semanticId (not in WebClient schema)
     * - Tool message call_ids can't be recovered from content
     * - Regular messages could be recomputed, but map is simpler and consistent
     *
     * The map is in-memory only (not persisted). After restart:
     * - Fresh requests provide fresh call_ids for tool messages
     * - Regular message hashes can be recomputed from content
     */
    private semanticIdMap: Map<string, string> = new Map();

    constructor(
        store: LumoStore,
        spaceId: SpaceId,
        config: ConversationStoreConfig
    ) {
        this.store = store;
        this.spaceId = spaceId;
        this.maxConversations = config.maxConversationsInMemory;
        logger.info({ spaceId }, 'UpstreamConversationStore initialized');
    }

    /**
     * Set callback to be called when a conversation becomes dirty
     */
    setOnDirtyCallback(callback: () => void): void {
        this.onDirtyCallback = callback;
    }

    /**
     * Get or create a conversation by ID
     */
    getOrCreate(id: ConversationId): ConversationState {
        const state = this.store.getState();
        let conv = selectConversationById(id)(state);

        if (!conv) {
            // Create new conversation
            const now = new Date().toISOString();
            const newConv: UpstreamConversation = {
                id,
                spaceId: this.spaceId,
                createdAt: now,
                updatedAt: now,
                title: 'New Conversation',
                status: ConversationStatus.COMPLETED,
            };

            this.store.dispatch(addConversation(newConv));
            conv = newConv;

            getMetrics()?.conversationsCreatedTotal.inc();
            logger.debug({ conversationId: id }, 'Created new conversation');
        }

        this.touchLRU(id);

        // Get messages for this conversation
        const messages = Object.values(
            selectMessagesByConversationId(id)(this.store.getState())
        );

        return toConversationState(conv, messages, this.semanticIdMap);
    }

    /**
     * Get a conversation by ID (returns undefined if not found)
     */
    get(id: ConversationId): ConversationState | undefined {
        const state = this.store.getState();
        const conv = selectConversationById(id)(state);

        if (!conv) {
            return undefined;
        }

        this.touchLRU(id);

        const messages = Object.values(
            selectMessagesByConversationId(id)(state)
        );

        return toConversationState(conv, messages, this.semanticIdMap);
    }

    /**
     * Check if a conversation exists
     */
    has(id: ConversationId): boolean {
        const state = this.store.getState();
        return selectConversationById(id)(state) !== undefined;
    }

    /**
     * Append messages from API request (with deduplication)
     */
    appendMessages(
        id: ConversationId,
        incoming: IncomingMessage[]
    ): Message[] {
        const convState = this.getOrCreate(id);

        // Validate continuation
        const validation = isValidContinuation(incoming, convState.messages);
        if (!validation.valid) {
            getMetrics()?.invalidContinuationsTotal.inc();
            logger.warn({
                conversationId: id,
                reason: validation.reason,
                incomingCount: incoming.length,
                storedCount: convState.messages.length,
                ...validation.debugInfo,
            }, 'Invalid conversation continuation');
        }

        // Find new messages
        const newMessages = findNewMessages(incoming, convState.messages);

        if (newMessages.length === 0) {
            logger.debug({ conversationId: id }, 'No new messages to append');
            return [];
        }

        // Convert to Message format and dispatch to Redux
        const now = new Date();
        const lastMessage = convState.messages[convState.messages.length - 1];
        let parentId = lastMessage?.id;

        const addedMessages: Message[] = [];

        for (const msg of newMessages) {
            const messageId = randomUUID();
            const semanticId = msg.id ?? hashMessage(msg.role, msg.content ?? '').slice(0, 16);

            // Store semanticId in map for later retrieval
            this.semanticIdMap.set(messageId, semanticId);

            // Dispatch to Redux
            this.store.dispatch(addUpstreamMessage({
                id: messageId,
                conversationId: id,
                createdAt: now.toISOString(),
                role: toUpstreamRole(msg.role as MessageRole),
                parentId,
                status: 'succeeded',
            }));

            // If there's content, finish the message with it
            if (msg.content) {
                this.store.dispatch(finishMessage({
                    messageId,
                    conversationId: id,
                    spaceId: this.spaceId,
                    content: msg.content,
                    status: 'succeeded',
                    role: toUpstreamRole(msg.role as MessageRole),
                }));
            }

            // Request push to server
            this.store.dispatch(pushMessageRequest({ id: messageId }));

            const message: Message = {
                id: messageId,
                conversationId: id,
                createdAt: now.getTime(),
                role: msg.role as MessageRole,
                parentId,
                status: 'succeeded',
                content: msg.content,
                semanticId,
            };

            addedMessages.push(message);
            parentId = messageId;
        }

        this.notifyDirty();

        // Track metrics
        const metrics = getMetrics();
        if (metrics) {
            for (const msg of addedMessages) {
                metrics.messagesTotal.inc({ role: msg.role });
            }
        }

        logger.debug({
            conversationId: id,
            addedCount: addedMessages.length,
            totalCount: convState.messages.length + addedMessages.length,
        }, 'Appended messages');

        return addedMessages;
    }

    /**
     * Append an assistant response to a conversation
     */
    appendAssistantResponse(
        id: ConversationId,
        messageData: AssistantMessageData,
        status: 'succeeded' | 'failed' = 'succeeded',
        semanticId?: string
    ): Message {
        const convState = this.getOrCreate(id);
        const now = new Date();
        const messageId = randomUUID();
        const effectiveSemanticId = semanticId ?? hashMessage('assistant', messageData.content).slice(0, 16);

        // Store semanticId in map for later retrieval
        this.semanticIdMap.set(messageId, effectiveSemanticId);

        const lastMessage = convState.messages[convState.messages.length - 1];
        const parentId = lastMessage?.id;

        // Dispatch to Redux
        this.store.dispatch(addUpstreamMessage({
            id: messageId,
            conversationId: id,
            createdAt: now.toISOString(),
            role: Role.Assistant,
            parentId,
            status,
        }));

        this.store.dispatch(finishMessage({
            messageId,
            conversationId: id,
            spaceId: this.spaceId,
            content: messageData.content,
            status,
            role: Role.Assistant,
        }));

        // Request push to server
        this.store.dispatch(pushMessageRequest({ id: messageId }));

        this.notifyDirty();

        // Update conversation status
        this.store.dispatch(updateConversationStatus({
            id,
            status: ConversationStatus.COMPLETED,
        }));

        const message: Message = {
            id: messageId,
            conversationId: id,
            createdAt: now.getTime(),
            role: 'assistant',
            parentId,
            status,
            content: messageData.content,
            toolCall: messageData.toolCall,
            toolResult: messageData.toolResult,
            semanticId: effectiveSemanticId,
        };

        getMetrics()?.messagesTotal.inc({ role: 'assistant' });

        logger.debug({
            conversationId: id,
            messageId,
            contentLength: messageData.content.length,
            hasToolCall: !!messageData.toolCall,
            hasToolResult: !!messageData.toolResult,
        }, 'Appended assistant response');

        return message;
    }

    /**
     * Append tool calls as assistant messages (currently unused)
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
     * Append a single user message (CLI mode)
     */
    appendUserMessage(id: ConversationId, content: string): Message {
        const convState = this.getOrCreate(id);
        const now = new Date();
        const messageId = randomUUID();
        const semanticId = hashMessage('user', content).slice(0, 16);

        // Store semanticId in map for later retrieval
        this.semanticIdMap.set(messageId, semanticId);

        const lastMessage = convState.messages[convState.messages.length - 1];
        const parentId = lastMessage?.id;

        // Dispatch to Redux
        this.store.dispatch(addUpstreamMessage({
            id: messageId,
            conversationId: id,
            createdAt: now.toISOString(),
            role: Role.User,
            parentId,
            status: 'succeeded',
        }));

        this.store.dispatch(finishMessage({
            messageId,
            conversationId: id,
            spaceId: this.spaceId,
            content,
            status: 'succeeded',
            role: Role.User,
        }));

        // Request push to server
        this.store.dispatch(pushMessageRequest({ id: messageId }));

        this.notifyDirty();

        const message: Message = {
            id: messageId,
            conversationId: id,
            createdAt: now.getTime(),
            role: 'user',
            parentId,
            status: 'succeeded',
            content,
            semanticId,
        };

        logger.debug({
            conversationId: id,
            messageId,
            contentLength: content.length,
        }, 'Appended user message');

        return message;
    }

    /**
     * Create a conversation from turns
     */
    createFromTurns(
        turns: Turn[],
        title?: string
    ): { conversationId: ConversationId; title: string } {
        const effectiveTitle = title?.trim().substring(0, 100) || this.generateAutoTitle(turns);
        const conversationId = deterministicUUID(`save:${effectiveTitle}`);

        this.getOrCreate(conversationId);
        this.appendMessages(conversationId, turns);
        this.setTitle(conversationId, effectiveTitle);

        logger.info({ conversationId, title: effectiveTitle, turnCount: turns.length }, 'Created conversation from turns');

        return { conversationId, title: effectiveTitle };
    }

    /**
     * Mark conversation as generating
     */
    setGenerating(id: ConversationId): void {
        if (this.has(id)) {
            this.store.dispatch(updateConversationStatus({
                id,
                status: ConversationStatus.GENERATING,
            }));
        }
    }

    /**
     * Update conversation title
     */
    setTitle(id: ConversationId, title: string): void {
        if (this.has(id)) {
            this.store.dispatch(changeConversationTitle({
                id,
                spaceId: this.spaceId,
                title,
                persist: true,
            }));
            this.notifyDirty();
        }
        logger.debug({ conversationId: id }, 'Set title');
    }

    /**
     * Convert conversation to Lumo Turn[] format
     */
    toTurns(id: ConversationId): Turn[] {
        return this.getMessages(id).map(({ role, content }) => ({ role, content }));
    }

    /**
     * Get all messages in a conversation
     */
    getMessages(id: ConversationId): Message[] {
        const state = this.store.getState();
        const messages = selectMessagesByConversationId(id)(state);
        return Object.values(messages)
            .map(m => fromUpstreamMessage(m, id))
            .sort((a, b) => a.createdAt - b.createdAt);
    }

    /**
     * Get message by ID
     */
    getMessage(conversationId: ConversationId, messageId: MessageId): Message | undefined {
        const state = this.store.getState();
        const msg = state.messages[messageId];
        if (msg && msg.conversationId === conversationId) {
            return fromUpstreamMessage(msg, conversationId);
        }
        return undefined;
    }

    /**
     * Delete a conversation
     */
    delete(id: ConversationId): boolean {
        if (this.has(id)) {
            this.store.dispatch(deleteConversationAction(id));
            this.accessOrder = this.accessOrder.filter(cid => cid !== id);
            logger.debug({ conversationId: id }, 'Deleted conversation');
            return true;
        }
        return false;
    }

    /**
     * Get all conversations (for iteration)
     */
    *entries(): IterableIterator<[ConversationId, ConversationState]> {
        const state = this.store.getState();
        for (const [id, conv] of Object.entries(state.conversations)) {
            const messages = Object.values(selectMessagesByConversationId(id)(state));
            yield [id, toConversationState(conv, messages)];
        }
    }

    /**
     * Get all dirty conversations
     *
     * Note: Upstream uses IDB dirty flag, not in-memory. This returns empty
     * since sagas handle sync automatically.
     */
    getDirty(): ConversationState[] {
        // Upstream sagas handle dirty tracking via IDB
        // Return empty array since we don't track dirty in-memory
        return [];
    }

    /**
     * Mark a conversation as synced (no-op for upstream)
     */
    markSynced(_id: ConversationId): void {
        // Upstream sagas handle sync marking via IDB
    }

    /**
     * Mark a conversation as dirty
     */
    markDirtyById(_id: ConversationId): void {
        // Upstream sagas handle dirty tracking via IDB
        this.notifyDirty();
    }

    /**
     * Get store statistics
     */
    getStats(): {
        total: number;
        dirty: number;
        maxSize: number;
    } {
        const state = this.store.getState();
        return {
            total: Object.keys(state.conversations).length,
            dirty: 0, // Upstream uses IDB dirty flag
            maxSize: this.maxConversations,
        };
    }

    // Private methods

    private notifyDirty(): void {
        this.onDirtyCallback?.();
    }

    private touchLRU(id: ConversationId): void {
        const index = this.accessOrder.indexOf(id);
        if (index !== -1) {
            this.accessOrder.splice(index, 1);
        }
        this.accessOrder.push(id);
    }

    private generateAutoTitle(turns: Turn[]): string {
        const firstUserTurn = turns.find(t => t.role === 'user');
        if (firstUserTurn?.content) {
            const content = firstUserTurn.content.trim();
            return content.length > 50 ? content.slice(0, 47) + '...' : content;
        }
        const timestamp = new Date().toLocaleString('en-US', {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
        });
        return `Chat (${timestamp})`;
    }
}
