import { vi, describe, it, expect, beforeEach } from 'vitest';
import { resetConversationStore } from '../../src/conversations/index.js';
import { Application } from '../../src/app/index.js';

vi.mock('../../src/app/config.js', async (importOriginal) => ({
  ...await importOriginal(),
  mockConfig: { enabled: true, scenario: 'success' },
  getConversationsConfig: () => ({
    useFallbackStore: true,
    deriveIdFromUser: false,
    databasePath: ':memory:',
    enableSync: false,
    projectName: 'test',
  }),
}));

describe('Application.initializeMock()', () => {
  beforeEach(() => resetConversationStore());

  it('registers the fallback store so getConversationStore() does not throw', async () => {
    const app = await Application.create();
    expect(() => app.getConversationStore()).not.toThrow();
    expect(app.getConversationStore()).toBeDefined();
  });
});
