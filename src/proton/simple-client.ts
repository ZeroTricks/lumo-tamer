/**
 * Simple Lumo API client for PoC
 * Minimal implementation with U2L encryption support
 */

import { decryptString } from './crypto.js';
import {
    encryptTurns,
    generateRequestId,
    generateRequestKey,
    prepareEncryptedRequestKey,
} from './encryption.js';
import { StreamProcessor } from './streaming.js';
import type {
    AesGcmCryptoKey,
    Api,
    GenerationToFrontendMessage,
    LumoApiGenerationRequest,
    RequestId,
    ToolName,
    Turn,
} from './types.js';

export interface SimpleLumoClientOptions {
    enableExternalTools?: boolean;
    enableEncryption?: boolean;
    endpoint?: string;
}

const DEFAULT_INTERNAL_TOOLS: ToolName[] = ['proton_info'];
const DEFAULT_EXTERNAL_TOOLS: ToolName[] = ['web_search', 'weather', 'stock', 'cryptocurrency'];
const DEFAULT_ENDPOINT = 'ai/v1/chat';

export class SimpleLumoClient {
    constructor(private api: Api) {}

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
        const {
            enableExternalTools = false,
            enableEncryption = true,
            endpoint = DEFAULT_ENDPOINT,
        } = options;

        const turns: Turn[] = [{ role: 'user', content: message }];

        // Determine tools to include
        const tools: ToolName[] = enableExternalTools
            ? [...DEFAULT_INTERNAL_TOOLS, ...DEFAULT_EXTERNAL_TOOLS]
            : DEFAULT_INTERNAL_TOOLS;

        // Setup encryption if enabled
        let requestKey: AesGcmCryptoKey | undefined;
        let requestId: RequestId | undefined;
        let processedTurns: Turn[] = turns;
        let requestKeyEncB64: string | undefined;

        if (enableEncryption) {
            requestKey = await generateRequestKey();
            requestId = generateRequestId();
            requestKeyEncB64 = await prepareEncryptedRequestKey(requestKey);
            processedTurns = await encryptTurns(turns, requestKey, requestId);
        }

        // Build request
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

        // Call API with streaming
        const stream = (await this.api({
            url: endpoint,
            method: 'post',
            data: payload,
            output: 'stream',
        })) as ReadableStream<Uint8Array>;

        return this.processStream(stream, onChunk, {
            enableEncryption,
            requestKey,
            requestId,
        });
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
        } = options;

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
            requestKeyEncB64 = await prepareEncryptedRequestKey(requestKey);
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

        const stream = (await this.api({
            url: endpoint,
            method: 'post',
            data: payload,
            output: 'stream',
        })) as ReadableStream<Uint8Array>;

        return this.processStream(stream, onChunk, {
            enableEncryption,
            requestKey,
            requestId,
        });
    }
}
