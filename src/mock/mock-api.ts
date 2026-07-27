/**
 * Mock ProtonApi - returns simulated SSE streams for development/testing
 *
 * Wraps upstream scenario generators from proton-upstream/mocks/handlers.ts
 * in a ProtonApi-compatible function. LumoClient doesn't care whether the
 * ProtonApi is real or mock - it just reads the returned ReadableStream.
 */

import type { ProtonApi, ProtonApiOptions } from '../lumo-client/types.js';
import type { MockConfig } from '../app/config.js';
import { logger } from '../app/logger.js';

// Import upstream scenarios and helpers
import {
    scenarios as upstreamScenarios,
    formatSSEMessage,
    delay,
} from '@lumo/mocks/handlers.js';

// Import custom scenarios (lumo-tamer-specific)
import { customScenarios } from './custom-scenarios.js';

// Re-export for custom-scenarios.ts to use
export { formatSSEMessage, delay };

// Extended generator type that can access request options
export type ScenarioGenerator = (options: ProtonApiOptions) => AsyncGenerator<string>;

type Scenario = MockConfig['scenario'];

/**
 * Mock-wide call counter - safety net against infinite loops.
 * Counts calls per scenario name. Reset when a new mock ProtonApi is created.
 */
const callCounts = new Map<string, number>();
const MAX_CALLS = 10;

const v2chunk = (fields: Record<string, unknown>) =>
    `data: ${JSON.stringify({ object: 'CompletionChunk', model: 'lumo-mock', ...fields })}\n\n`;
const v2object = (obj: Record<string, unknown>) => `data: ${JSON.stringify(obj)}\n\n`;

/**
 * Translate a legacy generation_request SSE line (the format the vendored/custom
 * scenarios still emit) into the Lumo 2.0 chat/completions OpenAI-style SSE the
 * client now parses. Keeps scenarios untouched while the mock speaks v2.
 */
function translateToV2(legacyChunk: string): string {
    const trimmed = legacyChunk.replace(/^data:\s*/, '').trim();
    if (!trimmed) return '';
    let msg: Record<string, unknown>;
    try {
        msg = JSON.parse(trimmed);
    } catch {
        return '';
    }
    switch (msg.type) {
        case 'token_data': {
            const content = typeof msg.content === 'string' ? msg.content : '';
            if (msg.target === 'message') return v2chunk({ choices: [{ index: 0, delta: { content } }] });
            if (msg.target === 'reasoning') return v2chunk({ choices: [{ index: 0, delta: { reasoning: content } }] });
            if (msg.target === 'title') return ''; // v2 titles are a separate completion
            if (msg.target === 'tool_call') {
                try {
                    const parsed = JSON.parse(content);
                    const args = JSON.stringify(parsed.parameters ?? parsed.arguments ?? {});
                    return v2object({ object: 'chat.tool_call', tool_call: { name: parsed.name, arguments: args } });
                } catch {
                    return '';
                }
            }
            if (msg.target === 'tool_result') {
                return v2object({ object: 'chat.tool_result', tool_result: { content } });
            }
            return '';
        }
        case 'done':
            return 'data: [DONE]\n\n';
        case 'error':
        case 'timeout':
        case 'rejected':
        case 'harmful':
            return v2chunk({ error: { code: msg.type, message: (msg.message as string) ?? String(msg.type) } });
        default:
            return ''; // ingesting/queued and other no-ops
    }
}

function createStream(scenario: string, generator: ScenarioGenerator, options: ProtonApiOptions): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream({
        async start(controller) {
            const callNum = (callCounts.get(scenario) ?? 0) + 1;
            callCounts.set(scenario, callNum);

            if (callNum > MAX_CALLS) {
                logger.warn({ scenario, callNum }, `Mock safety limit: ${MAX_CALLS} calls exceeded`);
                controller.enqueue(encoder.encode(
                    v2chunk({ error: { code: 'error', message: `Mock safety limit: ${MAX_CALLS} calls exceeded` } })
                ));
                controller.close();
                return;
            }

            try {
                for await (const chunk of generator(options)) {
                    const v2 = translateToV2(chunk);
                    if (v2) controller.enqueue(encoder.encode(v2));
                }
                controller.close();
            } catch (error) {
                controller.error(error);
            }
        },
    });
}

// Merged: upstream + custom scenarios
// Upstream scenarios don't use options, so wrap them to match ScenarioGenerator signature
const scenarios: Record<string, ScenarioGenerator> = {
    ...Object.fromEntries(
        Object.entries(upstreamScenarios).map(([name, gen]) => [
            name,
            (_options: ProtonApiOptions) => gen(),
        ])
    ),
    ...customScenarios,
};

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

            // weeklyLimit is special: HTTP 429 error, not a stream
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
