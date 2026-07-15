/**
 * Lumo 2.0 chat/completions request body builder.
 *
 * Mirrors the wire format produced by Proton's web client:
 * ProtonMail/WebClients applications/lumo/src/app/lib/lumo-api-client/core/chat-completions.ts
 * (toChatCompletionsBody / resolveChatModel / buildLumoExtension / serializeMessages).
 *
 * Kept as a small local adapter (rather than syncing the upstream parser, which
 * also carries image/legacy/tool-delta handling outside this project's scope).
 * Reuses the vendored encryption primitives unchanged; only the packaging differs
 * from the legacy generation_request path.
 */

import { Role, type Turn, type ToolName, type LumoModelTier } from './types.js';

export type { LumoModelTier };

/** Lumo 2.0 unified endpoint (replaces the legacy `ai/v1/chat`). */
export const LUMO_CHAT_ENDPOINT = 'ai/v1/chat/completions';

/** Which completion is requested; a title is a separate targeted completion. */
export type LumoCompletionTarget = 'message' | 'title';

/** Map a tier to the wire `model` value. `auto` -> `lumo` (Proton routes). */
export function resolveChatModel(tier: LumoModelTier): string {
    switch (tier) {
        case 'lumo-lite':
            return 'lumo-lite';
        case 'lumo-max':
            return 'lumo-max';
        default:
            return 'lumo';
    }
}

/** Map a Turn role to the chat/completions message role (see serializeMessages). */
function messageRole(role: Role): string {
    switch (role) {
        case Role.ToolResult:
            return 'tool';
        case Role.ToolCall:
            return 'lumo_tool_call';
        default:
            return role; // 'user' | 'assistant' | 'system' are already wire values
    }
}

export interface BuildChatBodyParams {
    /** Turns to send. Already encrypted when `encrypted` is true. */
    turns: Turn[];
    tier: LumoModelTier;
    /** Thinking mode: true -> reasoning_effort:'high', false -> 'none'. */
    enableReasoning: boolean;
    /** Native tool names to enable (e.g. proton_info, web_search). */
    tools?: ToolName[];
    /** Present when U2L encryption is on; folded into the `lumo` extension. */
    encryption?: { requestKeyEncB64: string; requestId: string };
    /** Whether `turns` carry encrypted content (sets message-level `encrypted`). */
    encrypted: boolean;
    /** Completion target; defaults to 'message'. 'title' requests a title. */
    target?: LumoCompletionTarget;
}

/** The `lumo` request extension (auth-independent metadata + encryption keys). */
export interface LumoExtension {
    client_type: 'frontend';
    target?: LumoCompletionTarget;
    request_key?: string;
    request_id?: string;
}

export interface ChatCompletionsBody {
    model: string;
    messages: Array<{ role: string; content: string; encrypted?: true }>;
    stream: true;
    stream_options: { include_usage: true };
    reasoning_effort: 'high' | 'none';
    tools?: Array<{ name: string }>;
    tool_choice?: 'auto';
    lumo: LumoExtension;
}

/** Build the POST body for `ai/v1/chat/completions`. */
export function buildChatCompletionsBody(params: BuildChatBodyParams): ChatCompletionsBody {
    const messages = params.turns.map((turn) => ({
        role: messageRole(turn.role),
        content: turn.content ?? '',
        ...(params.encrypted ? { encrypted: true as const } : {}),
    }));

    const lumo: LumoExtension = { client_type: 'frontend' };
    if (params.target) {
        lumo.target = params.target;
    }
    if (params.encryption) {
        lumo.request_key = params.encryption.requestKeyEncB64;
        lumo.request_id = params.encryption.requestId;
    }

    const body: ChatCompletionsBody = {
        model: resolveChatModel(params.tier),
        messages,
        stream: true,
        stream_options: { include_usage: true },
        reasoning_effort: params.enableReasoning ? 'high' : 'none',
        lumo,
    };

    if (params.tools && params.tools.length > 0) {
        body.tools = params.tools.map((name) => ({ name }));
        body.tool_choice = 'auto';
    }

    return body;
}
