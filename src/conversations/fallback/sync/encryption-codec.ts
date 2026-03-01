/**
 * Encryption Codec for Lumo data persistence
 *
 * Handles encryption/decryption of spaces, conversations, and messages
 * using AES-GCM with Authenticated Data (AEAD).
 *
 * AD format must match Lumo WebClient (json-stable-stringify with alphabetically sorted keys).
 */

import stableStringify from 'json-stable-stringify';
import { logger } from '../../../app/logger.js';
import { encryptData, decryptData } from '@proton/crypto/lib/subtle/aesGcm';
import { Role } from '@lumo/types.js';
import type {
    Message,
    ProjectSpace,
    ConversationPriv,
    MessagePrivate,
} from '../../types.js';

// Role mapping for AD construction
// Maps internal roles to API-compatible roles (user/assistant)
const RoleToApiInt: Record<Role, number> = {
    [Role.User]: 1,
    [Role.Assistant]: 2,
    [Role.System]: 1,       // Treat system as user for storage
    [Role.ToolCall]: 2,     // Tool calls are assistant messages
    [Role.ToolResult]: 1,   // Tool results are user messages
};

/**
 * Encryption Codec
 *
 * Provides type-safe encryption/decryption for Lumo data types.
 * All methods use AEAD with alphabetically-sorted JSON AD strings.
 */
export class EncryptionCodec {
    constructor(private dataEncryptionKey: CryptoKey) {}

    /**
     * Generic encryption with Authenticated Data
     */
    private async encrypt<T>(data: T, ad: Record<string, string | undefined>): Promise<string> {
        const json = JSON.stringify(data);
        const plaintext = new TextEncoder().encode(json);
        const adString = stableStringify(ad);
        logger.debug({ adString }, 'Encrypting with AD');
        const adBytes = new TextEncoder().encode(adString);

        const encrypted = await encryptData(this.dataEncryptionKey, plaintext, adBytes);
        return encrypted.toBase64();
    }

    /**
     * Generic decryption with Authenticated Data
     * Returns null on decryption failure (graceful fallback)
     */
    private async decrypt<T>(
        encryptedBase64: string,
        ad: Record<string, string | undefined>,
        entityType: string,
        entityId: string
    ): Promise<T | null> {
        try {
            const encrypted = Buffer.from(encryptedBase64, 'base64');
            const adString = stableStringify(ad);
            logger.debug({ adString, entityType, entityId }, 'Decrypting with AD');
            const adBytes = new TextEncoder().encode(adString);

            const decrypted = await decryptData(this.dataEncryptionKey, new Uint8Array(encrypted), adBytes);
            const json = new TextDecoder().decode(decrypted);
            logger.debug({ entityType, entityId, json }, 'Successfully decrypted');
            return JSON.parse(json) as T;
        } catch (error) {
            logger.warn({ entityType, entityId, error }, `Failed to decrypt ${entityType} private data`);
            return null;
        }
    }

    // --- Space ---

    async encryptSpace(data: ProjectSpace, spaceId: string): Promise<string> {
        return this.encrypt(data, {
            app: 'lumo',
            type: 'space',
            id: spaceId,
        });
    }

    async decryptSpace(encryptedBase64: string, spaceId: string): Promise<ProjectSpace | null> {
        return this.decrypt<ProjectSpace>(
            encryptedBase64,
            {
                app: 'lumo',
                type: 'space',
                id: spaceId,
            },
            'space',
            spaceId
        );
    }

    // --- Conversation ---

    async encryptConversation(
        data: ConversationPriv,
        conversationId: string,
        spaceId: string
    ): Promise<string> {
        return this.encrypt(data, {
            app: 'lumo',
            type: 'conversation',
            id: conversationId,
            spaceId: spaceId,
        });
    }

    async decryptConversation(
        encryptedBase64: string,
        conversationId: string,
        spaceId: string
    ): Promise<ConversationPriv | null> {
        return this.decrypt<ConversationPriv>(
            encryptedBase64,
            {
                app: 'lumo',
                type: 'conversation',
                id: conversationId,
                spaceId: spaceId,
            },
            'conversation',
            conversationId
        );
    }

    // --- Message ---

    /**
     * Encrypt message private data
     *
     * IMPORTANT: The role in AD must be the mapped role (user/assistant) that matches what
     * the WebClient will reconstruct from the Role integer field, NOT our internal role names.
     */
    async encryptMessage(
        data: MessagePrivate,
        message: Message,
        effectiveParentId?: string
    ): Promise<string> {
        // Map our internal role to the role the WebClient will use for AD reconstruction
        const roleInt = RoleToApiInt[message.role] ?? 1;
        const adRole = roleInt === 2 ? 'assistant' : 'user';

        return this.encrypt(data, {
            app: 'lumo',
            type: 'message',
            id: message.id,
            role: adRole,
            parentId: effectiveParentId,
            conversationId: message.conversationId,
        });
    }

    /**
     * Decrypt message private data
     *
     * @param role - Role from upstream (already a string: 'user'/'assistant')
     */
    async decryptMessage(
        encryptedBase64: string,
        messageId: string,
        conversationId: string,
        role: string,
        parentId?: string
    ): Promise<MessagePrivate | null> {
        return this.decrypt<MessagePrivate>(
            encryptedBase64,
            {
                app: 'lumo',
                type: 'message',
                id: messageId,
                role: role,
                parentId: parentId,
                conversationId: conversationId,
            },
            'message',
            messageId
        );
    }
}
