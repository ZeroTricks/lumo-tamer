/**
 * Persistence types for conversation storage
 * Compatible with Proton Lumo webclient format
 */

// Unique identifiers
export type ConversationId = string;   // UUID format
export type MessageId = string;        // UUID format
export type SpaceId = string;          // UUID format
export type RemoteId = string;         // Server-assigned ID

// Message roles matching Lumo format
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool_call' | 'tool_result';

// Message status (matches Proton's Status type)
export type MessageStatus = 'succeeded' | 'failed';

// Conversation status
export type ConversationStatus = 'generating' | 'completed';

/**
 * Conversation metadata
 * Public fields that can be stored unencrypted
 */
export interface ConversationMetadata {
    id: ConversationId;
    spaceId: SpaceId;
    createdAt: number;          // Unix timestamp (local tracking, server generates its own)
    updatedAt: number;          // Unix timestamp (local tracking, server generates its own)
    starred: boolean;
}

/**
 * Conversation private data (encrypted)
 */
export interface ConversationPrivate {
    title: string;
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
    role: MessageRole;
    parentId?: MessageId;       // For branching conversations
    status?: MessageStatus;     // Optional to match WebClient
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
export interface Message extends MessagePublic, MessagePrivate {}

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
    | { type: 'update_conversation'; conversationId: ConversationId; updates: Partial<ConversationMetadata & ConversationPrivate> }
    | { type: 'create_message'; message: Message }
    | { type: 'delete_conversation'; conversationId: ConversationId };

/**
 * Conversation store configuration (internal)
 */
export interface ConversationStoreConfig {
    maxConversationsInMemory: number;
}

/**
 * Message fingerprint for deduplication
 */
export interface MessageFingerprint {
    hash: string;               // SHA-256 of role + content
    role: MessageRole;
    index: number;              // Position in conversation
}

/**
 * ID mapping between local and remote
 */
export interface IdMapEntry {
    localId: string;
    remoteId: RemoteId;
    type: 'space' | 'conversation' | 'message';
}
