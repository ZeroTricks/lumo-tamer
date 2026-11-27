/**
 * Lumo 2.0 chat/completions request body builder.
 *
 * Mirrors the wire format produced by Proton's web client:
 * ProtonMail/WebClients packages/lumo-api-client/core/chat-completions.ts
 * (toChatCompletionsBody / resolveChatModel / buildLumoExtension / serializeMessages /
 * toImagePart / inferImageMimeType).
 *
 * Kept as a small local adapter (rather than syncing the upstream builder, which
 * also carries client-tool/response-format/feature-flag handling outside this
 * project's scope). Reuses the vendored encryption primitives unchanged; only the
 * packaging differs from the legacy generation_request path.
 */

import { Role, type Turn, type ToolName, type LumoModelTier, type WireImage } from './types.js';

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

/** OpenAI text content part; `encrypted` marks U2L ciphertext (Lumo extension). */
export interface ChatTextPart {
    type: 'text';
    text: string;
    encrypted?: true;
}

/** OpenAI image content part; `encrypted` marks U2L ciphertext (Lumo extension). */
export interface ChatImagePart {
    type: 'image_url';
    image_url: {
        url: string;
        encrypted?: true;
    };
}

export type ChatContentPart = ChatTextPart | ChatImagePart;

export interface ChatMessage {
    role: string;
    /** String for text-only turns; content parts for turns carrying images. */
    content: string | ChatContentPart[];
    encrypted?: true;
}

export interface ChatCompletionsBody {
    model: string;
    messages: ChatMessage[];
    stream: true;
    stream_options: { include_usage: true };
    reasoning_effort: 'high' | 'none';
    tools?: Array<{ name: string }>;
    tool_choice?: 'auto';
    lumo: LumoExtension;
}

/**
 * Infer an image's MIME type from the magic bytes encoded at the start of its
 * base64 payload. WireImage carries no MIME type, but a valid OpenAI data URL
 * needs one. Falls back to image/png (same as upstream).
 */
export function inferImageMimeType(base64: string): string {
    if (base64.startsWith('iVBORw0KGgo')) return 'image/png';
    if (base64.startsWith('/9j/')) return 'image/jpeg';
    if (base64.startsWith('R0lGOD')) return 'image/gif';
    if (base64.startsWith('UklGR')) return 'image/webp'; // RIFF container (WebP)
    if (base64.startsWith('Qk')) return 'image/bmp';
    // ISO BMFF (HEIC/HEIF): "ftyp" box at byte offset 4; decode the first 12 bytes.
    const head = Buffer.from(base64.slice(0, 16), 'base64');
    if (head.length >= 12 && head.subarray(4, 8).toString('latin1') === 'ftyp') {
        const brand = head.subarray(8, 12).toString('latin1').toLowerCase();
        return brand === 'mif1' || brand === 'msf1' ? 'image/heif' : 'image/heic';
    }
    return 'image/png';
}

/**
 * Convert a WireImage into an OpenAI `image_url` content part.
 *
 * The `url` is always a `data:<mime>;base64,...` URL. For an encrypted image the
 * payload is U2L ciphertext so a generic `application/octet-stream` MIME is used;
 * encryption is additionally signalled by `image_url.encrypted` as a sibling to `url`.
 */
function toImagePart(image: WireImage): ChatImagePart {
    const mimeType = image.encrypted ? 'application/octet-stream' : inferImageMimeType(image.data);
    return {
        type: 'image_url',
        image_url: {
            url: `data:${mimeType};base64,${image.data}`,
            ...(image.encrypted ? { encrypted: true as const } : {}),
        },
    };
}

/** Serialize one turn into a chat/completions message (see upstream serializeMessages). */
function serializeTurn(turn: Turn, encrypted: boolean): ChatMessage {
    const role = messageRole(turn.role);
    const images = turn.images ?? [];

    // Text-only messages keep OpenAI's native string `content`. The Lumo
    // `encrypted` flag stays at the message level for this case.
    if (images.length === 0) {
        return {
            role,
            content: turn.content ?? '',
            ...(encrypted ? { encrypted: true as const } : {}),
        };
    }

    // Multimodal messages use OpenAI's content-parts array. Each part carries
    // its own `encrypted` flag as a sibling to the sensitive field. For
    // backward compatibility the message-level flag is set too.
    const parts: ChatContentPart[] = [];
    if (turn.content) {
        parts.push({ type: 'text', text: turn.content, ...(encrypted ? { encrypted: true as const } : {}) });
    }
    for (const image of images) {
        parts.push(toImagePart(image));
    }
    const anyEncrypted = encrypted || images.some((image) => image.encrypted);
    return { role, content: parts, ...(anyEncrypted ? { encrypted: true as const } : {}) };
}

/** Build the POST body for `ai/v1/chat/completions`. */
export function buildChatCompletionsBody(params: BuildChatBodyParams): ChatCompletionsBody {
    const messages = params.turns.map((turn) => serializeTurn(turn, params.encrypted));

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
