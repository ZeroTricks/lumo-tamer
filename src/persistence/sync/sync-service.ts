/**
 * Sync Service for conversation persistence
 *
 * Handles:
 * - Space creation on first conversation (lazy initialization)
 * - Encrypting and syncing dirty conversations to the server
 * - Message encryption with proper AEAD
 */

import { randomUUID } from 'crypto';
import stableStringify from 'json-stable-stringify';
import { logger } from '../../app/logger.js';
import {
    generateKey,
    importKey,
    exportKey,
    wrapKey,
    encryptData,
    decryptData,
    deriveKey,
} from '../../proton-shims/aesGcm.js';
import {
    createLumoApi,
    type LumoApi,
    RoleInt,
    StatusInt,
} from './lumo-api-adapter.js';
import type { ProtonApi } from '../../lumo-client/types.js';
import { getConversationStore } from '../conversation-store.js';
import type { KeyManager } from '../encryption/key-manager.js';
import type { ConversationState, Message, SpaceId, RemoteId, MessageRole, MessageStatus } from '../types.js';

// HKDF parameters matching Proton's implementation
const SPACE_KEY_DERIVATION_SALT = Buffer.from('Xd6V94/+5BmLAfc67xIBZcjsBPimm9/j02kHPI7Vsuc=', 'base64');
const SPACE_DEK_CONTEXT = new TextEncoder().encode('dek.space.lumo');

/**
 * Space private data (encrypted)
 * Matches Lumo WebClient's ProjectSpace type
 */
interface SpacePrivate {
    isProject: true;
    projectName?: string;
    projectInstructions?: string;
    projectIcon?: string;
}

/**
 * Conversation private data (encrypted)
 */
interface ConversationPrivate {
    title: string;
}

/**
 * Message private data (encrypted)
 */
interface MessagePrivate {
    content?: string;
    context?: string;
    toolCall?: string;
    toolResult?: string;
}

/**
 * ID mapping for local to remote
 */
interface IdMapping {
    spaces: Map<SpaceId, RemoteId>;
    conversations: Map<string, RemoteId>;
    messages: Map<string, RemoteId>;
}

export interface SyncServiceConfig {
    protonApi: ProtonApi;
    keyManager: KeyManager;
    /** User ID for LumoApi authentication */
    uid: string;
    /** Space name to search/create (used if spaceId not set) */
    spaceName?: string;
    /** Space UUID to use directly (bypasses name-matching) */
    spaceId?: string;
    /** If true, sync all message types to server; if false, only user/assistant */
    includeSystemMessages?: boolean;
}

/**
 * Sync Service
 *
 * Manages server-side persistence for conversations.
 */
// Role mapping: our internal roles to API integer values
const RoleToInt: Record<MessageRole, number> = {
    user: RoleInt.User,
    assistant: RoleInt.Assistant,
    system: RoleInt.User,  // Treat system as user for storage
    tool_call: RoleInt.Assistant,
    tool_result: RoleInt.User,
};

// Status mapping: our internal status to API integer values
const StatusToInt: Record<MessageStatus, number | undefined> = {
    failed: StatusInt.Failed,
    completed: StatusInt.Succeeded,
    pending: undefined,
    streaming: undefined,
};

export class SyncService {
    private lumoApi: LumoApi;
    private keyManager: KeyManager;
    private spaceName?: string;
    private configuredSpaceId?: string;
    private includeSystemMessages: boolean;

    // Current space info
    private spaceId?: SpaceId;
    private spaceRemoteId?: RemoteId;
    private spaceKey?: CryptoKey;
    private dataEncryptionKey?: CryptoKey;

    // ID mappings
    private idMap: IdMapping = {
        spaces: new Map(),
        conversations: new Map(),
        messages: new Map(),
    };

    constructor(config: SyncServiceConfig) {
        if (!config.spaceId && !config.spaceName) {
            throw new Error('Either spaceId or spaceName must be provided');
        }
        this.lumoApi = createLumoApi(config.protonApi, config.uid);
        this.keyManager = config.keyManager;
        this.spaceName = config.spaceName;
        this.configuredSpaceId = config.spaceId;
        this.includeSystemMessages = config.includeSystemMessages ?? false;
    }

    /**
     * Ensure a space exists, creating one if needed
     * Called lazily on first sync
     *
     * Matching logic:
     * 1. If spaceId is configured, use that space directly (by UUID)
     * 2. Otherwise, find a space with matching spaceName (projectName)
     * 3. If no match found, create a new space with spaceName
     */
    async ensureSpace(): Promise<{ spaceId: SpaceId; remoteId: RemoteId }> {
        // Already have a space
        if (this.spaceId && this.spaceRemoteId && this.spaceKey) {
            return { spaceId: this.spaceId, remoteId: this.spaceRemoteId };
        }

        // Check if we already have a space on the server
        const searchCriteria = this.configuredSpaceId
            ? { spaceId: this.configuredSpaceId }
            : { spaceName: this.spaceName };
        logger.info(searchCriteria, 'Checking for existing space...');
        const listResult = await this.lumoApi.listSpaces();

        // Convert spaces record to array for iteration
        const existingSpaces = Object.values(listResult.spaces);

        // Log available spaces
        const spacesWithData = existingSpaces.filter(s => s.encrypted);
        logger.info({
            totalSpaces: existingSpaces.length,
            spacesWithEncryptedData: spacesWithData.length,
            spaceTags: existingSpaces.map(s => s.id),
        }, 'Available spaces');

        // If spaceId is configured, find that specific space by UUID
        if (this.configuredSpaceId) {
            const space = existingSpaces.find(s => s.id === this.configuredSpaceId);
            if (space) {
                try {
                    const spaceKey = await this.keyManager.getSpaceKey(space.id, space.wrappedSpaceKey);
                    const dataEncryptionKey = await this.deriveDataEncryptionKey(spaceKey);

                    this.spaceId = space.id;
                    this.spaceRemoteId = space.remoteId;
                    this.spaceKey = spaceKey;
                    this.dataEncryptionKey = dataEncryptionKey;
                    this.idMap.spaces.set(space.id, space.remoteId);

                    logger.info({
                        spaceId: space.id,
                        remoteId: space.remoteId,
                    }, 'Using configured space by UUID');

                    await this.loadExistingConversations();
                    return { spaceId: this.spaceId, remoteId: this.spaceRemoteId };
                } catch (error) {
                    logger.error({ spaceId: this.configuredSpaceId, error }, 'Failed to decrypt configured space');
                    throw new Error(`Cannot decrypt configured space ${this.configuredSpaceId}`);
                }
            } else {
                logger.error({ spaceId: this.configuredSpaceId }, 'Configured space not found');
                throw new Error(`Configured space ${this.configuredSpaceId} not found on server`);
            }
        }

        // First pass: look for a space with matching project name
        logger.info({ totalSpaces: existingSpaces.length, lookingFor: this.spaceName }, 'Starting first pass - looking for project name match');
        for (const space of existingSpaces) {
            if (!space.id) continue;

            try {
                const spaceKey = await this.keyManager.getSpaceKey(space.id, space.wrappedSpaceKey);
                const dataEncryptionKey = await this.deriveDataEncryptionKey(spaceKey);

                const encryptedData = typeof space.encrypted === 'string' ? space.encrypted : undefined;
                logger.debug({
                    spaceTag: space.id,
                    hasEncrypted: !!encryptedData,
                    encryptedLength: encryptedData?.length ?? 0,
                }, 'First pass: checking space');

                // Try to decrypt and check project name
                if (encryptedData) {
                    const spacePrivate = await this.decryptSpacePrivate(encryptedData, space.id, dataEncryptionKey);

                    logger.debug({
                        spaceTag: space.id,
                        projectName: spacePrivate?.projectName,
                        lookingFor: this.spaceName,
                        hasEncrypted: !!encryptedData,
                        decryptedOk: !!spacePrivate,
                    }, 'Checking space for project name match');

                    if (spacePrivate && spacePrivate.projectName === this.spaceName) {
                        this.spaceId = space.id;
                        this.spaceRemoteId = space.remoteId;
                        this.spaceKey = spaceKey;
                        this.dataEncryptionKey = dataEncryptionKey;
                        this.idMap.spaces.set(space.id, space.remoteId);

                        logger.info({
                            spaceId: space.id,
                            remoteId: space.remoteId,
                            projectName: spacePrivate.projectName,
                        }, 'Found existing space with matching project name');

                        await this.loadExistingConversations();
                        return { spaceId: this.spaceId, remoteId: this.spaceRemoteId };
                    }
                }
            } catch (error) {
                // Can't decrypt this space, try next
                logger.debug({ spaceTag: space.id, error }, 'Could not decrypt space');
                continue;
            }
        }

        // No matching space found, create a new one
        if (!this.spaceName) {
            // This shouldn't happen - constructor validates that spaceId or spaceName is set
            throw new Error('Cannot create space: no spaceName configured');
        }
        logger.info({ spaceName: this.spaceName }, 'Creating new space...');
        return await this.createSpace();
    }

    /**
     * Create a new space on the server
     */
    private async createSpace(): Promise<{ spaceId: SpaceId; remoteId: RemoteId }> {
        const localId = randomUUID();

        // Generate a new space key and get it cached in KeyManager
        // KeyManager.getSpaceKey without wrappedKey will generate a new key
        const spaceKey = await this.keyManager.getSpaceKey(localId);

        // Wrap the space key with the master key
        const wrappedSpaceKey = await this.keyManager.wrapSpaceKey(localId);

        // Derive the data encryption key for encrypting space metadata
        const dataEncryptionKey = await this.deriveDataEncryptionKey(spaceKey);

        // Encrypt space private data (project name, etc.)
        const spacePrivate: SpacePrivate = {
            isProject: true,
            projectName: this.spaceName,
        };
        const encryptedPrivate = await this.encryptSpacePrivate(spacePrivate, localId, dataEncryptionKey);

        const remoteId = await this.lumoApi.postSpace({
            SpaceKey: wrappedSpaceKey,
            SpaceTag: localId,
            Encrypted: encryptedPrivate,
        }, 'background');

        if (!remoteId) {
            throw new Error('Failed to create space - no remote ID returned');
        }

        // Cache everything locally
        this.spaceId = localId;
        this.spaceRemoteId = remoteId;
        this.spaceKey = spaceKey;
        this.dataEncryptionKey = dataEncryptionKey;
        this.idMap.spaces.set(localId, remoteId);

        logger.info({
            spaceId: localId,
            remoteId,
            projectName: this.spaceName,
        }, 'Created new space');

        return { spaceId: localId, remoteId };
    }

    /**
     * Derive data encryption key from space key using HKDF
     */
    private async deriveDataEncryptionKey(spaceKey: CryptoKey): Promise<CryptoKey> {
        const keyBytes = await exportKey(spaceKey);
        return deriveKey(keyBytes, new Uint8Array(SPACE_KEY_DERIVATION_SALT), SPACE_DEK_CONTEXT);
    }

    /**
     * Load existing conversations from server to populate idMap
     * Prevents 409 errors when conversations already exist from previous sessions
     */
    private async loadExistingConversations(): Promise<void> {
        if (!this.spaceRemoteId || !this.spaceId) return;

        try {
            const spaceData = await this.lumoApi.getSpace(this.spaceRemoteId);
            if (!spaceData) {
                logger.warn({ spaceRemoteId: this.spaceRemoteId }, 'Space not found on server');
                return;
            }

            for (const conv of spaceData.conversations ?? []) {
                // id is our local conversationId (was ConversationTag in old API)
                this.idMap.conversations.set(conv.id, conv.remoteId);

                // Load messages for this conversation
                try {
                    const convData = await this.lumoApi.getConversation(conv.remoteId, this.spaceId);
                    if (convData) {
                        for (const msg of convData.messages ?? []) {
                            this.idMap.messages.set(msg.id, msg.remoteId);
                        }
                    }
                } catch (error) {
                    logger.warn({ conversationId: conv.id, error }, 'Failed to load messages for conversation');
                }
            }

            logger.info({
                conversations: this.idMap.conversations.size,
                messages: this.idMap.messages.size,
            }, 'Loaded existing conversations from server');
        } catch (error) {
            logger.error({ error }, 'Failed to load existing conversations');
            // Don't throw - idMap will just be empty and we'll get 409 errors as before
        }
    }

    /**
     * Sync all dirty conversations to the server
     *
     * @returns Number of conversations synced
     */
    async sync(): Promise<number> {
        if (!this.keyManager.isInitialized()) {
            throw new Error('KeyManager not initialized - cannot sync without encryption keys');
        }

        // Ensure we have a space
        const { remoteId: spaceRemoteId } = await this.ensureSpace();

        const store = getConversationStore();
        const dirtyConversations = store.getDirty();

        if (dirtyConversations.length === 0) {
            logger.info('No dirty conversations to sync');
            return 0;
        }

        logger.info({ count: dirtyConversations.length }, 'Syncing dirty conversations');

        let syncedCount = 0;
        for (const conversation of dirtyConversations) {
            try {
                await this.syncConversation(conversation, spaceRemoteId);
                store.markSynced(conversation.metadata.id);
                syncedCount++;
            } catch (error) {
                logger.error({
                    conversationId: conversation.metadata.id,
                    error,
                }, 'Failed to sync conversation');
            }
        }

        logger.info({ syncedCount, total: dirtyConversations.length }, 'Sync complete');
        return syncedCount;
    }

    /**
     * Sync a single conversation to the server
     */
    private async syncConversation(
        conversation: ConversationState,
        spaceRemoteId: RemoteId
    ): Promise<void> {
        const conversationId = conversation.metadata.id;

        // Check if conversation already exists on server
        let conversationRemoteId = this.idMap.conversations.get(conversationId);

        if (!conversationRemoteId) {
            // Create new conversation
            // Note: Use this.spaceId (local space ID) for AD, not conversation.metadata.spaceId
            const encryptedPrivate = await this.encryptConversationPrivate({
                title: conversation.title,
            }, conversationId, this.spaceId!);

            const newRemoteId = await this.lumoApi.postConversation({
                SpaceID: spaceRemoteId,
                IsStarred: conversation.metadata.starred,
                ConversationTag: conversationId,
                Encrypted: encryptedPrivate,
            }, 'background');

            if (!newRemoteId) {
                throw new Error(`Failed to create conversation ${conversationId}`);
            }
            conversationRemoteId = newRemoteId;

            this.idMap.conversations.set(conversationId, conversationRemoteId);
            logger.debug({ conversationId, remoteId: conversationRemoteId }, 'Created conversation on server');
        } else {
            // Update existing conversation
            const encryptedPrivate = await this.encryptConversationPrivate({
                title: conversation.title,
            }, conversationId, this.spaceId!);

            await this.lumoApi.putConversation({
                ID: conversationRemoteId,
                SpaceID: spaceRemoteId,
                IsStarred: conversation.metadata.starred,
                ConversationTag: conversationId,
                Encrypted: encryptedPrivate,
            }, 'background');
            logger.debug({ conversationId, remoteId: conversationRemoteId }, 'Updated conversation on server');
        }

        // Sync messages (filter based on includeSystemMessages config)
        const messagesToSync = this.includeSystemMessages
            ? conversation.messages
            : conversation.messages.filter(m => m.role === 'user' || m.role === 'assistant');

        // Create a map for quick lookup of messages by ID (for parent chain walking)
        const messageMap = new Map(conversation.messages.map(m => [m.id, m]));

        for (const message of messagesToSync) {
            await this.syncMessage(message, conversationRemoteId, messageMap);
        }
    }

    /**
     * Sync a single message to the server
     */
    private async syncMessage(
        message: Message,
        conversationRemoteId: RemoteId,
        messageMap: Map<string, Message>
    ): Promise<void> {
        // Check if message already exists on server
        if (this.idMap.messages.has(message.id)) {
            // Messages are immutable, skip if already synced
            return;
        }

        // For non-user/assistant roles, prefix content with role type for clarity in Proton UI
        let contentToStore = message.content;
        if (message.role !== 'user' && message.role !== 'assistant') {
            contentToStore = `[${message.role}]\n${message.content}`;
        }

        // Find the parent message that was actually synced to the server
        // Walk up the parent chain until we find one that exists in idMap
        let effectiveParentId: string | undefined = message.parentId;
        let parentRemoteId: string | undefined;
        while (effectiveParentId) {
            parentRemoteId = this.idMap.messages.get(effectiveParentId);
            if (parentRemoteId) {
                break; // Found a synced parent
            }
            // Parent not synced, look for its parent (it was filtered out)
            const parentMessage = messageMap.get(effectiveParentId);
            if (parentMessage) {
                effectiveParentId = parentMessage.parentId;
            } else {
                // Parent not found at all, give up
                effectiveParentId = undefined;
            }
        }

        const encryptedPrivate = await this.encryptMessagePrivate({
            content: contentToStore,
            context: message.context,
            toolCall: message.toolCall,
            toolResult: message.toolResult,
        }, message, effectiveParentId);

        const remoteId = await this.lumoApi.postMessage({
            ConversationID: conversationRemoteId,
            Role: RoleToInt[message.role] ?? RoleInt.User,
            ParentID: parentRemoteId,
            ParentId: parentRemoteId,  // Duplicate for buggy backend (lowercase 'd')
            Status: StatusToInt[message.status],
            MessageTag: message.id,
            Encrypted: encryptedPrivate,
        }, 'background');

        if (!remoteId) {
            throw new Error(`Failed to create message ${message.id}`);
        }

        this.idMap.messages.set(message.id, remoteId);
        logger.debug({ messageId: message.id, remoteId }, 'Created message on server');
    }

    /**
     * Encrypt conversation private data
     *
     * AD format must match Lumo WebClient (json-stable-stringify with alphabetically sorted keys):
     * {"app":"lumo","id":"<conversationId>","spaceId":"<spaceId>","type":"conversation"}
     */
    private async encryptConversationPrivate(
        data: ConversationPrivate,
        conversationId: string,
        spaceId: string
    ): Promise<string> {
        if (!this.dataEncryptionKey) {
            throw new Error('Data encryption key not initialized');
        }

        const json = JSON.stringify(data);
        const plaintext = new TextEncoder().encode(json);
        // AD must be alphabetically sorted JSON (matching json-stable-stringify)
        const adString = stableStringify({
            app: 'lumo',
            type: 'conversation',
            id: conversationId,
            spaceId: spaceId,
        });
        logger.debug({ adString, conversationId, spaceId }, 'Encrypting conversation with AD');
        const ad = new TextEncoder().encode(adString);

        const encrypted = await encryptData(this.dataEncryptionKey, plaintext, ad);
        return encrypted.toBase64();
    }

    /**
     * Encrypt message private data
     *
     * AD format must match Lumo WebClient (json-stable-stringify with alphabetically sorted keys):
     * {"app":"lumo","conversationId":"...","id":"...","parentId":"...","role":"...","type":"message"}
     *
     * IMPORTANT: The role in AD must be the mapped role (user/assistant) that matches what
     * the WebClient will reconstruct from the Role integer field, NOT our internal role names.
     */
    private async encryptMessagePrivate(
        data: MessagePrivate,
        message: Message,
        effectiveParentId?: string
    ): Promise<string> {
        if (!this.dataEncryptionKey) {
            throw new Error('Data encryption key not initialized');
        }

        // Map our internal role to the role the WebClient will use for AD reconstruction
        // WebClient uses IntToRole[Role] where Role is what we send to the API
        const roleInt = RoleToInt[message.role as keyof typeof RoleToInt] ?? 1;
        const adRole = roleInt === 2 ? 'assistant' : 'user';

        const json = JSON.stringify(data);
        const plaintext = new TextEncoder().encode(json);
        // AD must be alphabetically sorted JSON (matching json-stable-stringify)
        // Use effectiveParentId (the parent that was actually synced) for AD
        // Use adRole (mapped to user/assistant) to match WebClient's AD reconstruction
        const adString = stableStringify({
            app: 'lumo',
            type: 'message',
            id: message.id,
            role: adRole,
            parentId: effectiveParentId,
            conversationId: message.conversationId,
        });
        logger.debug({ adString, messageId: message.id }, 'Encrypting message with AD');
        const ad = new TextEncoder().encode(adString);

        const encrypted = await encryptData(this.dataEncryptionKey, plaintext, ad);
        return encrypted.toBase64();
    }

    /**
     * Encrypt space private data
     *
     * AD format must match Lumo WebClient (json-stable-stringify with alphabetically sorted keys):
     * {"app":"lumo","id":"<spaceId>","type":"space"}
     */
    private async encryptSpacePrivate(
        data: SpacePrivate,
        spaceId: string,
        dataEncryptionKey: CryptoKey
    ): Promise<string> {
        const json = JSON.stringify(data);
        const plaintext = new TextEncoder().encode(json);
        // AD must be alphabetically sorted JSON (matching json-stable-stringify)
        const adString = stableStringify({
            app: 'lumo',
            type: 'space',
            id: spaceId,
        });
        logger.debug({ adString, spaceId }, 'Encrypting space with AD');
        const ad = new TextEncoder().encode(adString);

        const encrypted = await encryptData(dataEncryptionKey, plaintext, ad);
        return encrypted.toBase64();
    }

    /**
     * Decrypt space private data
     *
     * AD format must match Lumo WebClient (json-stable-stringify with alphabetically sorted keys):
     * {"app":"lumo","id":"<spaceId>","type":"space"}
     */
    private async decryptSpacePrivate(
        encryptedBase64: string,
        spaceId: string,
        dataEncryptionKey: CryptoKey
    ): Promise<SpacePrivate | null> {
        try {
            const encrypted = Buffer.from(encryptedBase64, 'base64');
            // AD must be alphabetically sorted JSON (matching json-stable-stringify)
            const adString = stableStringify({
                app: 'lumo',
                type: 'space',
                id: spaceId,
            });
            logger.debug({
                adString,
                spaceId,
                encryptedLength: encrypted.length,
            }, 'Attempting to decrypt space private data');
            const ad = new TextEncoder().encode(adString);

            const decrypted = await decryptData(dataEncryptionKey, new Uint8Array(encrypted), ad);
            const json = new TextDecoder().decode(decrypted);
            logger.debug({ spaceId, json }, 'Successfully decrypted space private data');
            return JSON.parse(json) as SpacePrivate;
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            logger.warn({ spaceId, error: errorMsg }, 'Failed to decrypt space private data');
            return null;
        }
    }

    /**
     * Get sync statistics
     */
    getStats(): {
        hasSpace: boolean;
        spaceId?: SpaceId;
        spaceRemoteId?: RemoteId;
        mappedConversations: number;
        mappedMessages: number;
    } {
        return {
            hasSpace: !!this.spaceId,
            spaceId: this.spaceId,
            spaceRemoteId: this.spaceRemoteId,
            mappedConversations: this.idMap.conversations.size,
            mappedMessages: this.idMap.messages.size,
        };
    }

    /**
     * Delete ALL spaces from the server
     * WARNING: This is destructive and cannot be undone!
     */
    async deleteAllSpaces(): Promise<number> {
        const listResult = await this.lumoApi.listSpaces();
        const spaces = Object.values(listResult.spaces);
        logger.warn({ count: spaces.length }, 'Deleting ALL spaces...');

        let deleted = 0;
        for (const space of spaces) {
            try {
                await this.lumoApi.deleteSpace(space.remoteId, 'background');
                deleted++;
                logger.info({ spaceId: space.id, remoteId: space.remoteId }, 'Deleted space');
            } catch (error) {
                logger.error({ spaceId: space.id, error }, 'Failed to delete space');
            }
        }

        // Clear local state
        this.spaceId = undefined;
        this.spaceRemoteId = undefined;
        this.spaceKey = undefined;
        this.dataEncryptionKey = undefined;
        this.idMap.spaces.clear();
        this.idMap.conversations.clear();
        this.idMap.messages.clear();

        logger.warn({ deleted, total: spaces.length }, 'Finished deleting spaces');
        return deleted;
    }
}

// Singleton instance
let syncServiceInstance: SyncService | null = null;

/**
 * Get the global SyncService instance
 */
export function getSyncService(config?: SyncServiceConfig): SyncService {
    if (!syncServiceInstance && config) {
        syncServiceInstance = new SyncService(config);
    }
    if (!syncServiceInstance) {
        throw new Error('SyncService not initialized - call with config first');
    }
    return syncServiceInstance;
}

/**
 * Reset the SyncService (for testing)
 */
export function resetSyncService(): void {
    syncServiceInstance = null;
}
