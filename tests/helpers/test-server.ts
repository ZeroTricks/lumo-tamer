/**
 * Test server helper - creates an Express app with mock dependencies.
 *
 * Bypasses the Application class entirely - no auth, no sync, no config.yaml.
 * Each test gets a fresh server with its own ConversationStore and mock API.
 */

import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { createResponsesRouter } from '../../src/api/routes/responses/index.js';
import { createChatCompletionsRouter } from '../../src/api/routes/chat-completions.js';
import { createHealthRouter } from '../../src/api/routes/health.js';
import { createModelsRouter } from '../../src/api/routes/models.js';
import { RequestQueue } from '../../src/api/queue.js';
import { LumoClient } from '../../src/lumo-client/index.js';
import { createMockProtonApi } from '../../src/mock/mock-api.js';
import { ConversationStore } from '../../src/conversations/store.js';
import type { EndpointDependencies } from '../../src/api/types.js';
import type { MockConfig } from '../../src/app/config.js';

type Scenario = MockConfig['scenario'];

export interface TestServer {
  server: Server;
  baseUrl: string;
  deps: EndpointDependencies;
  store: ConversationStore;
  close: () => Promise<void>;
}

/**
 * Create and start a test server on a random port.
 *
 * @param scenario - Mock API scenario (default: 'success')
 * @returns TestServer with baseUrl, deps, and cleanup function
 */
export async function createTestServer(scenario: Scenario = 'success'): Promise<TestServer> {
  const mockApi = createMockProtonApi(scenario);
  const lumoClient = new LumoClient(mockApi, { enableEncryption: false });
  const store = new ConversationStore({ maxConversationsInMemory: 50 });
  const queue = new RequestQueue(1);

  const deps: EndpointDependencies = {
    queue,
    lumoClient,
    conversationStore: store,
    syncInitialized: false,
  };

  const app = express();
  app.use(express.json());
  // No auth middleware - tests focus on route logic
  app.use(createHealthRouter(deps));
  app.use(createModelsRouter());
  app.use(createChatCompletionsRouter(deps));
  app.use(createResponsesRouter(deps));

  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });

  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://localhost:${port}`;

  return {
    server,
    baseUrl,
    deps,
    store,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/**
 * Parse SSE event stream from response text.
 * Returns array of parsed event data objects.
 */
export function parseSSEEvents(text: string): Array<{ event?: string; data: unknown }> {
  const events: Array<{ event?: string; data: unknown }> = [];
  const blocks = text.split('\n\n').filter(Boolean);

  for (const block of blocks) {
    const lines = block.split('\n');
    let eventType: string | undefined;
    let dataStr = '';

    for (const line of lines) {
      if (line.startsWith('event: ')) {
        eventType = line.slice(7).trim();
      } else if (line.startsWith('data: ')) {
        dataStr += line.slice(6);
      }
    }

    if (dataStr) {
      try {
        events.push({ event: eventType, data: JSON.parse(dataStr) });
      } catch {
        // data: [DONE] or other non-JSON
        events.push({ event: eventType, data: dataStr });
      }
    }
  }

  return events;
}
