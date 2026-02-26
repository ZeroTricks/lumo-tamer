/**
 * Space Manager for Lumo sync
 *
 * Handles space lifecycle:
 * - Lazy space initialization (find existing or create new)
 * - Space key derivation
 * - Conversation ID mapping (local <-> remote)
 */

import { randomUUID } from 'crypto';
import { logger } from '../../app/logger.js';
import { exportKey, deriveKey } from '@proton/crypto/lib/subtle/aesGcm';
import type { LumoApi } from '@lumo/remote/api.js';
import type { RemoteSpace } from '@lumo/remote/types.js';
import type { KeyManager } from '../encryption/key-manager.js';
import type { SpaceId, RemoteId, ProjectSpace } from '../types.js';
import { EncryptionCodec } from './encryption-codec.js';

// HKDF parameters matching Proton's implementation
const SPACE_KEY_DERIVATION_SALT = Buffer.from('Xd6V94/+5BmLAfc67xIBZcjsBPimm9/j02kHPI7Vsuc=', 'base64');
const SPACE_DEK_CONTEXT = new TextEncoder().encode('dek.space.lumo');

export interface SpaceManagerConfig {
    lumoApi: LumoApi;
    keyManager: KeyManager;
    spaceName?: string;
    configuredSpaceId?: string;
}

export interface SpaceContext {
    spaceId: SpaceId;
    remoteId: RemoteId;
}

/**
 * Space Manager
 *
 * Manages space lifecycle and provides access to the encryption codec.
 */
export class SpaceManager {
    private lumoApi: LumoApi;
    private keyManager: KeyManager;
    private spaceName?: string;
    private configuredSpaceId?: string;

    // Current space state
    private _spaceId?: SpaceId;
    private _spaceRemoteId?: RemoteId;
    private spaceKey?: CryptoKey;
    private dataEncryptionKey?: CryptoKey;
    private _codec?: EncryptionCodec;

    // ID mappings for conversations (messages handled by SyncService)
    private conversationIdMap = new Map<string, RemoteId>();
    private existingConversationsLoaded = false;

    constructor(config: SpaceManagerConfig) {
        if (!config.configuredSpaceId && !config.spaceName) {
            throw new Error('Either spaceId or spaceName must be provided');
        }
        this.lumoApi = config.lumoApi;
        this.keyManager = config.keyManager;
        this.spaceName = config.spaceName;
        this.configuredSpaceId = config.configuredSpaceId;
    }

    // --- Accessors ---

    get spaceId(): SpaceId | undefined {
        return this._spaceId;
    }

    get spaceRemoteId(): RemoteId | undefined {
        return this._spaceRemoteId;
    }

    get codec(): EncryptionCodec | undefined {
        return this._codec;
    }

    getConversationRemoteId(localId: string): RemoteId | undefined {
        return this.conversationIdMap.get(localId);
    }

    setConversationRemoteId(localId: string, remoteId: RemoteId): void {
        this.conversationIdMap.set(localId, remoteId);
    }

    // --- Space Lifecycle ---

    /**
     * Ensure a space exists, creating one if needed
     * Called lazily on first sync
     *
     * Matching logic:
     * 1. If spaceId is configured, use that space directly (by UUID)
     * 2. Otherwise, find a space with matching spaceName (projectName)
     * 3. If no match found, create a new space
     */
    async getOrCreateSpace(): Promise<SpaceContext> {
        // Already have a space
        if (this._spaceId && this._spaceRemoteId && this.spaceKey) {
            return { spaceId: this._spaceId, remoteId: this._spaceRemoteId };
        }

        const searchCriteria = this.configuredSpaceId
            ? { spaceId: this.configuredSpaceId }
            : { spaceName: this.spaceName };
        logger.info(searchCriteria, 'Checking for existing project...');

        const listResult = await this.lumoApi.listSpaces();
        const existingSpaces = Object.values(listResult.spaces);

        const spacesWithData = existingSpaces.filter(s => s.encrypted);
        logger.info({
            totalSpaces: existingSpaces.length,
            spacesWithEncryptedData: spacesWithData.length,
            spaceTags: existingSpaces.map(s => s.id),
        }, 'Available projects');

        // If spaceId is configured, find that specific space by UUID
        if (this.configuredSpaceId) {
            return this.findSpaceById(existingSpaces);
        }

        // Otherwise, find by name
        return this.findSpaceByName(existingSpaces);
    }

    private async findSpaceById(existingSpaces: RemoteSpace[]): Promise<SpaceContext> {
        const space = existingSpaces.find(s => s.id === this.configuredSpaceId);
        if (!space) {
            logger.error({ spaceId: this.configuredSpaceId }, 'Configured project not found');
            throw new Error(`Configured project ${this.configuredSpaceId} not found on server`);
        }

        if (!space.wrappedSpaceKey) {
            logger.error({ spaceId: this.configuredSpaceId }, 'Configured project has no space key (deleted?)');
            throw new Error(`Configured project ${this.configuredSpaceId} has no space key`);
        }

        try {
            await this.initializeSpaceKeys({
                id: space.id,
                remoteId: space.remoteId,
                wrappedSpaceKey: space.wrappedSpaceKey,
            });
            logger.info(`Using project by id ${space.id}: ${space.remoteId}`);
            return { spaceId: this._spaceId!, remoteId: this._spaceRemoteId! };
        } catch (error) {
            logger.error({ spaceId: this.configuredSpaceId, error }, 'Failed to decrypt configured project');
            throw new Error(`Cannot decrypt configured project ${this.configuredSpaceId}`);
        }
    }

    private async findSpaceByName(existingSpaces: RemoteSpace[]): Promise<SpaceContext> {
        logger.info(`Looking up project by name "${this.spaceName}" (among ${existingSpaces.length} projects)`);

        for (const space of existingSpaces) {
            if (!space.id) continue;

            try {
                const spaceKey = await this.keyManager.getSpaceKey(space.id, space.wrappedSpaceKey);
                const dataEncryptionKey = await this.deriveDataEncryptionKey(spaceKey);
                const codec = new EncryptionCodec(dataEncryptionKey);

                const encryptedData = typeof space.encrypted === 'string' ? space.encrypted : undefined;
                logger.debug({
                    spaceTag: space.id,
                    hasEncrypted: !!encryptedData,
                    encryptedLength: encryptedData?.length ?? 0,
                }, 'Checking space');

                if (!encryptedData) continue;

                const projectSpace = await codec.decryptSpace(encryptedData, space.id);

                logger.debug({
                    spaceTag: space.id,
                    projectName: projectSpace?.projectName,
                    lookingFor: this.spaceName,
                    decryptedOk: !!projectSpace,
                }, 'Checking project name match');

                if (projectSpace && projectSpace.projectName === this.spaceName) {
                    this._spaceId = space.id;
                    this._spaceRemoteId = space.remoteId;
                    this.spaceKey = spaceKey;
                    this.dataEncryptionKey = dataEncryptionKey;
                    this._codec = codec;

                    logger.info({
                        spaceId: space.id,
                        remoteId: space.remoteId,
                        projectName: projectSpace.projectName,
                    }, 'Found existing project');

                    return { spaceId: this._spaceId, remoteId: this._spaceRemoteId };
                }
            } catch (error) {
                logger.debug({ spaceTag: space.id, error }, 'Could not decrypt space');
                continue;
            }
        }

        // No matching space found, create a new one
        if (!this.spaceName) {
            throw new Error('Cannot create project: no projectName configured');
        }
        logger.info({ spaceName: this.spaceName }, 'Creating new project...');
        return this.createSpace();
    }

    /**
     * Create a new space on the server
     */
    private async createSpace(): Promise<SpaceContext> {
        const localId = randomUUID();

        // Generate a new space key and get it cached in KeyManager
        const spaceKey = await this.keyManager.getSpaceKey(localId);
        const wrappedSpaceKey = await this.keyManager.wrapSpaceKey(localId);
        const dataEncryptionKey = await this.deriveDataEncryptionKey(spaceKey);
        const codec = new EncryptionCodec(dataEncryptionKey);

        const projectSpace: ProjectSpace = {
            isProject: true,
            projectName: this.spaceName,
        };
        const encryptedPrivate = await codec.encryptSpace(projectSpace, localId);

        const remoteId = await this.lumoApi.postSpace({
            SpaceKey: wrappedSpaceKey,
            SpaceTag: localId,
            Encrypted: encryptedPrivate,
        }, 'background');

        if (!remoteId) {
            throw new Error('Failed to create project - no remote ID returned');
        }

        // Cache state
        this._spaceId = localId;
        this._spaceRemoteId = remoteId;
        this.spaceKey = spaceKey;
        this.dataEncryptionKey = dataEncryptionKey;
        this._codec = codec;

        logger.info({
            spaceId: localId,
            remoteId,
            projectName: this.spaceName,
        }, 'Created new project');

        return { spaceId: localId, remoteId };
    }

    private async initializeSpaceKeys(space: {
        id: string;
        remoteId: string;
        wrappedSpaceKey: string;
    }): Promise<void> {
        const spaceKey = await this.keyManager.getSpaceKey(space.id, space.wrappedSpaceKey);
        const dataEncryptionKey = await this.deriveDataEncryptionKey(spaceKey);

        this._spaceId = space.id;
        this._spaceRemoteId = space.remoteId;
        this.spaceKey = spaceKey;
        this.dataEncryptionKey = dataEncryptionKey;
        this._codec = new EncryptionCodec(dataEncryptionKey);
    }

    /**
     * Derive data encryption key from space key using HKDF
     */
    private async deriveDataEncryptionKey(spaceKey: CryptoKey): Promise<CryptoKey> {
        const keyBytes = await exportKey(spaceKey);
        return deriveKey(keyBytes, new Uint8Array(SPACE_KEY_DERIVATION_SALT), SPACE_DEK_CONTEXT);
    }

    // --- Conversation ID Loading ---

    /**
     * Ensure existing conversations are loaded from server (lazy, called once)
     * Populates conversationIdMap with conversation IDs to prevent 409 errors on sync
     */
    async ensureExistingConversationsLoaded(): Promise<void> {
        if (this.existingConversationsLoaded) return;
        if (!this._spaceRemoteId || !this._spaceId) return;

        try {
            const spaceData = await this.lumoApi.getSpace(this._spaceRemoteId);
            if (!spaceData) {
                logger.warn({ spaceRemoteId: this._spaceRemoteId }, 'Project not found on server');
                return;
            }

            for (const conv of spaceData.conversations ?? []) {
                try {
                    const convData = await this.lumoApi.getConversation(conv.remoteId, this._spaceId);
                    if (convData?.conversation) {
                        const localId = convData.conversation.id;
                        this.conversationIdMap.set(localId, conv.remoteId);
                        logger.debug({ localId, remoteId: conv.remoteId }, 'Mapped conversation');
                    }
                } catch (error) {
                    logger.warn({ remoteId: conv.remoteId, error }, 'Failed to fetch conversation');
                }
            }

            this.existingConversationsLoaded = true;

            logger.info({
                conversations: this.conversationIdMap.size,
            }, 'Loaded existing conversation IDs from server');
        } catch (error) {
            logger.error({ error }, 'Failed to load existing conversations');
        }
    }

    // --- Cleanup ---

    /**
     * Delete ALL spaces from the server
     * WARNING: This is destructive and cannot be undone!
     */
    async deleteAllSpaces(): Promise<number> {
        const listResult = await this.lumoApi.listSpaces();
        const spaces = Object.values(listResult.spaces);
        logger.warn({ count: spaces.length }, 'Deleting ALL projects...');

        let deleted = 0;
        for (const space of spaces) {
            try {
                await this.lumoApi.deleteSpace(space.remoteId, 'background');
                deleted++;
                logger.info({ spaceId: space.id, remoteId: space.remoteId }, 'Deleted project');
            } catch (error) {
                logger.error({ spaceId: space.id, error }, 'Failed to delete project');
            }
        }

        // Clear local state
        this._spaceId = undefined;
        this._spaceRemoteId = undefined;
        this.spaceKey = undefined;
        this.dataEncryptionKey = undefined;
        this._codec = undefined;
        this.conversationIdMap.clear();

        logger.warn({ deleted, total: spaces.length }, 'Finished deleting projects');
        return deleted;
    }

    /**
     * Reset state (for testing)
     */
    reset(): void {
        this._spaceId = undefined;
        this._spaceRemoteId = undefined;
        this.spaceKey = undefined;
        this.dataEncryptionKey = undefined;
        this._codec = undefined;
        this.conversationIdMap.clear();
        this.existingConversationsLoaded = false;
    }
}
