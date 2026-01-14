/**
 * Converts OpenAI message format to Lumo Turn format
 */

import type { ChatMessage, ResponseInputItem } from './types.js';
import type { Turn } from '../lumo-client/index.js';
import { instructionsConfig } from '../config.js';

/**
 * Compute effective instructions by combining config defaults with request instructions.
 *
 * - If request has instructions and append=true: default + request
 * - If request has instructions and append=false: request only
 * - If no request instructions: default (or undefined)
 */
function getEffectiveInstructions(requestInstructions?: string): string | undefined {
  const defaultInstructions = instructionsConfig?.default;
  const append = instructionsConfig?.append ?? false;

  if (requestInstructions) {
    if (append && defaultInstructions) {
      return `${defaultInstructions}\n\n${requestInstructions}`;
    }
    return requestInstructions;
  }

  return defaultInstructions;
}

/**
 * Extract system/developer message content from a ChatMessage array.
 */
function extractSystemMessage(messages: ChatMessage[]): string | undefined {
  const systemMsg = messages.find(m =>
    m.role === 'system' || (m.role as string) === 'developer'
  );
  return systemMsg?.content;
}

/**
 * Core conversion: ChatMessage[] to Turn[] with instruction injection.
 *
 * Per Lumo's pattern, instructions are injected as
 * "[Personal context: ...]" appended to the first user message.
 */
function convertChatMessagesToTurns(messages: ChatMessage[], instructions?: string): Turn[] {
  const turns: Turn[] = [];
  let instructionsInjected = false;

  for (const msg of messages) {
    // Skip system/developer messages - they're handled via instructions parameter
    if (msg.role === 'system' || (msg.role as string) === 'developer') {
      continue;
    }

    let content = msg.content;

    // Inject instructions into first user message
    if (msg.role === 'user' && instructions && !instructionsInjected) {
      content = `${content}\n\n[Personal context: ${instructions}]`;
      instructionsInjected = true;
    }

    turns.push({
      role: msg.role as 'user' | 'assistant',
      content,
    });
  }

  return turns;
}

/**
 * Convert OpenAI ChatMessage[] to Lumo Turn[] with system message injection.
 */
export function convertMessagesToTurns(messages: ChatMessage[]): Turn[] {
  const systemContent = extractSystemMessage(messages);
  const instructions = getEffectiveInstructions(systemContent);
  return convertChatMessagesToTurns(messages, instructions);
}

/**
 * Convert OpenAI Responses API input to Lumo Turn[].
 * Handles both string input and message array input.
 */
export function convertResponseInputToTurns(
  input: string | ResponseInputItem[] | undefined,
  requestInstructions?: string
): Turn[] {
  if (!input) {
    return [];
  }

  // Simple string input
  if (typeof input === 'string') {
    const instructions = getEffectiveInstructions(requestInstructions);
    let content = input;
    if (instructions) {
      content = `${content}\n\n[Personal context: ${instructions}]`;
    }
    return [{ role: 'user', content }];
  }

  // Array of messages - filter out function_call_output items
  const messages = input.filter((item): item is { role: string; content: string } => {
    if (typeof item !== 'object') return false;
    if ('type' in item && item.type === 'function_call_output') return false;
    return 'role' in item && 'content' in item;
  });

  // Convert to ChatMessage format
  const chatMessages: ChatMessage[] = messages.map(m => ({
    role: m.role as 'user' | 'assistant' | 'system',
    content: m.content,
  }));

  // If request instructions provided and no system message exists, add one
  if (requestInstructions && !chatMessages.some(m => m.role === 'system')) {
    chatMessages.unshift({ role: 'system', content: requestInstructions });
  }

  const systemContent = extractSystemMessage(chatMessages);
  const instructions = getEffectiveInstructions(systemContent);
  return convertChatMessagesToTurns(chatMessages, instructions);
}
