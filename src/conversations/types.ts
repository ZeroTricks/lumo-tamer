/**
 * Persistence types for conversation storage
 * Compatible with Proton Lumo webclient format
 */

// Import types from upstream @lumo
import type { ConversationId, MessageId, SpaceId, ProjectSpace, ConversationPriv, MessagePub, MessagePriv, ConversationPub, Role, ContentBlock } from '@lumo/types.js';
import { ConversationStatus } from '@lumo/types.js';
import type { RemoteId } from '@lumo/remote/types.ts';

// Re-export types for consumers
export type { ConversationId, MessageId, SpaceId, RemoteId, ProjectSpace, ConversationPriv, MessagePub, MessagePriv, ConversationPub, ContentBlock };

/**
 * Full conversation record
 */
export interface Conversation extends ConversationPub {
    title: string;              // Decrypted
    status: ConversationStatus;
}

/**
 * Full message record
 *
 * Extends upstream MessagePub (id, role, timestamps, etc.) and MessagePriv
 * (content, blocks, attachments, reasoning, etc.) with runtime-only fields.
 */
export interface Message extends MessagePub, MessagePriv {
    semanticId?: string;  // Runtime-only, for deduplication (call_id for tools, hash for regular). Not synced.
}

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
