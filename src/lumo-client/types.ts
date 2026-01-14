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
export interface ApiOptions {
    url: string;
    method: 'get' | 'post' | 'put' | 'delete';
    data?: unknown;
    signal?: AbortSignal;
    output?: 'stream' | 'json';
    silence?: boolean;
}

export type Api = (options: ApiOptions) => Promise<ReadableStream<Uint8Array> | unknown>;

// Auth tokens structure for storage
export interface AuthTokens {
    cookies: Array<{
        name: string;
        value: string;
        domain: string;
        path: string;
        expires: number;
        httpOnly: boolean;
        secure: boolean;
        sameSite: string;
    }>;
    localStorage?: Record<string, string>;
    extractedAt: string;
    // Extended auth data for conversation persistence
    persistedSession?: PersistedSessionData;
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
