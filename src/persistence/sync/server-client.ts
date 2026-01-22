/**
 * Lumo Persistence API Client
 *
 * Handles communication with the Lumo API for:
 * - Spaces (conversation containers)
 * - Conversations
 * - Messages
 */

import { logger } from '../../logger.js';
import type { Api } from '../../lumo-client/types.js';
import type { SpaceId, ConversationId, MessageId, RemoteId } from '../types.js';

// API response types

interface SpaceFromApi {
    ID: string;
    CreateTime: string;     // ISO date string
    DeleteTime?: string;    // ISO date string (if soft-deleted)
    SpaceKey: string;       // Wrapped space key (base64)
    SpaceTag: string;       // Local ID
    Encrypted?: string;     // Encrypted space metadata
}

interface ConversationFromApi {
    ID: string;
    SpaceID: string;
    CreateTime: number;
    IsStarred: boolean;
    ConversationTag: string;    // Local ID
    Encrypted?: string;         // Encrypted conversation data (title)
}

interface MessageFromApi {
    ID: string;
    ConversationID: string;
    CreateTime: number;
    Role: number;           // 1 = user, 2 = assistant
    ParentID?: string;
    Status?: number;        // 1 = failed, 2 = succeeded
    MessageTag: string;     // Local ID
    Encrypted?: string;     // Encrypted message content
}

interface ListSpacesResponse {
    Spaces: SpaceFromApi[];
}

interface GetSpaceResponse {
    Space: SpaceFromApi;
    Conversations: ConversationFromApi[];
}

interface GetConversationResponse {
    Conversation: ConversationFromApi;
    Messages: MessageFromApi[];
}

interface CreateResponse {
    ID?: string;
    Space?: { ID: string };
    Conversation?: { ID: string };
    Message?: { ID: string };
}

// Request types

export interface CreateSpaceRequest {
    SpaceKey: string;       // Wrapped space key (base64)
    SpaceTag: string;       // Local ID
    Encrypted?: string;     // Encrypted space metadata
}

export interface CreateConversationRequest {
    SpaceID: string;
    IsStarred: boolean;
    ConversationTag: string;
    Encrypted?: string;
}

export interface UpdateConversationRequest {
    ID: string;
    SpaceID: string;
    IsStarred: boolean;
    ConversationTag: string;
    Encrypted?: string;
}

export interface CreateMessageRequest {
    ConversationID: string;
    Role: number;           // 1 = user, 2 = assistant
    ParentID?: string;
    ParentId?: string;      // Duplicate for buggy backend (lowercase 'd')
    Status?: number;
    MessageTag: string;
    Encrypted?: string;
}

// Role mapping
export const RoleToInt = {
    user: 1,
    assistant: 2,
    system: 1,  // Treat system as user for storage
    tool_call: 2,
    tool_result: 1,
} as const;

export const IntToRole = {
    1: 'user',
    2: 'assistant',
} as const;

// Status mapping
export const StatusToInt = {
    failed: 1,
    succeeded: 2,
    completed: 2,
    pending: undefined,
    streaming: undefined,
} as const;

/**
 * Lumo Persistence API Client
 */
export class LumoPersistenceClient {
    constructor(private api: Api) {}

    // ============ Space Operations ============

    /**
     * List all spaces (excludes soft-deleted spaces)
     */
    async listSpaces(): Promise<SpaceFromApi[]> {
        try {
            const response = await this.api({
                url: 'lumo/v1/spaces',
                method: 'get',
            }) as ListSpacesResponse;

            const allSpaces = response.Spaces ?? [];
            // Filter out soft-deleted spaces (those with DeleteTime set)
            const activeSpaces = allSpaces.filter(s => !s.DeleteTime);

            logger.debug({
                total: allSpaces.length,
                active: activeSpaces.length,
                deleted: allSpaces.length - activeSpaces.length,
            }, 'Spaces from API');

            return activeSpaces;
        } catch (error) {
            logger.error({ error }, 'Failed to list spaces');
            throw error;
        }
    }

    /**
     * Get a space with its conversations
     */
    async getSpace(remoteId: RemoteId): Promise<GetSpaceResponse> {
        try {
            const response = await this.api({
                url: `lumo/v1/spaces/${remoteId}`,
                method: 'get',
            }) as GetSpaceResponse;

            return response;
        } catch (error) {
            logger.error({ error, remoteId }, 'Failed to get space');
            throw error;
        }
    }

    /**
     * Create a new space
     */
    async createSpace(request: CreateSpaceRequest): Promise<RemoteId> {
        try {
            const response = await this.api({
                url: 'lumo/v1/spaces',
                method: 'post',
                data: request,
            }) as CreateResponse;

            const remoteId = response.Space?.ID;
            if (!remoteId) {
                throw new Error('No space ID in response');
            }

            logger.info({ remoteId, localId: request.SpaceTag }, 'Created space');
            return remoteId;
        } catch (error) {
            logger.error({ error }, 'Failed to create space');
            throw error;
        }
    }

    /**
     * Delete a space
     */
    async deleteSpace(remoteId: RemoteId): Promise<void> {
        try {
            await this.api({
                url: `lumo/v1/spaces/${remoteId}`,
                method: 'delete',
            });
            logger.info({ remoteId }, 'Deleted space');
        } catch (error) {
            logger.error({ error, remoteId }, 'Failed to delete space');
            throw error;
        }
    }

    // ============ Conversation Operations ============

    /**
     * Get a conversation with its messages
     */
    async getConversation(remoteId: RemoteId): Promise<GetConversationResponse> {
        try {
            const response = await this.api({
                url: `lumo/v1/conversations/${remoteId}`,
                method: 'get',
            }) as GetConversationResponse;

            return response;
        } catch (error) {
            logger.error({ error, remoteId }, 'Failed to get conversation');
            throw error;
        }
    }

    /**
     * Create a new conversation
     */
    async createConversation(
        spaceRemoteId: RemoteId,
        request: Omit<CreateConversationRequest, 'SpaceID'>
    ): Promise<RemoteId> {
        try {
            const response = await this.api({
                url: `lumo/v1/spaces/${spaceRemoteId}/conversations`,
                method: 'post',
                data: {
                    ...request,
                    SpaceID: spaceRemoteId,
                },
            }) as CreateResponse;

            const remoteId = response.Conversation?.ID;
            if (!remoteId) {
                throw new Error('No conversation ID in response');
            }

            logger.info({
                remoteId,
                localId: request.ConversationTag,
                spaceId: spaceRemoteId
            }, 'Created conversation');
            return remoteId;
        } catch (error) {
            logger.error({ error, spaceRemoteId }, 'Failed to create conversation');
            throw error;
        }
    }

    /**
     * Update a conversation
     */
    async updateConversation(request: UpdateConversationRequest): Promise<void> {
        try {
            await this.api({
                url: `lumo/v1/conversations/${request.ID}`,
                method: 'put',
                data: request,
            });
            logger.debug({ remoteId: request.ID }, 'Updated conversation');
        } catch (error) {
            logger.error({ error, remoteId: request.ID }, 'Failed to update conversation');
            throw error;
        }
    }

    /**
     * Delete a conversation
     */
    async deleteConversation(remoteId: RemoteId): Promise<void> {
        try {
            await this.api({
                url: `lumo/v1/conversations/${remoteId}`,
                method: 'delete',
            });
            logger.info({ remoteId }, 'Deleted conversation');
        } catch (error) {
            logger.error({ error, remoteId }, 'Failed to delete conversation');
            throw error;
        }
    }

    // ============ Message Operations ============

    /**
     * Create a new message
     */
    async createMessage(
        conversationRemoteId: RemoteId,
        request: Omit<CreateMessageRequest, 'ConversationID'>
    ): Promise<RemoteId> {
        try {
            const data = {
                ...request,
                ConversationID: conversationRemoteId,
            };

            logger.debug({
                url: `lumo/v1/conversations/${conversationRemoteId}/messages`,
                Role: data.Role,
                Status: data.Status,
                MessageTag: data.MessageTag,
                ParentID: data.ParentID,
                ParentId: data.ParentId,
                hasEncrypted: !!data.Encrypted,
                encryptedLength: data.Encrypted?.length,
                encryptedPreview: data.Encrypted?.slice(0, 50),
            }, 'Creating message - request data');

            const response = await this.api({
                url: `lumo/v1/conversations/${conversationRemoteId}/messages`,
                method: 'post',
                data,
            }) as CreateResponse;

            const remoteId = response.Message?.ID;
            if (!remoteId) {
                throw new Error('No message ID in response');
            }

            logger.debug({
                remoteId,
                localId: request.MessageTag,
                conversationId: conversationRemoteId
            }, 'Created message');
            return remoteId;
        } catch (error) {
            logger.error({ error, conversationRemoteId }, 'Failed to create message');
            throw error;
        }
    }

    /**
     * Get a single message
     */
    async getMessage(remoteId: RemoteId): Promise<MessageFromApi> {
        try {
            const response = await this.api({
                url: `lumo/v1/messages/${remoteId}`,
                method: 'get',
            }) as { Message: MessageFromApi };

            return response.Message;
        } catch (error) {
            logger.error({ error, remoteId }, 'Failed to get message');
            throw error;
        }
    }

    /**
     * Delete a message
     */
    async deleteMessage(remoteId: RemoteId): Promise<void> {
        try {
            await this.api({
                url: `lumo/v1/messages/${remoteId}`,
                method: 'delete',
            });
            logger.debug({ remoteId }, 'Deleted message');
        } catch (error) {
            logger.error({ error, remoteId }, 'Failed to delete message');
            throw error;
        }
    }
}

// Export API types for use elsewhere
export type {
    SpaceFromApi,
    ConversationFromApi,
    MessageFromApi,
    GetSpaceResponse,
    GetConversationResponse,
};
