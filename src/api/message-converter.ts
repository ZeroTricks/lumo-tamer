/**
 * Converts OpenAI message format to Lumo Turn format
 */

import type { ChatMessage, ResponseInputItem } from './types.js';
import type { Turn } from '../lumo-client/index.js';

/**
 * Convert OpenAI ChatMessage[] to Lumo Turn[] with system message injection.
 *
 * Per Lumo's pattern, system/developer messages are injected as
 * "[Personal context: ...]" appended to the first user message.
 */
export function convertMessagesToTurns(messages: ChatMessage[]): Turn[] {
  const turns: Turn[] = [];

  // Find system/developer message for context injection
  const systemMsg = messages.find(m =>
    m.role === 'system' || (m.role as string) === 'developer'
  );

  let systemInjected = false;

  for (const msg of messages) {
    // Skip system/developer messages - they get injected into first user message
    if (msg.role === 'system' || (msg.role as string) === 'developer') {
      continue;
    }

    let content = msg.content;

    // Inject system context into first user message (per Lumo's pattern)
    if (msg.role === 'user' && systemMsg && !systemInjected) {
      content = `${content}\n\n[Personal context: ${systemMsg.content}]`;
      systemInjected = true;
    }

    turns.push({
      role: msg.role as 'user' | 'assistant',
      content,
    });
  }

  return turns;
}

/**
 * Convert OpenAI Responses API input to Lumo Turn[].
 * Handles both string input and message array input.
 */
export function convertResponseInputToTurns(
  input: string | ResponseInputItem[] | undefined,
  instructions?: string
): Turn[] {
  if (!input) {
    return [];
  }

  // Simple string input
  if (typeof input === 'string') {
    let content = input;
    if (instructions) {
      content = `${content}\n\n[Personal context: ${instructions}]`;
    }
    return [{ role: 'user', content }];
  }

  // Array of messages - filter out function_call_output items
  // Keep items that have role+content, excluding only function_call_output type
  const messages = input.filter((item): item is { role: string; content: string } => {
    if (typeof item !== 'object') return false;
    // Exclude function_call_output items
    if ('type' in item && item.type === 'function_call_output') return false;
    // Must have role and content
    return 'role' in item && 'content' in item;
  });

  // Convert to ChatMessage format and use existing converter
  const chatMessages: ChatMessage[] = messages.map(m => ({
    role: m.role as 'user' | 'assistant' | 'system',
    content: m.content,
  }));

  // If instructions provided and no system message exists, add one
  if (instructions && !chatMessages.some(m => m.role === 'system')) {
    chatMessages.unshift({ role: 'system', content: instructions });
  }

  return convertMessagesToTurns(chatMessages);
}
