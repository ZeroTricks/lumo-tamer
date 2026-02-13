/**
 * Simple Lumo API client
 * Minimal implementation with U2L encryption support
 */

import { decryptString } from '../proton-upstream/crypto/index.js';
import {
    DEFAULT_LUMO_PUB_KEY,
    encryptTurns,
    generateRequestId,
    generateRequestKey,
    prepareEncryptedRequestKey,
} from '../proton-upstream/lib/lumo-api-client/core/encryption.js';
import { StreamProcessor } from '../proton-upstream/lib/lumo-api-client/core/streaming.js';
import { logger } from '../app/logger.js';
import type {
    AesGcmCryptoKey,
    ProtonApi,
    GenerationToFrontendMessage,
    LumoApiGenerationRequest,
    RequestId,
    ToolName,
    Turn,
} from './types.js';
import { executeCommand, isCommand, type CommandContext } from '../app/commands.js';
import { getCommandsConfig, getLogConfig, getCustomToolsConfig, getEnableWebSearch } from '../app/config.js';
import { JsonBraceTracker } from '../api/tools/json-brace-tracker.js';
import { parseNativeToolCallJson, isErrorResult } from '../api/tools/native-tool-parser.js';
import { stripToolPrefix } from '../api/tools/prefix.js';
import { getMetrics } from '../api/metrics/index.js';
import type { ParsedToolCall } from '../api/tools/types.js';

export interface LumoClientOptions {
    enableEncryption?: boolean;
    endpoint?: string;
    commandContext?: CommandContext;
    requestTitle?: boolean;
}

/**
 * Result from a chat request, including optional generated title
 */
export interface ChatResult {
    response: string;
    title?: string;
    /** First valid native tool call from SSE tool_call target, if any.
     *  "Native" here means Lumo-native SSE pipeline - this includes both legitimate
     *  native calls (e.g. web_search) and "misrouted" calls (custom tools Lumo
     *  mistakenly routed through the native pipeline). */
    nativeToolCall?: ParsedToolCall;
    /** Whether the native tool call failed server-side (tool_result contained error). */
    nativeToolCallFailed?: boolean;
}

const DEFAULT_INTERNAL_TOOLS: ToolName[] = ['proton_info'];
const DEFAULT_EXTERNAL_TOOLS: ToolName[] = ['web_search', 'weather', 'stock', 'cryptocurrency'];
const KNOWN_NATIVE_TOOLS = new Set<string>([...DEFAULT_INTERNAL_TOOLS, ...DEFAULT_EXTERNAL_TOOLS]);
const DEFAULT_ENDPOINT = 'ai/v1/chat';

/** A misrouted tool call is a custom tool Lumo mistakenly routed through its native SSE pipeline. */
function isMisroutedToolCall(toolCall: ParsedToolCall | undefined): boolean {
    return !!toolCall && !KNOWN_NATIVE_TOOLS.has(toolCall.name);
}

/** Build a custom-tool JSON payload that the server-side detector can parse. */
function buildCustomToolJson(toolCall: ParsedToolCall): string {
    const prefix = getCustomToolsConfig().prefix;
    const strippedName = stripToolPrefix(toolCall.name, prefix);
    return JSON.stringify({ name: strippedName, arguments: toolCall.arguments }, null, 2);
}

export class LumoClient {
    constructor(
        private protonApi: ProtonApi,
        private defaultOptions?: Partial<LumoClientOptions>,
    ) { }

    /**
     * Send a message and stream the response
     * @param message - User message
     * @param onChunk - Optional callback for each text chunk
     * @param options - Request options
     * @returns ChatResult with response text and optional title
     */
    async chat(
        message: string,
        onChunk?: (content: string) => void,
        options: LumoClientOptions = {}
    ): Promise<ChatResult> {

        const turns: Turn[] = [{ role: 'user', content: message }];
        return this.chatWithHistory(turns, onChunk, options);

    }

    /**
     * Process SSE stream and extract response text and optional title
     *
     * Title generation inspired by WebClients redux.ts lines 49-110
     */
    private async processStream(
        stream: ReadableStream<Uint8Array>,
        onChunk?: (content: string) => void,
        encryptionContext?: {
            enableEncryption: boolean;
            requestKey?: AesGcmCryptoKey;
            requestId?: RequestId;
        },
        /** When true, ignore misrouted tool calls (they're stale leftovers in bounce responses). */
        isBounce = false,
    ): Promise<ChatResult> {
        const reader = stream.getReader();
        const decoder = new TextDecoder('utf-8');
        const processor = new StreamProcessor();
        let fullResponse = '';
        let fullTitle = '';

        // Native tool call tracking (SSE tool_call/tool_result targets)
        const toolCallTracker = new JsonBraceTracker();
        const toolResultTracker = new JsonBraceTracker();
        let firstNativeToolCall: ParsedToolCall | null = null;
        let nativeToolCallFailed = false;
        // Suppress onChunk when a custom tool call is detected in native SSE stream
        let suppressChunks = false;
        // Signal to break read loop early once we have a native custom tool call
        let abortEarly = false;

        const processMessage = async (msg: GenerationToFrontendMessage) => {
            if (msg.type === 'token_data') {
                let content = msg.content;

                // Decrypt if needed
                if (
                    msg.encrypted &&
                    encryptionContext?.enableEncryption &&
                    encryptionContext.requestKey &&
                    encryptionContext.requestId
                ) {
                    const adString = `lumo.response.${encryptionContext.requestId}.chunk`;
                    try {
                        content = await decryptString(
                            content,
                            encryptionContext.requestKey,
                            adString
                        );
                    } catch (error) {
                        console.error('Failed to decrypt chunk:', error);
                        // Continue with encrypted content
                    }
                }

                if (msg.target === 'message') {
                    fullResponse += content;
                    if (!suppressChunks) {
                        onChunk?.(content);
                    }
                } else if (msg.target === 'title') {
                    // Accumulate title chunks (title streams before message)
                    fullTitle += content;
                } else if (msg.target === 'tool_call') {
                    for (const json of toolCallTracker.feed(content)) {
                        if (!firstNativeToolCall) {
                            firstNativeToolCall = parseNativeToolCallJson(json);
                            if (firstNativeToolCall) {
                                if (isMisroutedToolCall(firstNativeToolCall) && !isBounce) {
                                    // Treat native custom-tool calls as first-class, then convert to
                                    // our JSON tool-call text format for downstream compatibility.
                                    suppressChunks = true;
                                    abortEarly = true;
                                    const strippedName = stripToolPrefix(firstNativeToolCall.name, getCustomToolsConfig().prefix);
                                    getMetrics()?.toolCallsTotal.inc({ type: 'custom', status: 'misrouted', tool_name: strippedName });
                                    logger.debug({
                                        tool: firstNativeToolCall.name,
                                        partialResponse: fullResponse
                                    }, 'Native custom tool call detected; converting to JSON tool call');
                                } else {
                                    logger.debug({ raw: json }, 'Native SSE tool_call');
                                    // Native tool calls are tracked on completion (success/failed)
                                }
                            }
                        }
                    }
                } else if (msg.target === 'tool_result') {
                    for (const json of toolResultTracker.feed(content)) {
                        logger.debug({ raw: json }, 'Native SSE tool_result');
                        if (firstNativeToolCall && !nativeToolCallFailed && isErrorResult(json)) {
                            nativeToolCallFailed = true;
                        }
                    }
                }
            } else if (
                msg.type === 'error' ||
                msg.type === 'rejected' ||
                msg.type === 'harmful' ||
                msg.type === 'timeout'
            ) {
                const detail = (msg as any).message;
                throw new Error(`API returned ${msg.type}${detail ? `: ${detail}` : ''}`);
            }
        };

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value, { stream: true });
                const messages = processor.processChunk(chunk);

                for (const msg of messages) {
                    await processMessage(msg);
                }
                if (abortEarly) break;
            }

            // Process any remaining data
            const finalMessages = processor.finalize();
            for (const msg of finalMessages) {
                await processMessage(msg);
            }

            // If native SSE carried a custom tool call, synthesize JSON text for the
            // existing server-side detector path (backward-compatible with current pipeline).
            if (firstNativeToolCall && abortEarly && isMisroutedToolCall(firstNativeToolCall) && !isBounce) {
                const toolJson = buildCustomToolJson(firstNativeToolCall);
                const synthesized = `\`\`\`json\n${toolJson}\n\`\`\``;
                fullResponse = synthesized;
                onChunk?.(synthesized);
            }

            // Track native tool call completion (but not if misrouted - already tracked as custom/misrouted)
            if (firstNativeToolCall && !abortEarly) {
                const toolCall = firstNativeToolCall as ParsedToolCall;
                logger.debug({ toolCall, failed: nativeToolCallFailed }, 'Lumo native tool call');
                // Track tool call success/failure
                if (nativeToolCallFailed) {
                    getMetrics()?.toolCallsTotal.inc({ type: 'native', status: 'failed', tool_name: toolCall.name });
                } else {
                    getMetrics()?.toolCallsTotal.inc({ type: 'native', status: 'success', tool_name: toolCall.name });
                }
            }

            return {
                response: fullResponse,
                title: fullTitle || undefined,
                nativeToolCall: firstNativeToolCall ?? undefined,
                nativeToolCallFailed: firstNativeToolCall ? nativeToolCallFailed : undefined,
            };
        } finally {
            reader.releaseLock();
        }
    }

    /**
     * Multi-turn conversation support
     *
     * Title generation inspired by WebClients helper.ts:596 and client.ts:110
     */
    async chatWithHistory(
        turns: Turn[],
        onChunk?: (content: string) => void,
        options: LumoClientOptions = {},
        /** Internal: prevents infinite bounce loops. Do not set externally. */
        isBounce = false,
    ): Promise<ChatResult> {
        const {
            enableEncryption = this.defaultOptions?.enableEncryption ?? true,
            endpoint = DEFAULT_ENDPOINT,
            commandContext,
            requestTitle = false,
        } = options;

        const turn = turns[turns.length - 1];
        const logConfig = getLogConfig();

        if (logConfig.messageContent) {
            logger.info(`[${turn.role}] ${turn.content && turn.content.length > 200
                ? turn.content.substring(0, 200) + '...'
                : turn.content
                } `);
        }

        // NOTE: commands and command results will be present in turns
        if (turn.content && isCommand(turn.content)) {
            const commandsConfig = getCommandsConfig();
            if (commandsConfig.enabled) {
                const result = await executeCommand(turn.content, commandContext);
                logger.info(`Command received: ${turn.content}, response: ${result}`);

                if (onChunk)
                    onChunk(result);
                return { response: result };
            } else {
                logger.debug({ command: turn.content }, 'Command ignored (commands.enabled=false)');
                // Fall through - treat as regular message, send to Lumo
            }
        }

        // Read from config - applies to both server and CLI modes
        const tools: ToolName[] = getEnableWebSearch()
            ? [...DEFAULT_INTERNAL_TOOLS, ...DEFAULT_EXTERNAL_TOOLS]
            : DEFAULT_INTERNAL_TOOLS;

        let requestKey: AesGcmCryptoKey | undefined;
        let requestId: RequestId | undefined;
        let processedTurns: Turn[] = turns;
        let requestKeyEncB64: string | undefined;

        if (enableEncryption) {
            requestKey = await generateRequestKey();
            requestId = generateRequestId();
            requestKeyEncB64 = await prepareEncryptedRequestKey(requestKey, DEFAULT_LUMO_PUB_KEY);
            processedTurns = await encryptTurns(turns, requestKey, requestId);
        }

        // Request title alongside message for new conversations
        // See WebClients client.ts:110: targets = requestTitle ? ['title', 'message'] : ['message']
        const targets: Array<'title' | 'message'> = requestTitle ? ['title', 'message'] : ['message'];

        const request: LumoApiGenerationRequest = {
            type: 'generation_request',
            turns: processedTurns,
            options: { tools },
            targets,
            ...(enableEncryption && requestKeyEncB64 && requestId
                ? {
                    request_key: requestKeyEncB64,
                    request_id: requestId,
                }
                : {}),
        };

        const payload = { Prompt: request };

        const stream = (await this.protonApi({
            url: endpoint,
            method: 'post',
            data: payload,
            output: 'stream',
        })) as ReadableStream<Uint8Array>;

        const result = await this.processStream(stream, onChunk, {
            enableEncryption,
            requestKey,
            requestId,
        }, isBounce);

        // Log response
        const responsePreview = result.response.length > 200
            ? result.response.substring(0, 200) + '...'
            : result.response;

        if (logConfig.messageContent) {
            logger.info(`[Lumo] ${responsePreview}`);
            if (result.title) {
                logger.debug({ title: result.title }, 'Generated title');
            }
        }

        // Native custom-tool calls are converted during stream processing; no bounce loop.

        return result;
    }
}
