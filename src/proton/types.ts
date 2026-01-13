/**
 * Types adapted from Proton WebClients
 * Source: applications/lumo/src/app/lib/lumo-api-client/core/types.ts
 * See UPSTREAM.md for version info
 */

// Role types for conversation turns
export type Role = 'assistant' | 'user' | 'system' | 'tool_call' | 'tool_result';

// Conversation turn
export type Turn = {
    role: Role;
    content?: string;
    encrypted?: boolean;
};

// Encrypted turn (after U2L encryption)
export type EncryptedTurn = Turn & { encrypted: true };

// Common type aliases
export type Base64 = string;
export type RequestId = string;

// AES-GCM crypto key wrapper
export type AesGcmCryptoKey = {
    type: 'AesGcmCryptoKey';
    encryptKey: CryptoKey;
};

// Available tools
export type ToolName = 'proton_info' | 'web_search' | 'weather' | 'stock' | 'cryptocurrency';

// Generation targets
export type RequestableGenerationTarget = 'message' | 'title';
export type GenerationTarget = 'message' | 'title' | 'tool_call' | 'tool_result';

// API request structure
export type LumoApiGenerationRequest = {
    type: 'generation_request';
    turns: Turn[];
    options?: {
        tools?: ToolName[] | boolean;
    };
    targets?: RequestableGenerationTarget[];
    request_key?: string; // aes-gcm-256, pgp-encrypted, base64
    request_id?: RequestId; // uuid used solely for AEAD encryption
};

// SSE message types from server
export type GenerationToFrontendMessage =
    | { type: 'queued'; target?: GenerationTarget }
    | { type: 'ingesting'; target: GenerationTarget }
    | { type: 'token_data'; target: GenerationTarget; count: number; content: string; encrypted?: boolean }
    | { type: 'done' }
    | { type: 'timeout' }
    | { type: 'error' }
    | { type: 'rejected' }
    | { type: 'harmful' };

// Status for completion
export type Status = 'succeeded' | 'failed';

// Type guard for GenerationTarget
export function isGenerationTarget(value: unknown): value is GenerationTarget {
    return ['message', 'title', 'tool_call', 'tool_result'].includes(value as string);
}

// Type guard for GenerationToFrontendMessage
export function isGenerationToFrontendMessage(obj: unknown): obj is GenerationToFrontendMessage {
    if (typeof obj !== 'object' || obj === null) {
        return false;
    }

    if (!('type' in obj)) {
        return false;
    }

    const typed = obj as { type: string; target?: unknown; count?: unknown; content?: unknown; encrypted?: unknown };

    switch (typed.type) {
        case 'queued':
        case 'ingesting':
        case 'done':
        case 'timeout':
        case 'error':
        case 'rejected':
        case 'harmful':
            return true;

        case 'token_data':
            return (
                'target' in typed &&
                'count' in typed &&
                'content' in typed &&
                isGenerationTarget(typed.target) &&
                typeof typed.count === 'number' &&
                typeof typed.content === 'string' &&
                (!('encrypted' in typed) || typeof typed.encrypted === 'boolean')
            );

        default:
            return false;
    }
}

// API adapter interface (replaces @proton/shared/lib/interfaces Api)
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
}
