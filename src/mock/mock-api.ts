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
import { customScenarios } from './custom-scenarios.js';

type Scenario = MockConfig['scenario'];
export type ScenarioGenerator = (options: ProtonApiOptions) => AsyncGenerator<string>;

const formatSSEMessage = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Mock-wide call counter - safety net against infinite loops.
 * Counts calls per scenario name. Reset when a new mock ProtonApi is created.
 */
const callCounts = new Map<string, number>();
const MAX_CALLS = 10;

function createStream(scenario: string, generator: ScenarioGenerator, options: ProtonApiOptions): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream({
        async start(controller) {
            const callNum = (callCounts.get(scenario) ?? 0) + 1;
            callCounts.set(scenario, callNum);

            if (callNum > MAX_CALLS) {
                logger.warn({ scenario, callNum }, `Mock safety limit: ${MAX_CALLS} calls exceeded`);
                controller.enqueue(encoder.encode(
                    formatSSEMessage({ type: 'error', message: `Mock safety limit: ${MAX_CALLS} calls exceeded` })
                ));
                controller.close();
                return;
            }

            try {
                for await (const chunk of generator(options)) {
                    controller.enqueue(encoder.encode(chunk));
                }
                controller.close();
            } catch (error) {
                controller.error(error);
            }
        },
    });
}

// Upstream scenario generators (adapted from Proton WebClients handlers.ts)
const upstreamScenarios: Record<string, ScenarioGenerator> = {
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
            count: 0,
            content: '{"name": "web_search", "parameters": {"search_term": "test search"}}',
        });
        await delay(500);

        yield formatSSEMessage({
            type: 'token_data',
            target: 'tool_result',
            count: 1,
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

// Merged: upstream + custom scenarios
const scenarios: Record<string, ScenarioGenerator> = { ...upstreamScenarios, ...customScenarios };

// List of scenarios to cycle through (excludes 'cycle' itself)
const cycleScenarioNames = Object.keys(scenarios);

// Cycle state: tracks current index for the 'cycle' scenario
let cycleIndex = 0;

/**
 * Create a mock ProtonApi function that returns simulated SSE streams
 */
export function createMockProtonApi(scenario: Scenario): ProtonApi {
    callCounts.clear();
    cycleIndex = 0;
    return async (options: ProtonApiOptions) => {
        logger.debug({ url: options.url, method: options.method, output: options.output }, 'Mock API request');

        if (options.output === 'stream') {
            // Resolve actual scenario (handle 'cycle' mode)
            let activeScenario = scenario;
            if (scenario === 'cycle') {
                activeScenario = cycleScenarioNames[cycleIndex % cycleScenarioNames.length] as Scenario;
                cycleIndex++;
                logger.debug({ cycleIndex, activeScenario }, 'Mock API: cycle mode');
            }

            if (activeScenario === 'weeklyLimit') {
                const error = new Error('Too many requests. Please try again later.');
                (error as any).status = 429;
                (error as any).Code = 2028;
                throw error;
            }

            const generator = scenarios[activeScenario];
            logger.debug({ scenario: activeScenario }, 'Mock API: returning SSE stream');
            return createStream(activeScenario, generator, options);
        }

        // Non-stream requests: return generic Proton success
        return { Code: 1000 };
    };
}
