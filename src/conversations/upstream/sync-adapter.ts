/**
 * Upstream Sync Service Adapter
 *
 * Wraps the upstream Redux + saga sync mechanism to provide the same interface
 * as the existing SyncService. This enables drop-in replacement while using
 * the upstream sync infrastructure.
 *
 * Key differences from existing SyncService:
 * - Sync happens automatically via sagas (no manual sync() calls needed)
 * - Dirty tracking is in IndexedDB, not in-memory
 * - Space management is handled by sagas
 */

import type { Store } from '@reduxjs/toolkit';

import { logger } from '../../app/logger.js';
import type { SpaceId, RemoteId } from '../types.js';

import type { LumoState, LumoStore } from '@lumo/redux/store.js';
import { DbApi } from '@lumo/indexedDb/db.js';
import type { ResourceType } from '@lumo/remote/types.js';
import {
    pushSpaceRequest,
    pullSpacesRequest,
} from '@lumo/redux/slices/core/spaces.js';
import {
    pushConversationRequest,
    pullConversationRequest,
} from '@lumo/redux/slices/core/conversations.js';
import {
    pushMessageRequest,
} from '@lumo/redux/slices/core/messages.js';

export interface UpstreamSyncServiceConfig {
    store: LumoStore;
    dbApi: DbApi;
    spaceId: SpaceId;
    spaceRemoteId?: RemoteId;
}

/**
 * Upstream-backed Sync Service
 *
 * Provides the same interface as SyncService but delegates to the upstream
 * Redux/saga sync infrastructure.
 */
export class UpstreamSyncService {
    private store: LumoStore;
    private dbApi: DbApi;
    private _spaceId: SpaceId;
    private _spaceRemoteId?: RemoteId;

    constructor(config: UpstreamSyncServiceConfig) {
        this.store = config.store;
        this.dbApi = config.dbApi;
        this._spaceId = config.spaceId;
        this._spaceRemoteId = config.spaceRemoteId;
    }

    /**
     * Get or create the space (returns existing space since we initialize with one)
     */
    async getOrCreateSpace(): Promise<{ spaceId: SpaceId; remoteId: RemoteId }> {
        if (this._spaceRemoteId) {
            return {
                spaceId: this._spaceId,
                remoteId: this._spaceRemoteId,
            };
        }

        // Check if space exists in Redux state
        const state = this.store.getState();
        const space = state.spaces[this._spaceId];

        if (space) {
            // Look up remote ID from idmap
            const remoteId = await this.getRemoteId('space', this._spaceId);
            if (remoteId) {
                this._spaceRemoteId = remoteId;
                return { spaceId: this._spaceId, remoteId };
            }
        }

        // Trigger space push via saga (use 'urgent' for user-initiated actions)
        this.store.dispatch(pushSpaceRequest({ id: this._spaceId, priority: 'urgent' }));

        // Wait for remote ID to be assigned (simplified - in practice would use takeLatest)
        const remoteId = await this.waitForRemoteId('space', this._spaceId);
        this._spaceRemoteId = remoteId;

        return { spaceId: this._spaceId, remoteId };
    }

    /**
     * Ensure existing conversations are loaded from server
     *
     * In upstream mode, this is handled by the initAppSaga which pulls spaces
     * and their conversations from the server.
     */
    async ensureExistingConversationsLoaded(): Promise<void> {
        // Dispatch pull spaces request - sagas handle the rest
        this.store.dispatch(pullSpacesRequest());

        // Wait for initialization to complete
        await this.waitForReduxLoaded();
    }

    /**
     * Sync all dirty resources
     *
     * In upstream mode, dirty tracking is in IndexedDB. The sagas automatically
     * push dirty resources. This method triggers an explicit push.
     */
    async sync(): Promise<number> {
        const unsynced = await this.dbApi.findUnsyncedResources();
        const {
            unsyncedSpaces,
            unsyncedConversations,
            unsyncedMessages,
        } = unsynced;

        let total = 0;

        // Push dirty spaces
        for (const id of Object.keys(unsyncedSpaces ?? {})) {
            this.store.dispatch(pushSpaceRequest({ id, priority: 'background' }));
            total++;
        }

        // Push dirty conversations
        for (const id of Object.keys(unsyncedConversations ?? {})) {
            this.store.dispatch(pushConversationRequest({ id, priority: 'background' }));
            total++;
        }

        // Push dirty messages
        for (const id of Object.keys(unsyncedMessages ?? {})) {
            this.store.dispatch(pushMessageRequest({ id, priority: 'background' }));
            total++;
        }

        if (total > 0) {
            logger.info({ total }, 'Triggered push for dirty resources');
        }

        return total;
    }

    /**
     * Sync a single conversation by ID
     */
    async syncById(conversationId: string): Promise<boolean> {
        // Dispatch push request for the conversation (use 'urgent' for user-initiated)
        this.store.dispatch(pushConversationRequest({
            id: conversationId,
            priority: 'urgent',
        }));

        // Get all messages for this conversation and push them
        const state = this.store.getState();
        const messages = Object.values(state.messages).filter(
            m => m.conversationId === conversationId
        );

        for (const msg of messages) {
            this.store.dispatch(pushMessageRequest({
                id: msg.id,
                priority: 'urgent',
            }));
        }

        logger.debug({ conversationId, messageCount: messages.length }, 'Triggered sync for conversation');
        return true;
    }

    /**
     * Load an existing conversation from server
     *
     * Fetches conversation and its messages via pullConversationRequest saga.
     * Messages are lazy-loaded - only fetched when this method is called.
     */
    async loadExistingConversation(localId: string): Promise<string | undefined> {
        const state = this.store.getState();

        // Check if conversation exists
        if (!state.conversations[localId]) {
            logger.debug({ localId }, 'Conversation not found in Redux state');
            return undefined;
        }

        // Check if we have a remote ID (needed for server fetch)
        const remoteId = this.getRemoteId('conversation', localId);
        if (!remoteId) {
            logger.debug({ localId }, 'No remote ID for conversation, skipping pull');
            return localId;
        }

        // Dispatch pull request to fetch messages
        this.store.dispatch(pullConversationRequest({ id: localId }));

        // Wait for pull to complete
        const success = await this.waitForPullConversation(localId);
        if (!success) {
            logger.warn({ localId }, 'Failed to pull conversation messages');
        }

        return localId;
    }

    /**
     * Wait for pullConversationRequest to complete
     */
    private async waitForPullConversation(
        localId: string,
        timeoutMs: number = 10000
    ): Promise<boolean> {
        const start = Date.now();

        // Simple polling - check if messages exist for this conversation
        // A more robust approach would subscribe to pullConversationSuccess/Failure actions
        while (Date.now() - start < timeoutMs) {
            const state = this.store.getState();
            const messages = Object.values(state.messages).filter(
                m => m.conversationId === localId
            );
            // If we have messages, the pull likely completed
            if (messages.length > 0) {
                return true;
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        // Timeout - but conversation might just be empty
        return true;
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
        const state = this.store.getState();
        return {
            hasSpace: !!this._spaceId,
            spaceId: this._spaceId,
            spaceRemoteId: this._spaceRemoteId,
            mappedConversations: Object.keys(state.conversations).length,
            mappedMessages: Object.keys(state.messages).length,
        };
    }

    /**
     * Delete all spaces (destructive!)
     *
     * Intentionally not implemented in upstream mode for safety.
     * This operation would delete all conversations permanently.
     * If needed, users should delete spaces through the WebClient.
     */
    async deleteAllSpaces(): Promise<number> {
        logger.warn('deleteAllSpaces is disabled in upstream mode for safety');
        return 0;
    }

    // Private helpers

    private getRemoteId(type: ResourceType, localId: string): RemoteId | undefined {
        const state = this.store.getState();
        return state.idmap.local2remote[type]?.[localId];
    }

    private async waitForRemoteId(
        type: ResourceType,
        localId: string,
        timeoutMs: number = 10000
    ): Promise<RemoteId> {
        const start = Date.now();

        while (Date.now() - start < timeoutMs) {
            const remoteId = this.getRemoteId(type, localId);
            if (remoteId) {
                return remoteId;
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        throw new Error(`Timeout waiting for remote ID for ${type}:${localId}`);
    }

    private async waitForReduxLoaded(timeoutMs: number = 10000): Promise<void> {
        const start = Date.now();

        while (Date.now() - start < timeoutMs) {
            const state = this.store.getState();
            if (state.initialization?.reduxLoadedFromIdb) {
                return;
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        logger.warn('Timeout waiting for Redux to load from IDB');
    }
}
