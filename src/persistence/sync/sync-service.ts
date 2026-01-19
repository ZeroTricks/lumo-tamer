/**
 * Sync Service for conversation persistence
 *
 * Handles:
 * - Space creation on first conversation (lazy initialization)
 * - Encrypting and syncing dirty conversations to the server
 * - Message encryption with proper AEAD
 */

import { randomUUID } from 'crypto';
import { logger } from '../../logger.js';
import {
    generateKey,
    importKey,
    exportKey,
    wrapKey,
    encryptData,
    deriveKey,
} from '../../proton-shims/aesGcm.js';
import { LumoPersistenceClient, RoleToInt, StatusToInt } from './server-client.js';
import { getConversationStore } from '../conversation-store.js';
import type { KeyManager } from '../encryption/key-manager.js';
import type { ConversationState, Message, SpaceId, RemoteId, MessageRole, MessageStatus } from '../types.js';

// HKDF parameters matching Proton's implementation
const SPACE_KEY_DERIVATION_SALT = Buffer.from('Xd6V94/+5BmLAfc67xIBZcjsBPimm9/j02kHPI7Vsuc=', 'base64');
const SPACE_DEK_CONTEXT = new TextEncoder().encode('dek.space.lumo');

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
    api: LumoPersistenceClient;
    keyManager: KeyManager;
    defaultSpaceName?: string;
}

/**
 * Sync Service
 *
 * Manages server-side persistence for conversations.
 */
export class SyncService {
    private api: LumoPersistenceClient;
    private keyManager: KeyManager;
    private defaultSpaceName: string;

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
        this.api = config.api;
        this.keyManager = config.keyManager;
        this.defaultSpaceName = config.defaultSpaceName ?? 'lumo-bridge';
    }

    /**
     * Ensure a space exists, creating one if needed
     * Called lazily on first sync
     */
    async ensureSpace(): Promise<{ spaceId: SpaceId; remoteId: RemoteId }> {
        // Already have a space
        if (this.spaceId && this.spaceRemoteId && this.spaceKey) {
            return { spaceId: this.spaceId, remoteId: this.spaceRemoteId };
        }

        // Check if we already have a lumo-bridge space on the server
        logger.info('Checking for existing lumo-bridge space...');
        const existingSpaces = await this.api.listSpaces();

        for (const space of existingSpaces) {
            // Check if this is our space by looking at the SpaceTag
            // SpaceTag contains the local ID we used when creating
            if (space.SpaceTag) {
                // Try to unwrap the space key to verify we can use this space
                try {
                    const spaceKey = await this.keyManager.getSpaceKey(space.SpaceTag, space.SpaceKey);
                    this.spaceId = space.SpaceTag;
                    this.spaceRemoteId = space.ID;
                    this.spaceKey = spaceKey;
                    this.dataEncryptionKey = await this.deriveDataEncryptionKey(spaceKey);
                    this.idMap.spaces.set(space.SpaceTag, space.ID);

                    logger.info({
                        spaceId: space.SpaceTag,
                        remoteId: space.ID,
                    }, 'Using existing space');

                    return { spaceId: this.spaceId, remoteId: this.spaceRemoteId };
                } catch {
                    // Can't unwrap this key, try next space
                    continue;
                }
            }
        }

        // No existing space found, create a new one
        logger.info('Creating new lumo-bridge space...');
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

        const remoteId = await this.api.createSpace({
            SpaceKey: wrappedSpaceKey,
            SpaceTag: localId,
        });

        // Cache everything locally
        this.spaceId = localId;
        this.spaceRemoteId = remoteId;
        this.spaceKey = spaceKey;
        this.dataEncryptionKey = await this.deriveDataEncryptionKey(spaceKey);
        this.idMap.spaces.set(localId, remoteId);

        logger.info({
            spaceId: localId,
            remoteId,
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
            const encryptedPrivate = await this.encryptConversationPrivate({
                title: conversation.title,
            }, conversationId);

            conversationRemoteId = await this.api.createConversation(spaceRemoteId, {
                IsStarred: conversation.metadata.starred,
                ConversationTag: conversationId,
                Encrypted: encryptedPrivate,
            });

            this.idMap.conversations.set(conversationId, conversationRemoteId);
            logger.debug({ conversationId, remoteId: conversationRemoteId }, 'Created conversation on server');
        } else {
            // Update existing conversation
            const encryptedPrivate = await this.encryptConversationPrivate({
                title: conversation.title,
            }, conversationId);

            await this.api.updateConversation({
                ID: conversationRemoteId,
                SpaceID: spaceRemoteId,
                IsStarred: conversation.metadata.starred,
                ConversationTag: conversationId,
                Encrypted: encryptedPrivate,
            });
            logger.debug({ conversationId, remoteId: conversationRemoteId }, 'Updated conversation on server');
        }

        // Sync messages
        for (const message of conversation.messages) {
            await this.syncMessage(message, conversationRemoteId);
        }
    }

    /**
     * Sync a single message to the server
     */
    private async syncMessage(
        message: Message,
        conversationRemoteId: RemoteId
    ): Promise<void> {
        // Check if message already exists on server
        if (this.idMap.messages.has(message.id)) {
            // Messages are immutable, skip if already synced
            return;
        }

        const encryptedPrivate = await this.encryptMessagePrivate({
            content: message.content,
            context: message.context,
            toolCall: message.toolCall,
            toolResult: message.toolResult,
        }, message.id);

        const parentRemoteId = message.parentId
            ? this.idMap.messages.get(message.parentId)
            : undefined;

        const remoteId = await this.api.createMessage(conversationRemoteId, {
            Role: RoleToInt[message.role as keyof typeof RoleToInt] ?? 1,
            ParentID: parentRemoteId,
            Status: StatusToInt[message.status as keyof typeof StatusToInt],
            MessageTag: message.id,
            Encrypted: encryptedPrivate,
        });

        this.idMap.messages.set(message.id, remoteId);
        logger.debug({ messageId: message.id, remoteId }, 'Created message on server');
    }

    /**
     * Encrypt conversation private data
     */
    private async encryptConversationPrivate(
        data: ConversationPrivate,
        conversationId: string
    ): Promise<string> {
        if (!this.dataEncryptionKey) {
            throw new Error('Data encryption key not initialized');
        }

        const json = JSON.stringify(data);
        const plaintext = new TextEncoder().encode(json);
        const ad = new TextEncoder().encode(`lumo.conversation.${conversationId}`);

        const encrypted = await encryptData(this.dataEncryptionKey, plaintext, ad);
        return encrypted.toBase64();
    }

    /**
     * Encrypt message private data
     */
    private async encryptMessagePrivate(
        data: MessagePrivate,
        messageId: string
    ): Promise<string> {
        if (!this.dataEncryptionKey) {
            throw new Error('Data encryption key not initialized');
        }

        const json = JSON.stringify(data);
        const plaintext = new TextEncoder().encode(json);
        const ad = new TextEncoder().encode(`lumo.message.${messageId}`);

        const encrypted = await encryptData(this.dataEncryptionKey, plaintext, ad);
        return encrypted.toBase64();
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
