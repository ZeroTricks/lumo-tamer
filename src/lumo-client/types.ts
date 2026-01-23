/**
 * Local types for the Lumo client
 * Re-exports upstream types and adds local-only types
 */

// Re-export upstream types
export type {
    AesGcmCryptoKey,
    GenerationToFrontendMessage,
    LumoApiGenerationRequest,
    RequestId,
    ToolName,
    Turn,
} from '../proton-upstream/lib/lumo-api-client/core/types.js';

// Local-only types

// API adapter interface
export interface ProtonApiOptions {
    url: string;
    method: 'get' | 'post' | 'put' | 'delete';
    data?: unknown;
    signal?: AbortSignal;
    output?: 'stream' | 'json';
    silence?: boolean;
}

export type ProtonApi = (options: ProtonApiOptions) => Promise<ReadableStream<Uint8Array> | unknown>;

// Cached user keys structure (for persistence without core/v4/users scope)
export interface CachedUserKey {
    ID: string;
    PrivateKey: string;     // Armored PGP private key
    Primary: number;        // 1 = primary
    Active: number;         // 1 = active
}

// Cached master key structure (for persistence without lumo/v1/masterkeys scope)
export interface CachedMasterKey {
    ID: string;
    MasterKey: string;      // PGP-encrypted master key (base64)
    IsLatest: boolean;
    Version: number;
}

// Persisted session structure (from Proton localStorage ps-{localID})
export interface PersistedSessionData {
    localID: number;
    UserID: string;
    UID: string;
    blob?: string;              // Encrypted blob containing keyPassword (base64)
    payloadVersion: 1 | 2;      // Encryption version
    persistedAt: number;
    // ClientKey fetched from API, used to decrypt blob
    clientKey?: string;
}

// Decrypted session blob structure
export interface DecryptedSessionBlob {
    keyPassword: string;        // The mailbox password
    type: 'default' | 'offline';
    offlineKeyPassword?: string;
}
