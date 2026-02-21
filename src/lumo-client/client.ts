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
import { getInstructionsConfig, getLogConfig, getConfigMode, getCustomToolsConfig, getEnableWebSearch } from '../app/config.js';
import { injectInstructionsIntoTurns } from '../app/instructions.js';
import { NativeToolCallProcessor } from '../api/tools/native-tool-call-processor.js';
import { postProcessTitle } from '../proton-shims/lumo-api-client-utils.js';
import type { ParsedToolCall } from '../api/tools/types.js';

export interface LumoClientOptions {
    enableEncryption?: boolean;
    endpoint?: string;
    requestTitle?: boolean;
    /** Instructions to inject into user turn before sending to Lumo. */
    instructions?: string;
    /** Where to inject instructions: 'first' or 'last' user turn. Default: 'first'. */
    injectInstructionsInto?: 'first' | 'last';
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
    /** Whether a misrouted custom tool was detected (routed through native SSE pipeline). */
    misrouted?: boolean;
}

const DEFAULT_INTERNAL_TOOLS: ToolName[] = ['proton_info'];
const DEFAULT_EXTERNAL_TOOLS: ToolName[] = ['web_search', 'weather', 'stock', 'cryptocurrency'];
const DEFAULT_ENDPOINT = 'ai/v1/chat';

/** Build the bounce instruction: config text + the misrouted tool call as JSON example.
 *  Includes the prefix in the example JSON so Lumo outputs it correctly. */
function buildBounceInstruction(toolCall: ParsedToolCall): string {
    const instruction = getInstructionsConfig().forToolBounce;

    // In server mode, add the prefix to the tool name in the example
    // (the tool name in toolCall has already been stripped, so we re-add it)
    let toolName = toolCall.name;
    if (getConfigMode() === 'server') {
        const prefix = getCustomToolsConfig().prefix;
        if (prefix && !toolName.startsWith(prefix)) {
            toolName = `${prefix}${toolName}`;
        }
    }

    const toolCallJson = JSON.stringify({ name: toolName, arguments: toolCall.arguments }, null, 2);
    return `${instruction}\n${toolCallJson}`;
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

        // Native tool call processing (SSE tool_call/tool_result targets)
        const nativeToolProcessor = new NativeToolCallProcessor(isBounce);
        let suppressChunks = false;
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
                        logger.error(error, 'Failed to decrypt chunk:');
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
                    if (nativeToolProcessor.feedToolCall(content)) {
                        suppressChunks = true;
                        abortEarly = true;
                    }
                } else if (msg.target === 'tool_result') {
                    nativeToolProcessor.feedToolResult(content);
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

            // Finalize tracking and get result
            nativeToolProcessor.finalize();
            const result = nativeToolProcessor.getResult();

            return {
                response: fullResponse,
                title: fullTitle || undefined,
                nativeToolCall: result.toolCall,
                nativeToolCallFailed: result.toolCall ? result.failed : undefined,
                misrouted: result.misrouted,
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
            requestTitle = false,
            instructions,
            injectInstructionsInto = 'first',
        } = options;

        const turn = turns[turns.length - 1];
        const logConfig = getLogConfig();

        if (logConfig.messageContent) {
            logger.info(`[${turn.role}] ${turn.content && turn.content.length > 200
                ? turn.content.substring(0, 200) + '...'
                : turn.content
                } `);
        }

        // Read from config - applies to both server and CLI modes
        const tools: ToolName[] = getEnableWebSearch()
            ? [...DEFAULT_INTERNAL_TOOLS, ...DEFAULT_EXTERNAL_TOOLS]
            : DEFAULT_INTERNAL_TOOLS;

        // Inject instructions into turns at the last moment (before encryption/API call)
        // This keeps stored conversations clean - instructions are transient, not persisted
        const turnsWithInstructions = instructions
            ? injectInstructionsIntoTurns(turns, instructions, injectInstructionsInto)
            : turns;

        let requestKey: AesGcmCryptoKey | undefined;
        let requestId: RequestId | undefined;
        let processedTurns: Turn[] = turnsWithInstructions;
        let requestKeyEncB64: string | undefined;

        if (enableEncryption) {
            requestKey = await generateRequestKey();
            requestId = generateRequestId();
            requestKeyEncB64 = await prepareEncryptedRequestKey(requestKey, DEFAULT_LUMO_PUB_KEY);
            processedTurns = await encryptTurns(turnsWithInstructions, requestKey, requestId);
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

        // Bounce misrouted tool calls: ask Lumo to re-output as JSON text
        if (!isBounce && result.misrouted && result.nativeToolCall) {
            const bounceInstruction = buildBounceInstruction(result.nativeToolCall);
            logger.info({ tool: result.nativeToolCall.name }, 'Bouncing misrouted tool call');

            const bounceTurns: Turn[] = [
                ...turns,
                { role: 'assistant', content: result.response },
                { role: 'user', content: bounceInstruction },
            ];

            return this.chatWithHistory(bounceTurns, onChunk, options, true);
        }

        // Post-process title (remove quotes, trim, limit length)
        return {
            ...result,
            title: result.title ? postProcessTitle(result.title) : undefined,
        };
    }
}
