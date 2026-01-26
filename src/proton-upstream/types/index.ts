/**
 * Types Shim
 *
 * Replaces: applications/lumo/src/app/types.ts (selective subset)
 *
 * Original file is 888 lines with all Lumo types.
 * This shim exports only what remote/* files need.
 *
 * Key exports (shim line → original line):
 * - Base64, Armor, AdString: 9-11 → 9-11
 * - Uuid, SpaceId, ConversationId, MessageId: 14-19 → 14-19
 * - isRemoteId, isUuid: 23-29 → 21-27
 * - Status, isStatus(): 32-36 → 30-34
 * - EncryptedData types: 39-49 → 36-44
 * - Role enum: 59-65 → 55-61
 * - MasterKey: 86-92 → 794-800
 * - LUMO_ELIGIBILITY: 114-118 → 874-878
 * - SerializedSpace: 123-130 → 119
 * - SerializedConversation: 133-141 → 475
 * - SerializedMessage: 144-155 → 317
 * - SerializedAttachment: 158-169 → 593
 */

// *** String aliases ***
export type Base64 = string;
export type Armor = string;
export type AdString = string;

// *** Ids ***
export type Uuid = string;
export type SpaceId = Uuid;
export type ConversationId = Uuid;
export type MessageId = Uuid;
export type AttachmentId = Uuid;
export type RequestId = Uuid;

const UUID_RE = /^[a-zA-Z0-9]{8}-[a-zA-Z0-9]{4}-[a-zA-Z0-9]{4}-[a-zA-Z0-9]{4}-[a-zA-Z0-9]{12}$/;

export const isRemoteId = (value: unknown): value is MessageId =>
    typeof value === 'string' && value.length > 0;
export const isUuid = (value: unknown): value is Uuid =>
    typeof value === 'string' && UUID_RE.test(value);
export const isMessageId = isUuid;
export const isConversationId = isUuid;
export const isSpaceId = isUuid;

// *** Status ***
export type Status = 'succeeded' | 'failed';

export function isStatus(value: unknown): value is Status {
    return value === 'succeeded' || value === 'failed';
}

// *** Encrypted Data ***
export type OldEncryptedData = { iv: Base64; data: Base64 };
export type EncryptedData = Base64 | OldEncryptedData;

export function isOldEncryptedData(obj: unknown): obj is OldEncryptedData {
    return (
        typeof obj === 'object' &&
        obj !== null &&
        typeof (obj as OldEncryptedData).iv === 'string' &&
        typeof (obj as OldEncryptedData).data === 'string'
    );
}

export type Encrypted = {
    encrypted: EncryptedData;
};
export type Shallow = {
    encrypted?: undefined;
};

// *** Role ***
export enum Role {
    Assistant = 'assistant',
    User = 'user',
    System = 'system',
    ToolCall = 'tool_call',
    ToolResult = 'tool_result',
}

export function isRole(value: unknown): value is Role {
    return (
        value === Role.Assistant ||
        value === Role.User ||
        value === Role.System ||
        value === Role.ToolCall ||
        value === Role.ToolResult
    );
}

// *** Deleted flags ***
export type NonDeleted = { deleted?: false | undefined };
export type Deleted = { deleted: true };
export type LocalFlags = {
    dirty?: boolean;
    deleted?: boolean;
};

// *** MasterKey ***
export type MasterKey = {
    id: string;
    isLatest: boolean;
    version: number;
    createdAt: string;
    masterKey: Base64;
};

// *** ProtonApiResponse ***
export type ProtonApiResponse = {
    Code: number;
    Conversation?: unknown;
    Space?: unknown;
    Spaces?: unknown;
    Message?: unknown;
    Asset?: unknown;
    MasterKeys?: unknown;
};

export function isProtonApiResponse(value: unknown): value is ProtonApiResponse {
    return (
        typeof value === 'object' &&
        value !== null &&
        typeof (value as ProtonApiResponse).Code === 'number'
    );
}

// *** LUMO_ELIGIBILITY ***
export enum LUMO_ELIGIBILITY {
    'Eligible' = 0,
    'OnWaitlist' = 1,
    'NotOnWaitlist' = 2,
}

// *** Serialized types (for persistence) ***

// Space
export type SerializedSpace = {
    id: SpaceId;
    createdAt: string;
    wrappedSpaceKey?: Base64;
    encrypted?: EncryptedData;
    dirty?: boolean;
    deleted?: boolean;
};

// Conversation
export type SerializedConversation = {
    id: ConversationId;
    spaceId: SpaceId;
    createdAt: string;
    starred?: boolean;
    encrypted?: EncryptedData;
    dirty?: boolean;
    deleted?: boolean;
};

// Message
export type SerializedMessage = {
    id: MessageId;
    conversationId: ConversationId;
    parentId?: MessageId;
    createdAt: string;
    role: Role;
    status?: Status;
    placeholder?: boolean;
    encrypted?: EncryptedData;
    dirty?: boolean;
    deleted?: boolean;
};

// Attachment (also called Asset)
export type SerializedAttachment = {
    id: AttachmentId;
    spaceId?: SpaceId;
    mimeType?: string;
    uploadedAt: string;
    rawBytes?: number;
    processing?: boolean;
    error?: boolean;
    encrypted?: EncryptedData;
    dirty?: boolean;
    deleted?: boolean;
};

// Shallow attachment (without encrypted data)
export type ShallowAttachment = {
    id: AttachmentId;
    spaceId?: SpaceId;
    mimeType?: string;
    uploadedAt: string;
    rawBytes?: number;
    filename?: string;
};
