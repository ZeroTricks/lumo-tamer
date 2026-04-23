/**
 * Search ServerTool
 *
 * Allows Lumo to search through conversation history.
 * Wraps the existing search logic from src/conversations/search.ts.
 */

import { searchConversations, formatSearchResults } from '../../../conversations/search.js';
import { serverToolPrefix, type ServerTool } from './registry.js';
import { getConversationStore } from '../../../conversations/index.js';

export const searchServerTool: ServerTool = {
  definition: {
    type: 'function',
    function: {
      name: serverToolPrefix + 'search',
      description: 'Search through conversation history by title and message content. Returns matching conversations with snippets.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query to find in conversation titles and message content',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of results to return (default 10)',
          },
        },
        required: ['query'],
      },
    },
  },
  handler: async (args, context) => {
    const query = args.query;
    if (typeof query !== 'string' || !query.trim()) {
      return 'Error: query parameter is required and must be a non-empty string';
    }

    if (!context.conversationStore) {
      return 'Search unavailable: conversation store not initialized';
    }

    const limit = typeof args.limit === 'number' ? Math.min(Math.max(1, args.limit), 50) : 10;

    const results = searchConversations(
      context.conversationStore,
      query.trim(),
      limit,
      context.conversationId // Exclude current conversation
    );

    return formatSearchResults(results, query.trim());
  },
  isAvailable: () => getConversationStore() !== undefined,
};
