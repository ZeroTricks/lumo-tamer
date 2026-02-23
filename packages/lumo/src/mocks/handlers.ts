/**
 * Mock scenario generators - shim for upstream mocks/handlers.ts
 *
 * Source: https://github.com/ProtonMail/WebClients/blob/main/applications/lumo/src/app/mocks/handlers.ts
 *
 * The upstream file uses MSW (Mock Service Worker) for HTTP interception.
 * We extract only the scenario generators (pure async functions) and helpers.
 *
 * Not included (MSW-specific):
 * - createStream() - we use our own ReadableStream wrapper in mock-api.ts
 * - handlers array - MSW http.post handler registration
 * - mockConfig dynamic import - we use static config
 */

// Scenario types matching upstream mockConfig.ts ScenarioType
export type ScenarioType = 'success' | 'error' | 'timeout' | 'rejected' | 'toolCall' | 'weeklyLimit';

export type ScenarioGenerator = () => AsyncGenerator<string>;

// Helpers from upstream handlers.ts
export const formatSSEMessage = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
export const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Upstream scenario generators from handlers.ts
 *
 * These are pure async generators that yield SSE message strings.
 * weeklyLimit is special - it's handled as an HTTP 429 error, not a stream.
 */
export const scenarios: Record<Exclude<ScenarioType, 'weeklyLimit'>, ScenarioGenerator> = {
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
            content: '{"name": "web_search", "parameters": {"query": "test search"}}',
        });
        await delay(500);

        // Tool result must be valid JSON (matching Proton's format)
        yield formatSSEMessage({
            type: 'token_data',
            target: 'tool_result',
            count: 1,
            content: '{"results":[{"title":"Mock Result","url":"https://example.com","description":"Mock search result data"}],"total_count":1}',
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
