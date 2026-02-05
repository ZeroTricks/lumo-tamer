/**
 * CLI smoke test - verifies single-query mode runs and returns output.
 *
 * Constructs CLIClient with mock AppContext (no auth, no config.yaml).
 * Mocks process.argv to trigger single-query mode and captures stdout.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { LumoClient } from '../../src/lumo-client/index.js';
import { createMockProtonApi } from '../../src/mock/mock-api.js';
import { ConversationStore } from '../../src/conversations/store.js';
import type { AppContext } from '../../src/app/types.js';

describe('CLI single-query mode', () => {
  let stdoutChunks: string[];
  let originalWrite: typeof process.stdout.write;
  let originalArgv: string[];
  let originalExit: typeof process.exit;

  beforeAll(() => {
    // Capture stdout
    stdoutChunks = [];
    originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdoutChunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    // Mock process.argv to include a query (triggers singleQuery mode)
    originalArgv = process.argv;
    process.argv = ['node', 'cli.ts', 'Say hello'];

    // Prevent process.exit from killing the test runner
    originalExit = process.exit;
    process.exit = vi.fn() as unknown as typeof process.exit;
  });

  afterAll(() => {
    process.stdout.write = originalWrite;
    process.argv = originalArgv;
    process.exit = originalExit;
  });

  it('runs single query and produces output', async () => {
    const mockApi = createMockProtonApi('success');
    const lumoClient = new LumoClient(mockApi, { enableEncryption: false });
    const store = new ConversationStore({ maxConversationsInMemory: 10 });

    const mockApp: AppContext = {
      getLumoClient: () => lumoClient,
      getConversationStore: () => store,
      getAuthProvider: () => undefined,
      getAuthManager: () => undefined,
      isSyncInitialized: () => false,
      destroy: () => {},
    };

    // Dynamic import to pick up mocked process.argv
    const { CLIClient } = await import('../../src/cli/client.js');
    const client = new CLIClient(mockApp);
    await client.run();

    const output = stdoutChunks.join('');

    // Mock 'success' scenario produces "(Mocked) Why don't programmers like nature?..."
    expect(output).toContain('Mocked');
    expect(output.length).toBeGreaterThan(10);
  });
});
