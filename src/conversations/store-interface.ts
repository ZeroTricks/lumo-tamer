/**
 * Common interface for conversation stores
 *
 * Implemented by:
 * - ConversationStore (Redux + IndexedDB) - primary, persistent
 * - MinimalStore (in-memory) - fallback for CLI/tests
 */

import type { Turn, AssistantMessageData } from '../lumo-client/types.js';
import type {
    ConversationId,
    ConversationState,
    Message,
    MessageId,
    MessageForStore,
} from './types.js';

export interface IConversationStore {
    // Core CRUD
    get(id: ConversationId): ConversationState | undefined;
    getOrCreate(id: ConversationId): ConversationState;
    has(id: ConversationId): boolean;
    delete(id: ConversationId): boolean;
    entries(): IterableIterator<[ConversationId, ConversationState]>;

    // Message operations
    appendMessages(id: ConversationId, incoming: MessageForStore[], deduplicate?: boolean): Message[];
    appendAssistantResponse(
        id: ConversationId,
        messageData: AssistantMessageData,
        status?: 'succeeded' | 'failed',
        semanticId?: string
    ): Message;
    appendUserMessage(id: ConversationId, content: string): Message;
    appendAssistantToolCalls(
        id: ConversationId,
        toolCalls: Array<{ name: string; arguments: string; call_id: string }>
    ): void;
    getMessages(id: ConversationId): Message[];
    getMessage(conversationId: ConversationId, messageId: MessageId): Message | undefined;

    // Conversation metadata
    setTitle(id: ConversationId, title: string): void;
    toTurns(id: ConversationId): Turn[];
    createFromTurns(turns: Turn[], title?: string): { conversationId: ConversationId; title: string };
}
