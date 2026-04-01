/**
 * MinimalStore - Lightweight in-memory store for single-session use
 *
 * Used when primary ConversationStore cannot be initialized:
 * - CLI mode: tracks one conversation per session
 * - Tests: provides mock store without IndexedDB overhead
 *
 * Only stores messages and converts them to turns for Lumo.
 * Many methods are no-ops since CLI doesn't need full store functionality.
 */

import { randomUUID } from 'crypto';
import { logger } from '../app/logger.js';
import { Role, ConversationStatus } from '@lumo/types.js';
import type { Turn, AssistantMessageData } from '../lumo-client/types.js';
import {
    findNewMessages,
    hashMessage,
} from './deduplication.js';
import type {
    ConversationId,
    ConversationState,
    Message,
    MessageId,
    MessageForStore,
    SpaceId,
} from './types.js';
import type { IConversationStore } from './store-interface.js';
import { getMetrics } from '../app/metrics.js';

/**
 * Lightweight in-memory conversation store
 */
export class MinimalStore implements IConversationStore {
    private conversations = new Map<ConversationId, ConversationState>();
    private defaultSpaceId: SpaceId;

    constructor() {
        this.defaultSpaceId = randomUUID();
        logger.debug({ spaceId: this.defaultSpaceId }, 'MinimalStore initialized');
    }

    getOrCreate(id: ConversationId): ConversationState {
        let state = this.conversations.get(id);

        if (!state) {
            state = this.createEmptyState(id);
            this.conversations.set(id, state);
            getMetrics()?.conversationsCreatedTotal.inc();
            logger.debug({ conversationId: id }, 'Created new conversation');
        }

        return state;
    }

    get(id: ConversationId): ConversationState | undefined {
        return this.conversations.get(id);
    }

    has(id: ConversationId): boolean {
        return this.conversations.has(id);
    }

    appendMessages(id: ConversationId, incoming: MessageForStore[]): Message[] {
        const state = this.getOrCreate(id);

        const newMessages = findNewMessages(incoming, state.messages);

        if (newMessages.length === 0) {
            return [];
        }

        const now = new Date().toISOString();
        const lastMessageId = state.messages.length > 0
            ? state.messages[state.messages.length - 1].id
            : undefined;

        const addedMessages: Message[] = [];
        let parentId = lastMessageId;

        for (const msg of newMessages) {
            const semanticId = msg.id ?? hashMessage(msg.role, msg.content ?? '').slice(0, 16);

            const message: Message = {
                id: randomUUID(),
                conversationId: id,
                createdAt: now,
                role: msg.role,
                parentId,
                status: 'succeeded',
                content: msg.content,
                semanticId,
            };

            state.messages.push(message);
            addedMessages.push(message);
            parentId = message.id;
        }

        state.metadata.updatedAt = new Date().toISOString();

        const metrics = getMetrics();
        if (metrics) {
            for (const msg of addedMessages) {
                metrics.messagesTotal.inc({ role: msg.role });
            }
        }

        return addedMessages;
    }

    appendAssistantResponse(
        id: ConversationId,
        messageData: AssistantMessageData,
        status: 'succeeded' | 'failed' = 'succeeded',
        semanticId?: string
    ): Message {
        const state = this.getOrCreate(id);
        const now = new Date();

        const parentId = state.messages.length > 0
            ? state.messages[state.messages.length - 1].id
            : undefined;

        const message: Message = {
            id: randomUUID(),
            conversationId: id,
            createdAt: now.toISOString(),
            role: Role.Assistant,
            parentId,
            status,
            content: messageData.content,
            blocks: messageData.blocks,
            semanticId: semanticId ?? hashMessage(Role.Assistant, messageData.content).slice(0, 16),
        };

        state.messages.push(message);
        state.metadata.updatedAt = now.toISOString();
        state.status = ConversationStatus.COMPLETED;

        getMetrics()?.messagesTotal.inc({ role: Role.Assistant });

        return message;
    }

    appendUserMessage(id: ConversationId, content: string): Message {
        const state = this.getOrCreate(id);
        const now = new Date();

        const parentId = state.messages.length > 0
            ? state.messages[state.messages.length - 1].id
            : undefined;

        const message: Message = {
            id: randomUUID(),
            conversationId: id,
            createdAt: now.toISOString(),
            role: Role.User,
            parentId,
            status: 'succeeded',
            content,
            semanticId: hashMessage(Role.User, content).slice(0, 16),
        };

        state.messages.push(message);
        state.metadata.updatedAt = now.toISOString();

        return message;
    }

    toTurns(id: ConversationId): Turn[] {
        return this.getMessages(id).map(({ role, content }) => ({
            role,
            content,
        }));
    }

    getMessages(id: ConversationId): Message[] {
        const state = this.conversations.get(id);
        return state?.messages ?? [];
    }

    // No-op methods (keep interface compatibility but not needed for CLI)

    setTitle(_id: ConversationId, _title: string): void {
        // No-op: CLI never reads title back
    }

    createFromTurns(
        _turns: Turn[],
        _title?: string
    ): { conversationId: ConversationId; title: string } {
        // No-op: requires sync which MinimalStore doesn't support
        return { conversationId: '', title: '' };
    }

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

    getMessage(_conversationId: ConversationId, _messageId: MessageId): Message | undefined {
        // No-op
        return undefined;
    }

    delete(_id: ConversationId): boolean {
        // No-op
        return false;
    }

    *entries(): IterableIterator<[ConversationId, ConversationState]> {
        // No-op: yield nothing
    }

    // Private methods

    private createEmptyState(id: ConversationId): ConversationState {
        const now = new Date().toISOString();
        return {
            metadata: {
                id,
                spaceId: this.defaultSpaceId,
                createdAt: now,
                updatedAt: now,
                starred: false,
            },
            title: 'New Conversation',
            status: ConversationStatus.COMPLETED,
            messages: [],
            dirty: false,
        };
    }
}
