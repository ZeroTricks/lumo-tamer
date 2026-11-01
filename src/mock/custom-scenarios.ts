/**
 * Custom mock scenarios for lumo-tamer testing
 *
 * Unlike the upstream scenarios in proton-upstream/mocks/handlers.ts,
 * these are lumo-tamer-specific scenarios for features we built on top.
 */

import { Role, type Turn, type ProtonApiOptions } from '../lumo-client/types.js';
import { formatSSEMessage, delay, type ScenarioGenerator } from './mock-api.js';
import { getServerInstructionsConfig, getCustomToolsConfig } from '../app/config.js';

/** Content part of a Lumo 2.0 chat/completions message (text or image_url). */
type MockContentPart =
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } };

/** Extract turns from the mock request payload (unencrypted only).
 *  Supports the Lumo 2.0 chat/completions body (`messages`, string or content
 *  parts) and the legacy generation_request body (`Prompt.turns`). */
function getTurns(options: ProtonApiOptions): Turn[] {
    const body = options.data as {
        messages?: Array<{ role: Turn['role']; content?: string | MockContentPart[] }>;
        Prompt?: { turns?: Turn[] };
    };
    if (Array.isArray(body?.messages)) {
        return body.messages.map((m) => {
            if (!Array.isArray(m.content)) return { role: m.role, content: m.content };
            const text = m.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
            const images = m.content
                .filter((p): p is Extract<MockContentPart, { type: 'image_url' }> => p.type === 'image_url')
                .map((p, i) => ({ encrypted: false, image_id: `mock-${i}`, data: p.image_url.url.replace(/^data:[^,]*,/, '') }));
            return { role: m.role, content: text, images };
        }) as Turn[];
    }
    return body?.Prompt?.turns ?? [];
}

/** Data URL media type of a mock image part (e.g. `image/jpeg`). */
function imageMediaTypes(options: ProtonApiOptions): string[] {
    const body = options.data as { messages?: Array<{ content?: string | MockContentPart[] }> };
    const types: string[] = [];
    for (const m of body?.messages ?? []) {
        if (!Array.isArray(m.content)) continue;
        for (const p of m.content) {
            if (p.type === 'image_url') types.push(p.image_url.url.match(/^data:([^;,]*)/)?.[1] ?? 'unknown');
        }
    }
    return types;
}

/** Find the last turn with a given role. */
function lastTurnWithRole(turns: Turn[], role: Turn['role']): Turn | undefined {
    for (let i = turns.length - 1; i >= 0; i--) {
        if (turns[i].role === role) return turns[i];
    }
}

export const customScenarios: Record<string, ScenarioGenerator> = {
    imageInput: async function* (options) {
        // Simulates image understanding: describes what the request carried so tests
        // and manual runs can verify images made it through the whole pipeline.
        const turns = getTurns(options);
        const types = imageMediaTypes(options);
        const markers = turns.flatMap((t) => t.content?.match(/<lumo-image [^>]*\/>/g) ?? []);
        yield formatSSEMessage({ type: 'ingesting', target: 'message' });
        await delay(100);
        const summary = types.length === 0
            ? '(Mocked) I received no images.'
            : `(Mocked) I received ${types.length} image(s) [${types.join(', ')}] with ${markers.length} marker(s).`;
        const tokens = summary.split(' ');
        for (let i = 0; i < tokens.length; i++) {
            yield formatSSEMessage({ type: 'token_data', target: 'message', count: i, content: (i ? ' ' : '') + tokens[i] });
            await delay(20);
        }
        yield formatSSEMessage({ type: 'done' });
    },

    misroutedToolCall: async function* (options) {
        // Simulates a "misrouted" tool call: Lumo routes a custom (client-defined) tool
        // through its native pipeline instead of outputting it as text. Always fails server-side.
        // Based on real logs: concatenated retried tool calls, error results, then fallback text.
        //
        // Phase detection is turn-based:
        //   Bounce:   last user turn contains the bounce instruction ("built-in tool system")
        //   Follow-up: turns contain an assistant turn (multi-turn) or more than 1 turn
        //   Misrouted: everything else (simple first user message)

        const turns = getTurns(options);
        const lastUserTurn = lastTurnWithRole(turns, Role.User);
        const bounceText = getServerInstructionsConfig().forToolBounce;
        const isBounce = !!lastUserTurn?.content?.includes(bounceText.trim());
        const hasAssistantTurn = turns.some(t => t.role === Role.Assistant);

        if (isBounce) {
            // Bounce response: output the tool call as JSON text (what Lumo should have done)
            // Include the prefix so the tool call matches what we instructed Lumo to output
            yield formatSSEMessage({ type: 'ingesting', target: 'message' });
            await delay(200);
            const prefix = getCustomToolsConfig().prefix;
            const toolName = prefix ? `${prefix}GetLiveContext` : 'GetLiveContext';
            const json = `\`\`\`json\n{"name":"${toolName}","arguments":{}}\n\`\`\``;
            const tokens = json.split('');
            for (let i = 0; i < tokens.length; i++) {
                yield formatSSEMessage({ type: 'token_data', target: 'message', count: i, content: tokens[i] });
            }
            yield formatSSEMessage({ type: 'done' });
            return;
        }

        if (hasAssistantTurn || turns.length > 1) {
            // Follow-up: normal text response (tool result received, multi-turn, etc.)
            // Include a snippet of the last user turn to show the tool result was "seen"
            const snippet = lastUserTurn?.content?.slice(0, 150) ?? '';
            yield formatSSEMessage({ type: 'ingesting', target: 'message' });
            await delay(200);
            const tokens = ['(Mocked) ', 'Got tool result: ', snippet];
            for (let i = 0; i < tokens.length; i++) {
                yield formatSSEMessage({ type: 'token_data', target: 'message', count: i, content: tokens[i] });
            }
            yield formatSSEMessage({ type: 'done' });
            return;
        }

        // Initial call: misrouted native tool call
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
