/**
 * Read Conversation ServerTool
 *
 * Reads a conversation by ID and returns formatted markdown text.
 */

import { serverToolPrefix, type ServerTool } from './registry.js';
import { getConversationStore, type ConversationState } from '../../../conversations/index.js';

export const readConversationServerTool: ServerTool = {
  definition: {
    type: 'function',
    function: {
      name: serverToolPrefix + 'read_conversation',
      description: 'Read the full text of a conversation by its ID. Returns formatted markdown.',
      parameters: {
        type: 'object',
        properties: {
          conversation_id: {
            type: 'string',
            description: 'The conversation ID to read',
          },
        },
        required: ['conversation_id'],
      },
    },
  },
  handler: async (args, context) => {
    const conversationId = args.conversation_id;
    if (typeof conversationId !== 'string' || !conversationId.trim()) {
      return 'Error: conversation_id is required';
    }

    if (!context.conversationStore) {
      return 'Error: conversation store not available';
    }

    const conversation = context.conversationStore.get(conversationId);
    if (!conversation) {
      return `Error: conversation not found: ${conversationId}`;
    }

    return formatConversation(conversation);
  },
  isAvailable: () => getConversationStore() !== undefined,
};

function formatConversation(conversation: ConversationState): string {
  const lines: string[] = [];
  lines.push(`# ${conversation.title || 'Untitled'}\n`);

  for (const message of conversation.messages) {
    if (isToolMessage(message.content)) continue;

    const roleHeader = message.role === 'user' ? '## User' : '## Assistant';
    lines.push(roleHeader);
    lines.push(message.content || '');
    lines.push('');
  }

  return lines.join('\n');
}

function isToolMessage(content: string | undefined): boolean {
  if (!content) return false;
  const trimmed = content.trim();

  // Raw JSON (function_call from assistant)
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      return parsed.type === 'function_call' || parsed.type === 'function_call_output';
    } catch {
      return false;
    }
  }

  // Fenced JSON (function_call_output from user)
  if (trimmed.startsWith('```json\n{')) {
    const jsonContent = trimmed.slice(8, -4); // Remove ```json\n and \n```
    try {
      const parsed = JSON.parse(jsonContent);
      return parsed.type === 'function_call_output';
    } catch {
      return false;
    }
  }

  return false;
}
