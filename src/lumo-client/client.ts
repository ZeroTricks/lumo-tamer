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
import { getCommandsConfig, getLogConfig } from '../app/config.js';

export interface LumoClientOptions {
    enableExternalTools?: boolean;
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
}

const DEFAULT_INTERNAL_TOOLS: ToolName[] = ['proton_info'];
const DEFAULT_EXTERNAL_TOOLS: ToolName[] = ['web_search', 'weather', 'stock', 'cryptocurrency'];
const DEFAULT_ENDPOINT = 'ai/v1/chat';

export class LumoClient {
    constructor(private protonApi: ProtonApi) { }

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
        }
    ): Promise<ChatResult> {
        const reader = stream.getReader();
        const decoder = new TextDecoder('utf-8');
        const processor = new StreamProcessor();
        let fullResponse = '';
        let fullTitle = '';

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
                    onChunk?.(content);
                } else if (msg.target === 'title') {
                    // Accumulate title chunks (title streams before message)
                    fullTitle += content;
                }
            } else if (
                msg.type === 'error' ||
                msg.type === 'rejected' ||
                msg.type === 'harmful' ||
                msg.type === 'timeout'
            ) {
                throw new Error(`API returned error: ${msg.type}`);
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
            }

            // Process any remaining data
            const finalMessages = processor.finalize();
            for (const msg of finalMessages) {
                await processMessage(msg);
            }

            return {
                response: fullResponse,
                title: fullTitle || undefined,
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
        options: LumoClientOptions = {}
    ): Promise<ChatResult> {
        const {
            enableExternalTools = false,
            enableEncryption = true,
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

        const tools: ToolName[] = enableExternalTools
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
        });

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

        return result;
    }
}
