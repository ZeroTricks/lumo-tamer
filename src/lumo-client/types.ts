/**
 * Local types for the Lumo client
 * Re-exports upstream types and adds local-only types
 */

// Re-export upstream types
export type {
    AesGcmCryptoKey,
    GenerationResponseMessage,
    LumoApiGenerationRequest,
    RequestId,
    ToolName,
    Turn,
} from '@lumo/lib/lumo-api-client/core/types.js';

export { Role } from '@lumo/types-api.js';

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
    // Local-only fields (not from Proton)
    isLocalOnly?: boolean;  // true if generated locally (cannot sync)
    createdAt?: string;     // ISO timestamp of key generation
}

// Cached master key structure (for persistence without lumo/v1/masterkeys scope)
export interface CachedMasterKey {
    ID: string;
    MasterKey: string;      // PGP-encrypted master key (base64)
    IsLatest: boolean;
    Version: number;
    // Local-only fields (not from Proton)
    isLocalOnly?: boolean;  // true if generated locally (cannot sync)
    createdAt?: string;     // ISO timestamp of key generation
}

// Persisted session metadata (from Proton localStorage ps-{localID})
// Note: keyPassword is now stored directly in StoredTokens, not encrypted here
export interface PersistedSessionData {
    localID: number;
    UserID: string;
    UID: string;
    persistedAt: number;
    // Legacy fields - only present in old vaults that need re-auth
    blob?: string;
    payloadVersion?: 1 | 2;
    clientKey?: string;
}

// Decrypted session blob structure (used during extraction only)
export interface DecryptedSessionBlob {
    keyPassword: string;        // The mailbox password
    type: 'default' | 'offline';
    offlineKeyPassword?: string;
}

// Native tool call types (parsed from Lumo SSE stream)

/** Parsed native tool call from SSE tool_call target. */
export interface ParsedToolCall {
    name: string;
    arguments: Record<string, unknown>;
}

/** Native tool call with optional result (for persistence). */
export interface NativeToolData {
    toolCall: ParsedToolCall;
    toolResult?: string;
}

/**
 * Assistant message data ready for persistence.
 * Matches MessagePrivate fields for assistant messages.
 */
export interface AssistantMessageData {
    content: string;
    /** JSON string of tool call (native tools only) */
    toolCall?: string;
    /** JSON string of tool result (native tools only) */
    toolResult?: string;
}

// LumoClient types

export interface LumoClientOptions {
    enableEncryption?: boolean;
    endpoint?: string;
    requestTitle?: boolean;
    /** Instructions to inject into user turn before sending to Lumo. */
    instructions?: string;
    /** Where to inject instructions: 'first' or 'last' user turn. Default: 'first'. */
    injectInstructionsInto?: 'first' | 'last';
}

/** Result from a chat request. */
export interface ChatResult {
    /** Assistant message data ready for persistence */
    message: AssistantMessageData;
    /** Generated conversation title (for new conversations) */
    title?: string;
    /** Whether the native tool call failed server-side (tool_result contained error) */
    nativeToolCallFailed?: boolean;
    /** Whether a misrouted custom tool was detected (routed through native SSE pipeline) */
    misrouted?: boolean;
    /**
     * Parsed native tool call (for bounce handling).
     * Only set when misrouted=true, used to build the bounce instruction.
     * @internal
     */
    _nativeToolCallForBounce?: ParsedToolCall;
}
