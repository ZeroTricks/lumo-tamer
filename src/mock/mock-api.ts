/**
 * Mock ProtonApi - returns simulated SSE streams for development/testing
 *
 * Scenario generators adapted from:
 *   Proton WebClients applications/lumo/src/app/mocks/handlers.ts
 *
 * The upstream file can't be pulled 1:1 into proton-upstream/ because:
 * - It depends on MSW (Mock Service Worker) for HTTP interception (`{ HttpResponse, http }` from 'msw')
 * - Handler registration targets a browser-specific URL (https://ml-labs.protontech.ch/...)
 * - Its mockConfig.ts uses browser `window` global for runtime scenario switching
 *
 * We only reuse the scenario logic (the async generators and SSE message format),
 * wrapped in a ProtonApi-compatible function. LumoClient doesn't care whether the
 * ProtonApi is real or mock - it just reads the returned ReadableStream.
 */

import type { ProtonApi, ProtonApiOptions } from '../lumo-client/types.js';
import type { MockConfig } from '../app/config.js';
import { logger } from '../app/logger.js';

type Scenario = MockConfig['scenario'];

const formatSSEMessage = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function createStream(generator: () => AsyncGenerator<string>): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream({
        async start(controller) {
            try {
                for await (const chunk of generator()) {
                    controller.enqueue(encoder.encode(chunk));
                }
                controller.close();
            } catch (error) {
                controller.error(error);
            }
        },
    });
}

// Scenario generators (from Proton WebClients handlers.ts)
const scenarios: Record<Exclude<Scenario, 'weeklyLimit'>, () => AsyncGenerator<string>> = {
    success: async function* () {
        yield formatSSEMessage({ type: 'ingesting', target: 'message' });
        await delay(300);

        for (let i = 0; i < 5; i++) {
            yield formatSSEMessage({ type: 'token_data', target: 'message', count: i, content: '' });
            await delay(40);
        }

        const tokens = [
            '(Mocked) ', 'Why ', "don't ", 'prog', 'rammers ', 'like ',
            'nat', 'ure', '? ', 'They ', 'have ', 'too ', 'many ', 'bu', 'gs!',
        ];

        for (let i = 0; i < tokens.length; i++) {
            yield formatSSEMessage({ type: 'token_data', target: 'message', count: i + 5, content: tokens[i] });
            await delay(40);
        }

        yield formatSSEMessage({ type: 'done' });
    },

    error: async function* () {
        await delay(400);
        yield formatSSEMessage({ type: 'error', message: 'Test error message' });
    },

    timeout: async function* () {
        await delay(400);
        yield formatSSEMessage({ type: 'timeout', message: 'High demand error' });
    },

    rejected: async function* () {
        await delay(400);
        yield formatSSEMessage({ type: 'rejected' });
    },

    toolCall: async function* () {
        yield formatSSEMessage({ type: 'ingesting', target: 'message' });
        await delay(400);

        yield formatSSEMessage({
            type: 'token_data',
            target: 'tool_call',
            content: '{"name": "web_search", "parameters": {"search_term": "test search"}}',
        });
        await delay(500);

        yield formatSSEMessage({
            type: 'token_data',
            target: 'tool_result',
            content: 'Mock search result data',
        });
        await delay(300);

        const tokens = [
            'Based ', 'on ', 'the ', 'search ', 'results', ', ',
            'here ', 'is ', 'what ', 'I ', 'found', '.',
        ];

        for (let i = 0; i < tokens.length; i++) {
            yield formatSSEMessage({ type: 'token_data', target: 'message', count: i, content: tokens[i] });
            await delay(40);
        }

        yield formatSSEMessage({ type: 'done' });
    },
};

/**
 * Create a mock ProtonApi function that returns simulated SSE streams
 */
export function createMockProtonApi(scenario: Scenario): ProtonApi {
    return async (options: ProtonApiOptions) => {
        logger.debug({ url: options.url, method: options.method, output: options.output }, 'Mock API request');

        if (options.output === 'stream') {
            if (scenario === 'weeklyLimit') {
                const error = new Error('Too many requests. Please try again later.');
                (error as any).status = 429;
                (error as any).Code = 2028;
                throw error;
            }

            const generator = scenarios[scenario];
            logger.debug({ scenario }, 'Mock API: returning SSE stream');
            return createStream(generator);
        }

        // Non-stream requests: return generic Proton success
        return { Code: 1000 };
    };
}
