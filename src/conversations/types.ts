/**
 * Persistence types for conversation storage
 * Compatible with Proton Lumo webclient format
 */

// Import types from upstream @lumo
import type { ConversationId, MessageId, SpaceId, ProjectSpace, ConversationPriv, MessagePub, ConversationPub, Role, ContentBlock } from '@lumo/types.js';
import { ConversationStatus } from '@lumo/types.js';
import type { RemoteId } from '@lumo/remote/types.ts';

// Re-export types for consumers
export type { ConversationId, MessageId, SpaceId, RemoteId, ProjectSpace, ConversationPriv, MessagePub, ConversationPub, ContentBlock };

/**
 * Full conversation record
 */
export interface Conversation extends ConversationPub {
    title: string;              // Decrypted
    status: ConversationStatus;
}

/**
 * Message private data (encrypted)
 *
 * Content is optional to match Proton's model where tool_call/tool_result
 * messages may have no content (just toolCall/toolResult fields).
 *
 * WebClient also has: attachments?: ShallowAttachment[], contextFiles?: AttachmentId[]
 * We don't handle attachments yet.
 *
 * Tool calls (native tools like web_search, weather):
 * Use `blocks?: ContentBlock[]` for interleaved text/tool_call/tool_result blocks.
 * The upstream `getMessageBlocks()` helper reconstructs blocks from legacy
 * toolCall/toolResult fields if blocks is not present (for old synced data).
 */
export interface MessagePrivate {
    content?: string;
    context?: string;
    blocks?: ContentBlock[];    // Interleaved text/tool_call/tool_result blocks
    semanticId?: string;        // For deduplication (call_id for tools, hash for regular). Not synced.
}

/**
 * Full message record
 */
export interface Message extends MessagePub, MessagePrivate { }

/**
 * In-memory conversation state
 */
export interface ConversationState {
    metadata: ConversationPub;
    title: string;
    status: ConversationStatus;
    messages: Message[];
    // Sync tracking
    dirty: boolean;             // Needs sync to server
    remoteId?: RemoteId;        // Server-assigned ID (if synced)
    lastSyncedAt?: number;      // Last successful sync timestamp
}

/**
 * ID mapping between local and remote
 */
export interface IdMapEntry {
    localId: string;
    remoteId: RemoteId;
    type: 'space' | 'conversation' | 'message';
}
/**
 * Incoming message format from API
 */

export interface MessageForStore {
    role: Role;
    content?: string;
    id?: string; // Semantic ID for deduplication (call_id for tools)
}
