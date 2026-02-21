/**
 * Sync Service for conversation persistence
 *
 * Orchestrates syncing conversations to the Lumo server.
 * Delegates to SpaceManager for space lifecycle and EncryptionCodec for encryption.
 */

import { logger } from '../../app/logger.js';
import {
    createLumoApi,
    type LumoApi,
    RoleInt,
    StatusInt,
} from './lumo-api.js';
import type { ProtonApi } from '../../lumo-client/types.js';
import { getConversationStore } from '../store.js';
import type { KeyManager } from '../encryption/key-manager.js';
import type { ConversationState, Message, SpaceId, RemoteId, MessageRole, MessageStatus, MessagePrivate } from '../types.js';
import { SpaceManager } from './space-manager.js';

// Role mapping: our internal roles to API integer values
const RoleToInt: Record<MessageRole, number> = {
    user: RoleInt.User,
    assistant: RoleInt.Assistant,
    system: RoleInt.User,
    tool_call: RoleInt.Assistant,
    tool_result: RoleInt.User,
};

// Status mapping: our internal status to API integer values
const StatusToInt: Record<MessageStatus, number> = {
    failed: StatusInt.Failed,
    succeeded: StatusInt.Succeeded,
};

export interface SyncServiceConfig {
    protonApi: ProtonApi;
    keyManager: KeyManager;
    uid: string;
    spaceName?: string;
    spaceId?: string;
    includeSystemMessages?: boolean;
}

/**
 * Find the synced parent message in the chain
 *
 * Walks up the parent chain until finding a message that was synced to the server.
 * This handles filtered messages (e.g., system messages) by finding their synced ancestors.
 */
function findSyncedParent(
    messageParentId: string | undefined,
    messageMap: Map<string, Message>,
    messageIdMap: Map<string, RemoteId>
): { effectiveParentId?: string; parentRemoteId?: RemoteId } {
    let effectiveParentId = messageParentId;
    while (effectiveParentId) {
        const parentRemoteId = messageIdMap.get(effectiveParentId);
        if (parentRemoteId) {
            return { effectiveParentId, parentRemoteId };
        }
        effectiveParentId = messageMap.get(effectiveParentId)?.parentId;
    }
    return {};
}

/**
 * Sync Service
 *
 * Manages server-side persistence for conversations.
 */
export class SyncService {
    private lumoApi: LumoApi;
    private keyManager: KeyManager;
    private spaceManager: SpaceManager;
    private includeSystemMessages: boolean;

    // Message ID mapping (local -> remote)
    private messageIdMap = new Map<string, RemoteId>();

    constructor(config: SyncServiceConfig) {
        if (!config.spaceId && !config.spaceName) {
            throw new Error('Either projectId or projectName must be provided in config');
        }
        this.lumoApi = createLumoApi(config.protonApi, config.uid);
        this.keyManager = config.keyManager;
        this.includeSystemMessages = config.includeSystemMessages ?? false;

        this.spaceManager = new SpaceManager({
            lumoApi: this.lumoApi,
            keyManager: config.keyManager,
            spaceName: config.spaceName,
            configuredSpaceId: config.spaceId,
        });
    }

    /**
     * Ensure a space exists, creating one if needed
     */
    async getOrCreateSpace(): Promise<{ spaceId: SpaceId; remoteId: RemoteId }> {
        return this.spaceManager.getOrCreateSpace();
    }

    /**
     * Ensure existing conversations are loaded from server
     */
    async ensureExistingConversationsLoaded(): Promise<void> {
        return this.spaceManager.ensureExistingConversationsLoaded();
    }

    /**
     * Sync all dirty conversations to the server
     */
    async sync(): Promise<number> {
        if (!this.keyManager.isInitialized()) {
            throw new Error('KeyManager not initialized - cannot sync without encryption keys');
        }

        const { remoteId: spaceRemoteId } = await this.getOrCreateSpace();

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
     * Sync a single conversation by ID
     */
    async syncById(conversationId: string): Promise<boolean> {
        if (!this.keyManager.isInitialized()) {
            throw new Error('KeyManager not initialized - cannot sync without encryption keys');
        }

        const store = getConversationStore();
        const conversation = store.get(conversationId);

        if (!conversation) {
            logger.warn({ conversationId }, 'Conversation not found for sync');
            return false;
        }

        if (!conversation.dirty) {
            logger.info({ conversationId }, 'Conversation already synced');
            return true;
        }

        const { remoteId: spaceRemoteId } = await this.getOrCreateSpace();

        // Mark as synced early to prevent auto-sync from picking it up concurrently
        store.markSynced(conversationId);

        logger.info({ conversationId }, 'Syncing single conversation');

        try {
            await this.syncConversation(conversation, spaceRemoteId);
            logger.info({ conversationId }, 'Conversation synced successfully');
            return true;
        } catch (error) {
            store.markDirtyById(conversationId);
            logger.error({ conversationId, error }, 'Failed to sync conversation');
            throw error;
        }
    }

    /**
     * Sync a single conversation to the server
     */
    private async syncConversation(
        conversation: ConversationState,
        spaceRemoteId: RemoteId
    ): Promise<void> {
        const conversationId = conversation.metadata.id;
        const spaceId = this.spaceManager.spaceId!;
        const codec = this.spaceManager.codec!;

        let conversationRemoteId = this.spaceManager.getConversationRemoteId(conversationId);

        if (!conversationRemoteId) {
            // Create new conversation
            const encryptedPrivate = await codec.encryptConversation(
                { title: conversation.title },
                conversationId,
                spaceId
            );

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
            this.spaceManager.setConversationRemoteId(conversationId, conversationRemoteId);
            logger.debug({ conversationId, remoteId: conversationRemoteId }, 'Created conversation on server');
        } else {
            // Update existing conversation
            const encryptedPrivate = await codec.encryptConversation(
                { title: conversation.title },
                conversationId,
                spaceId
            );

            await this.lumoApi.putConversation({
                ID: conversationRemoteId,
                SpaceID: spaceRemoteId,
                IsStarred: conversation.metadata.starred,
                ConversationTag: conversationId,
                Encrypted: encryptedPrivate,
            }, 'background');
            logger.debug({ conversationId, remoteId: conversationRemoteId }, 'Updated conversation on server');
        }

        // Sync messages
        const messagesToSync = this.includeSystemMessages
            ? conversation.messages
            : conversation.messages.filter(m => m.role === 'user' || m.role === 'assistant');

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
        // Skip if already synced (messages are immutable)
        if (this.messageIdMap.has(message.id)) {
            return;
        }

        const codec = this.spaceManager.codec!;

        // Prefix non-user/assistant content with role for clarity in Proton UI
        let contentToStore = message.content;
        if (message.role !== 'user' && message.role !== 'assistant') {
            contentToStore = `[${message.role}]\n${message.content}`;
        }

        // Find the synced parent (walk up chain if parent was filtered)
        const { effectiveParentId, parentRemoteId } = findSyncedParent(
            message.parentId,
            messageMap,
            this.messageIdMap
        );

        const messagePrivate: MessagePrivate = {
            content: contentToStore,
            context: message.context,
            toolCall: message.toolCall,
            toolResult: message.toolResult,
        };

        const encryptedPrivate = await codec.encryptMessage(messagePrivate, message, effectiveParentId);

        const remoteId = await this.lumoApi.postMessage({
            ConversationID: conversationRemoteId,
            Role: RoleToInt[message.role] ?? RoleInt.User,
            ParentID: parentRemoteId,
            ParentId: parentRemoteId,  // Duplicate for buggy backend
            Status: StatusToInt[message.status ?? 'succeeded'],
            MessageTag: message.id,
            Encrypted: encryptedPrivate,
        }, 'background');

        if (!remoteId) {
            throw new Error(`Failed to create message ${message.id}`);
        }

        this.messageIdMap.set(message.id, remoteId);
        logger.debug({ messageId: message.id, remoteId }, 'Created message on server');
    }

    /**
     * Load a single conversation from the server by local ID
     */
    async loadExistingConversation(localId: string): Promise<string | undefined> {
        if (!this.keyManager.isInitialized()) {
            throw new Error('KeyManager not initialized - cannot load without encryption keys');
        }

        await this.getOrCreateSpace();

        const spaceId = this.spaceManager.spaceId;
        const codec = this.spaceManager.codec;
        if (!spaceId || !codec) {
            throw new Error('Space not initialized - cannot decrypt conversation');
        }

        await this.ensureExistingConversationsLoaded();

        const remoteId = this.spaceManager.getConversationRemoteId(localId);
        if (!remoteId) {
            logger.warn({ localId }, 'Conversation not found in project');
            return undefined;
        }

        try {
            const convData = await this.lumoApi.getConversation(remoteId, spaceId);
            if (!convData?.conversation) {
                logger.warn({ localId, remoteId }, 'Conversation not found on server');
                return undefined;
            }

            const conv = convData.conversation;
            if ('deleted' in conv && conv.deleted) {
                logger.warn({ localId }, 'Conversation is deleted');
                return undefined;
            }

            // Decrypt title
            let title = 'Untitled';
            if (conv.encrypted && typeof conv.encrypted === 'string') {
                const decryptedPrivate = await codec.decryptConversation(conv.encrypted, localId, spaceId);
                if (decryptedPrivate?.title) {
                    title = decryptedPrivate.title;
                }
            }

            // Create/update in store
            const store = getConversationStore();
            const state = store.getOrCreate(localId);
            state.title = title;
            state.metadata.starred = conv.starred ?? false;
            state.metadata.createdAt = new Date(conv.createdAt).getTime();
            state.metadata.spaceId = spaceId;
            state.remoteId = remoteId;
            state.dirty = false;
            state.messages = [];

            // Load messages
            for (const msg of convData.messages ?? []) {
                this.messageIdMap.set(msg.id, msg.remoteId);

                const fullMsg = await this.lumoApi.getMessage(
                    msg.remoteId,
                    localId,
                    msg.parentId,
                    remoteId
                );

                let messagePrivate: MessagePrivate | null = null;
                if (fullMsg?.encrypted && typeof fullMsg.encrypted === 'string') {
                    messagePrivate = await codec.decryptMessage(
                        fullMsg.encrypted,
                        msg.id,
                        localId,
                        msg.role,
                        msg.parentId
                    );
                }

                state.messages.push({
                    id: msg.id,
                    conversationId: localId,
                    createdAt: new Date(msg.createdAt).getTime(),
                    role: msg.role as MessageRole,
                    parentId: msg.parentId,
                    status: msg.status as MessageStatus | undefined,
                    content: messagePrivate?.content,
                    context: messagePrivate?.context,
                    toolCall: messagePrivate?.toolCall,
                    toolResult: messagePrivate?.toolResult,
                });
            }

            store.markSynced(localId);

            logger.info({
                localId,
                remoteId,
                title,
                messageCount: state.messages.length,
            }, 'Loaded conversation from server');

            return localId;
        } catch (error) {
            logger.error({ localId, error }, 'Failed to load conversation');
            throw error;
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
            hasSpace: !!this.spaceManager.spaceId,
            spaceId: this.spaceManager.spaceId,
            spaceRemoteId: this.spaceManager.spaceRemoteId,
            mappedConversations: 0, // SpaceManager doesn't expose this count
            mappedMessages: this.messageIdMap.size,
        };
    }

    /**
     * Delete ALL spaces from the server
     */
    async deleteAllSpaces(): Promise<number> {
        const deleted = await this.spaceManager.deleteAllSpaces();
        this.messageIdMap.clear();
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
