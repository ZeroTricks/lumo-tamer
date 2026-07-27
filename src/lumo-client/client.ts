/**
 * Lumo API client (Lumo 2.0).
 *
 * Talks to Proton's unified `ai/v1/chat/completions` endpoint with optional U2L
 * encryption, streams the OpenAI-style SSE response, surfaces reasoning/thinking,
 * detects native tool calls, and bounces misrouted custom tools.
 */

import { decryptString } from '@lumo/crypto/index.js';
import {
    DEFAULT_LUMO_PUB_KEY,
    encryptTurns,
} from '@lumo/lib/lumo-api-client/core/encryption.js';
import {
    generateRequestId,
    generateRequestKey,
    RequestEncryptionParams,
} from '@lumo/lib/lumo-api-client/core/encryptionParams.js';
import { logger } from '../app/logger.js';
import {
    Role,
    type AesGcmCryptoKey,
    type ProtonApi,
    type RequestId,
    type ToolName,
    type Turn,
    type ParsedToolCall,
    type AssistantMessageData,
    type LumoClientOptions,
    type LumoModelTier,
    type LumoUsage,
    type ChatResult,
} from './types.js';
import { buildChatCompletionsBody, LUMO_CHAT_ENDPOINT, type LumoCompletionTarget } from './v2-body.js';
import { V2StreamProcessor } from './v2-stream.js';
import { getInstructionsConfig, getLogConfig, getConfigMode, getCustomToolsConfig, getEnableWebSearch } from '../app/config.js';
import { injectInstructionsIntoTurns } from './instructions.js';
import { NativeToolCallProcessor, type NativeToolCallResult } from '../api/tools/native-tool-call-processor.js';
import { postProcessTitle } from '@lumo/lib/lumo-api-client/utils.js';

// Re-export types for external consumers
export type { LumoClientOptions, ChatResult };

const DEFAULT_INTERNAL_TOOLS: ToolName[] = ['proton_info'];
const DEFAULT_EXTERNAL_TOOLS: ToolName[] = ['web_search', 'weather', 'stock', 'cryptocurrency'];

/** Encryption context for decrypting a response stream. */
interface EncryptionContext {
    requestKey: AesGcmCryptoKey;
    requestId: RequestId;
}

/** Raw result of a single chat/completions request. */
interface CompletionResult {
    content: string;
    reasoning: string;
    usage?: LumoUsage;
    native: NativeToolCallResult;
}

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
     */
    async chat(
        message: string,
        onChunk?: (content: string) => void,
        options: LumoClientOptions = {}
    ): Promise<ChatResult> {
        const turns: Turn[] = [{ role: Role.User, content: message }];
        return this.chatWithHistory(turns, onChunk, options);
    }

    /**
     * Process the OpenAI-style SSE stream: decrypt content/reasoning, drain
     * reasoning to its sink, feed native tool calls/results, capture usage.
     */
    private async processStream(
        stream: ReadableStream<Uint8Array>,
        encryptionContext: EncryptionContext | undefined,
        opts: {
            onChunk?: (content: string) => void;
            onReasoning?: (content: string) => void;
            isBounce: boolean;
        },
    ): Promise<CompletionResult> {
        const reader = stream.getReader();
        const decoder = new TextDecoder('utf-8');
        const processor = new V2StreamProcessor();
        const nativeToolProcessor = new NativeToolCallProcessor(opts.isBounce);

        let content = '';
        let reasoning = '';
        let usage: LumoUsage | undefined;
        let suppressChunks = false;
        let abortEarly = false;
        let streamEnded = false;

        // Decrypt an encrypted chunk. On failure, return null so the caller drops
        // the chunk (matching Proton's client) rather than emitting ciphertext.
        const decrypt = async (text: string, encrypted?: boolean): Promise<string | null> => {
            if (encrypted && encryptionContext) {
                const adString = `lumo.response.${encryptionContext.requestId}.chunk`;
                try {
                    return await decryptString(text, encryptionContext.requestKey, adString);
                } catch (error) {
                    logger.error({ error }, 'Failed to decrypt chunk; dropping');
                    return null;
                }
            }
            return text;
        };

        const processMessage = async (msg: ReturnType<V2StreamProcessor['processChunk']>[number]) => {
            switch (msg.type) {
                case 'token_data': {
                    if (msg.target === 'message') {
                        const text = await decrypt(msg.content, msg.encrypted);
                        if (text === null) break;
                        content += text;
                        if (!suppressChunks) {
                            opts.onChunk?.(text);
                        }
                    } else if (msg.target === 'reasoning') {
                        const text = await decrypt(msg.content, msg.encrypted);
                        if (text === null) break;
                        reasoning += text;
                        opts.onReasoning?.(text);
                    } else if (msg.target === 'tool_call') {
                        // Complete tool call (custom-tool misroute path); emitted by finalize().
                        if (nativeToolProcessor.feedToolCall(msg.content)) {
                            suppressChunks = true;
                            abortEarly = true;
                        }
                    }
                    break;
                }
                case 'server_tool_call': {
                    // Native tool call (e.g. proton_info); normalize into the tool processor.
                    const args = msg.arguments !== undefined ? await decrypt(msg.arguments, msg.encrypted) : '';
                    if (args === null) break;
                    let parsedArgs: unknown = {};
                    try {
                        parsedArgs = args ? JSON.parse(args) : {};
                    } catch {
                        parsedArgs = args;
                    }
                    const json = JSON.stringify({ name: msg.name, arguments: parsedArgs });
                    if (nativeToolProcessor.feedToolCall(json)) {
                        suppressChunks = true;
                        abortEarly = true;
                    }
                    break;
                }
                case 'server_tool_result': {
                    const result = await decrypt(msg.content, msg.encrypted);
                    if (result === null) break;
                    nativeToolProcessor.feedToolResult(result);
                    break;
                }
                case 'usage':
                    usage = msg.usage;
                    break;
                case 'harmful':
                    throw new Error('API returned harmful');
                case 'error':
                    throw new Error(`API returned error${msg.message ? `: ${msg.message}` : ''}`);
                case 'done':
                    abortEarly = true;
                    break;
            }
        };

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    streamEnded = true;
                    break;
                }
                const chunk = decoder.decode(value, { stream: true });
                for (const msg of processor.processChunk(chunk)) {
                    await processMessage(msg);
                }
                if (abortEarly) break;
            }
            // Flush the decoder and any trailing buffered line + accumulated tool calls.
            const tail = decoder.decode();
            if (tail) {
                for (const msg of processor.processChunk(tail)) {
                    await processMessage(msg);
                }
            }
            for (const msg of processor.finalize()) {
                await processMessage(msg);
            }

            nativeToolProcessor.finalize();
            return { content, reasoning, usage, native: nativeToolProcessor.getResult() };
        } finally {
            // Cancel the upstream body if we stopped early (e.g. misrouted-tool abort).
            if (!streamEnded) {
                try {
                    await reader.cancel();
                } catch {
                    // ignore
                }
            }
            try {
                reader.releaseLock();
            } catch {
                // ignore
            }
        }
    }

    /** Encrypt (optionally), build the body, POST, and process one completion. */
    private async runCompletion(
        turns: Turn[],
        params: {
            endpoint: string;
            tier: LumoModelTier;
            enableReasoning: boolean;
            tools: ToolName[];
            enableEncryption: boolean;
            target: LumoCompletionTarget;
            onChunk?: (content: string) => void;
            onReasoning?: (content: string) => void;
            isBounce: boolean;
        },
    ): Promise<CompletionResult> {
        let processedTurns = turns;
        let encryption: { requestKeyEncB64: string; requestId: string } | undefined;
        let encryptionContext: EncryptionContext | undefined;

        if (params.enableEncryption) {
            const requestKey = await generateRequestKey();
            const requestId = generateRequestId();
            const encryptionParams = new RequestEncryptionParams(requestKey, requestId);
            const requestKeyEncB64 = await encryptionParams.encryptRequestKey(DEFAULT_LUMO_PUB_KEY);
            processedTurns = await encryptTurns(turns, encryptionParams);
            encryption = { requestKeyEncB64, requestId: encryptionParams.requestId };
            encryptionContext = { requestKey: encryptionParams.requestKey, requestId: encryptionParams.requestId };
        }

        const body = buildChatCompletionsBody({
            turns: processedTurns,
            tier: params.tier,
            enableReasoning: params.enableReasoning,
            tools: params.tools,
            encryption,
            encrypted: params.enableEncryption,
            target: params.target,
        });

        const stream = (await this.protonApi({
            url: params.endpoint,
            method: 'post',
            data: body,
            output: 'stream',
        })) as ReadableStream<Uint8Array>;

        return this.processStream(stream, encryptionContext, {
            onChunk: params.onChunk,
            onReasoning: params.onReasoning,
            isBounce: params.isBounce,
        });
    }

    /**
     * Multi-turn conversation support.
     *
     * Titles use a separate `lumo.target:'title'` completion (Lumo 2.0 no longer
     * co-streams title with the message); it runs concurrently and is non-fatal.
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
            endpoint = LUMO_CHAT_ENDPOINT,
            requestTitle = false,
            instructions,
            injectInstructionsInto = 'first',
            modelTier = this.defaultOptions?.modelTier ?? 'auto',
            enableReasoning = this.defaultOptions?.enableReasoning ?? false,
            onReasoning = this.defaultOptions?.onReasoning,
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

        // Inject instructions at the last moment (kept out of persisted turns).
        const turnsWithInstructions = instructions
            ? injectInstructionsIntoTurns(turns, instructions, injectInstructionsInto)
            : turns;

        // Title generation is a separate, concurrent, non-fatal completion.
        // Only at the top level: a bounce must not launch its own title request.
        const titlePromise = requestTitle && !isBounce
            ? this.runCompletion(turns, {
                endpoint,
                tier: modelTier,
                enableReasoning: false,
                tools: [],
                enableEncryption,
                target: 'title',
                isBounce: true, // no bounce handling for the title request
            }).catch((error) => {
                logger.warn({ error }, 'Title generation failed');
                return null;
            })
            : null;

        const main = await this.runCompletion(turnsWithInstructions, {
            endpoint,
            tier: modelTier,
            enableReasoning,
            tools,
            enableEncryption,
            target: 'message',
            onChunk,
            onReasoning,
            isBounce,
        });

        if (logConfig.messageContent) {
            const responsePreview = main.content.length > 200
                ? main.content.substring(0, 200) + '...'
                : main.content;
            logger.info(`[Lumo] ${responsePreview}`);
        }

        // Bounce misrouted tool calls: ask Lumo to re-output as JSON text.
        if (!isBounce && main.native.misrouted && main.native.toolCall) {
            const bounceInstruction = buildBounceInstruction(main.native.toolCall);
            logger.info({ tool: main.native.toolCall.name }, 'Bouncing misrouted tool call');

            const bounceTurns: Turn[] = [
                ...turns,
                { role: Role.Assistant, content: main.content },
                { role: Role.User, content: bounceInstruction },
            ];

            // The bounce runs with isBounce=true (no title of its own); carry the
            // title from this top-level attempt so it isn't wasted or re-derived
            // from the synthetic bounce transcript.
            const bounced = await this.chatWithHistory(bounceTurns, onChunk, options, true);
            const titleResult = titlePromise ? await titlePromise : null;
            const title = titleResult?.content ? postProcessTitle(titleResult.content) : bounced.title;
            return { ...bounced, title };
        }

        // Build message data for persistence.
        const message: AssistantMessageData = { content: main.content };
        if (main.native.toolCall && !main.native.misrouted) {
            message.toolCall = JSON.stringify({
                name: main.native.toolCall.name,
                arguments: main.native.toolCall.arguments,
            });
            if (main.native.toolResult) {
                message.toolResult = main.native.toolResult;
            }
        }

        const titleResult = titlePromise ? await titlePromise : null;
        const title = titleResult?.content ? postProcessTitle(titleResult.content) : undefined;

        return {
            message,
            reasoning: main.reasoning || undefined,
            usage: main.usage,
            title,
            nativeToolCallFailed: main.native.toolCall ? main.native.failed : undefined,
            misrouted: main.native.misrouted,
        };
    }
}
