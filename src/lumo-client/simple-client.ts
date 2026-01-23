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
import { logger } from '../logger.js';
import type {
    AesGcmCryptoKey,
    ProtonApi,
    GenerationToFrontendMessage,
    LumoApiGenerationRequest,
    RequestId,
    ToolName,
    Turn,
} from './types.js';
import { executeCommand, isCommand, type CommandContext } from '../commands.js';

export interface SimpleLumoClientOptions {
    enableExternalTools?: boolean;
    enableEncryption?: boolean;
    endpoint?: string;
    commandContext?: CommandContext;
}

const DEFAULT_INTERNAL_TOOLS: ToolName[] = ['proton_info'];
const DEFAULT_EXTERNAL_TOOLS: ToolName[] = ['web_search', 'weather', 'stock', 'cryptocurrency'];
const DEFAULT_ENDPOINT = 'ai/v1/chat';

export class SimpleLumoClient {
    constructor(private protonApi: ProtonApi) { }

    /**
     * Send a message and stream the response
     * @param message - User message
     * @param onChunk - Optional callback for each text chunk
     * @param options - Request options
     * @returns Full response text
     */
    async chat(
        message: string,
        onChunk?: (content: string) => void,
        options: SimpleLumoClientOptions = {}
    ): Promise<string> {

        const turns: Turn[] = [{ role: 'user', content: message }];
        return this.chatWithHistory(turns, onChunk, options);

    }

    /**
     * Process SSE stream and extract response text
     */
    private async processStream(
        stream: ReadableStream<Uint8Array>,
        onChunk?: (content: string) => void,
        encryptionContext?: {
            enableEncryption: boolean;
            requestKey?: AesGcmCryptoKey;
            requestId?: RequestId;
        }
    ): Promise<string> {
        const reader = stream.getReader();
        const decoder = new TextDecoder('utf-8');
        const processor = new StreamProcessor();
        let fullResponse = '';

        const processMessage = async (msg: GenerationToFrontendMessage) => {
            if (msg.type === 'token_data' && msg.target === 'message') {
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

                fullResponse += content;
                onChunk?.(content);
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

            return fullResponse;
        } finally {
            reader.releaseLock();
        }
    }

    /**
     * Multi-turn conversation support
     */
    async chatWithHistory(
        turns: Turn[],
        onChunk?: (content: string) => void,
        options: SimpleLumoClientOptions = {}
    ): Promise<string> {
        const {
            enableExternalTools = false,
            enableEncryption = true,
            endpoint = DEFAULT_ENDPOINT,
            commandContext,
        } = options;

        const turn = turns[turns.length - 1];
        logger.info(`${turn.role}: ${turn.content && turn.content.length > 200
            ? turn.content.substring(0, 200) + '...'
            : turn.content
        } `);

        // NOTE: commands and command results will be present in turns
        if(turn.content && isCommand(turn.content)){
            const result = await executeCommand(turn.content, commandContext);
            logger.info(`Command received: ${turn.content}, response: ${result}`);

            if(onChunk)
                onChunk(result);
            return result;
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

        const request: LumoApiGenerationRequest = {
            type: 'generation_request',
            turns: processedTurns,
            options: { tools },
            targets: ['message'],
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

        const response = await this.processStream(stream, onChunk, {
            enableEncryption,
            requestKey,
            requestId,
        });

        // Log response
        const responsePreview = response.length > 200
            ? response.substring(0, 200) + '...'
            : response;
        logger.info({
            responseLength: response.length,
        }, '[LumoClient] Response received');
        logger.debug({ content: responsePreview }, '[LumoClient] Response content');

        return response;
    }
}
