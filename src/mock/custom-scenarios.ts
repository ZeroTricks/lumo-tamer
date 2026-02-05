/**
 * Custom mock scenarios for lumo-tamer testing
 *
 * Unlike the upstream-adapted scenarios in mock-api.ts (from Proton WebClients handlers.ts),
 * these are lumo-tamer-specific scenarios for features we built on top.
 */

import type { ScenarioGenerator } from './mock-api.js';

const formatSSEMessage = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Call counter per scenario name.
 * Useful for scenarios that need to vary behavior across consecutive calls.
 * Reset via resetCallCounts() when creating a new mock instance.
 */
const callCounts = new Map<string, number>();

export function resetCallCounts(): void {
    callCounts.clear();
}

function incrementCallCount(scenario: string): number {
    const count = (callCounts.get(scenario) ?? 0) + 1;
    callCounts.set(scenario, count);
    return count;
}

export const customScenarios: Record<string, ScenarioGenerator> = {
    confusedToolCall: async function* () {
        // Simulates a "confused" tool call: Lumo routes a custom (client-defined) tool
        // through its native pipeline instead of outputting it as text. Always fails server-side.
        // Based on real logs: concatenated retried tool calls, error results, then fallback text.
        //
        // Call 1: confused native tool call (triggers bounce)
        // Call 2: bounce response - JSON code fence (what Lumo should have done)
        // Call 3+: normal text response (after client sends tool result back)
        const callNum = incrementCallCount('confusedToolCall');
        if (callNum > 2) {
            // Normal response after tool result - prevents loop with clients like Home Assistant
            yield formatSSEMessage({ type: 'ingesting', target: 'message' });
            await delay(200);
            const tokens = ['(Mocked) ', 'Tool ', 'result ', 'received, ', 'thanks!'];
            for (let i = 0; i < tokens.length; i++) {
                yield formatSSEMessage({ type: 'token_data', target: 'message', count: i, content: tokens[i] });
            }
            yield formatSSEMessage({ type: 'done' });
            return;
        }
        if (callNum === 2) {
            // Bounce response: output the tool call as JSON text (what Lumo should have done)
            yield formatSSEMessage({ type: 'ingesting', target: 'message' });
            await delay(200);
            const json = '```json\n{"name":"GetLiveContext","arguments":{}}\n```';
            const tokens = json.split('');
            for (let i = 0; i < tokens.length; i++) {
                yield formatSSEMessage({ type: 'token_data', target: 'message', count: i, content: tokens[i] });
            }
            yield formatSSEMessage({ type: 'done' });
            return;
        }

        yield formatSSEMessage({ type: 'ingesting', target: 'message' });
        await delay(200);

        // Lumo sends the tool call (sometimes retried, producing concatenated JSON)
        yield formatSSEMessage({
            type: 'token_data',
            target: 'tool_call',
            count: 0,
            content: '{"name":"GetLiveContext","parameters":{}}',
        });
        await delay(100);
        yield formatSSEMessage({
            type: 'token_data',
            target: 'tool_call',
            count: 1,
            content: '{"name":"GetLiveContext"}',
        });
        await delay(100);

        // Tool result indicates failure
        yield formatSSEMessage({
            type: 'token_data',
            target: 'tool_result',
            count: 2,
            content: '{"error":true}',
        });
        await delay(100);
        yield formatSSEMessage({
            type: 'token_data',
            target: 'tool_result',
            count: 3,
            content: '{"error":true}',
        });
        await delay(200);

        // Lumo sends fallback error text (should be suppressed by our handler)
        const tokens = ["I ", "don't ", "have ", "access ", "to ", "that ", "tool."];
        for (let i = 0; i < tokens.length; i++) {
            yield formatSSEMessage({ type: 'token_data', target: 'message', count: i, content: tokens[i] });
            await delay(30);
        }

        yield formatSSEMessage({ type: 'done' });
    },
};
