/**
 * Persistence types for conversation storage
 * Compatible with Proton Lumo webclient format
 */

// Import types from upstream @lumo
import type { ConversationId, MessageId, SpaceId, ProjectSpace, ConversationPriv } from '@lumo/types.js';
import { ConversationStatus, Role, Status } from '@lumo/types.js';
import type { RemoteId } from '@lumo/remote/types.ts';

// Re-export types for consumers
export type { ConversationId, MessageId, SpaceId, RemoteId, ProjectSpace, ConversationPriv };

/**
 * Conversation metadata
 * Public fields that can be stored unencrypted
 * Upstream name: ConversationPub
 */
export interface ConversationMetadata {
    id: ConversationId;
    spaceId: SpaceId;
    createdAt: number;          // Unix timestamp (local tracking, server generates its own)
    updatedAt: number;          // Unix timestamp (local tracking, server generates its own)
    starred: boolean;
}

/**
 * Full conversation record
 */
export interface Conversation extends ConversationMetadata {
    title: string;              // Decrypted
    status: ConversationStatus;
}

/**
 * Message public fields
 *
 * WebClient also has: placeholder?: boolean (we don't use it)
 */
export interface MessagePublic {
    id: MessageId;
    conversationId: ConversationId;
    createdAt: number;          // Unix timestamp (local tracking, server generates its own)
    role: Role;
    parentId?: MessageId;       // For branching conversations
    status?: Status;            // Optional to match WebClient
}

/**
 * Message private data (encrypted)
 *
 * Content is optional to match Proton's model where tool_call/tool_result
 * messages may have no content (just toolCall/toolResult fields).
 * Currently we serialize everything to content, but this allows future
 * parity with WebClient's native tool storage.
 *
 * WebClient also has: attachments?: ShallowAttachment[], contextFiles?: AttachmentId[]
 * We don't handle attachments yet.
 *
 * Tool calls (native tools like web_search, weather):
 * - Legacy: Single tool call stored in `toolCall` (JSON string) and `toolResult` (JSON string),
 *   with the synthesized response in `content`. All in the same assistant message.
 * - v2: Multiple/interleaved tool calls use `blocks?: ContentBlock[]` where ContentBlock is
 *   TextBlock | ToolCallBlock | ToolResultBlock. We don't support this yet - would need to
 *   check if the API returns this format or if it requires a different endpoint.
 */
export interface MessagePrivate {
    content?: string;
    context?: string;
    toolCall?: string;          // JSON string of tool call (legacy, single tool)
    toolResult?: string;        // JSON string of tool result (legacy, single tool)
    // blocks?: ContentBlock[]; // v2: interleaved text/tool_call/tool_result blocks (not yet supported)
    semanticId?: string;        // For deduplication (call_id for tools, hash for regular). Not synced.
}

/**
 * Full message record
 */
export interface Message extends MessagePublic, MessagePrivate { }

/**
 * In-memory conversation state
 */
export interface ConversationState {
    metadata: ConversationMetadata;
    title: string;
    status: ConversationStatus;
    messages: Message[];
    // Sync tracking
    dirty: boolean;             // Needs sync to server
    remoteId?: RemoteId;        // Server-assigned ID (if synced)
    lastSyncedAt?: number;      // Last successful sync timestamp
}

/**
 * Pending change for sync queue
 */
export type PendingChange =
    | { type: 'create_conversation'; conversation: ConversationState }
    | { type: 'update_conversation'; conversationId: ConversationId; updates: Partial<ConversationMetadata & ConversationPriv> }
    | { type: 'create_message'; message: Message }
    | { type: 'delete_conversation'; conversationId: ConversationId };

/**
 * Conversation store configuration (internal)
 */
export interface ConversationStoreConfig {
    maxConversationsInMemory: number;
}

/**
 * ID mapping between local and remote
 */
export interface IdMapEntry {
    localId: string;
    remoteId: RemoteId;
    type: 'space' | 'conversation' | 'message';
}
