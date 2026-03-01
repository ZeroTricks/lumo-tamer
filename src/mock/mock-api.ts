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
