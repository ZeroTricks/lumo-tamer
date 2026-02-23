/**
 * Converts OpenAI message format to Lumo Turn format
 */

import type { ChatMessage, ResponseInputItem, OpenAIToolCall } from './types.js';
import { Role, type Turn } from '../lumo-client/index.js';
import { addToolNameToFunctionOutput } from './tools/call-id.js';

// ── Input normalization ───────────────────────────────────────────────
//
// - normalizeInputItem(): Converts OpenAI tool formats (role:'tool', tool_calls,
//   function_call, function_call_output) to normalized {role, content} with JSON.
//
// - convertMessagesToTurns() / convertResponseInputToTurns(): Build clean Turn[]
//   for persistence. Instruction injection happens later in LumoClient.

/**
 * Normalized message format (role + content only).
 * Used for both Lumo turns and persistence.
 */
export interface NormalizedMessage {
  role: 'user' | 'assistant';
  content: string;
  id?: string;  // Semantic ID for deduplication (call_id for tools)
}

/**
 * Extract text from OpenAI-compatible content shapes.
 * Supports:
 * - string
 * - [{ type: 'text', text: '...' }]
 * - [{ text: '...' }]
 * - { text: '...' }
 */
function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (typeof item === 'string') {
        parts.push(item);
        continue;
      }
      if (typeof item === 'object' && item !== null) {
        const obj = item as Record<string, unknown>;
        if (typeof obj.text === 'string') {
          parts.push(obj.text);
        }
      }
    }
    return parts.join('\n').trim();
  }

  if (typeof content === 'object' && content !== null) {
    const obj = content as Record<string, unknown>;
    if (typeof obj.text === 'string') return obj.text;
  }

  return '';
}

/**
 * Normalize any input item to a standard { role, content } format.
 * Handles both Chat Completions (role: 'tool', tool_calls) and
 * Responses API (function_call, function_call_output) formats.
 *
 * Tool-related items are converted to user/assistant roles with JSON content,
 * since Lumo's tool_call/tool_result roles are reserved for SSE tools.
 *
 * @returns Normalized message(s), or null if item cannot be normalized
 */
export function normalizeInputItem(item: unknown): NormalizedMessage | NormalizedMessage[] | null {
  if (typeof item !== 'object' || item === null) return null;
  const obj = item as Record<string, unknown>;

  // Chat Completions: role: 'tool' -> user with fenced JSON
  if (obj.role === 'tool' && 'tool_call_id' in obj) {
    const json = JSON.stringify({
      type: 'function_call_output',
      call_id: obj.tool_call_id,
      output: obj.content,
    });
    return {
      role: 'user',
      content: '```json\n' + json + '\n```',
      id: obj.tool_call_id as string,
    };
  }

  // Chat Completions: assistant with tool_calls -> array of assistant messages with JSON
  if (obj.role === 'assistant' && 'tool_calls' in obj && Array.isArray(obj.tool_calls)) {
    const toolCalls = obj.tool_calls as OpenAIToolCall[];
    return toolCalls.map(tc => {
      // Normalize arguments: parse then re-stringify for consistent formatting
      const args = typeof tc.function.arguments === 'string'
        ? JSON.stringify(JSON.parse(tc.function.arguments))
        : JSON.stringify(tc.function.arguments ?? {});
      return {
        role: 'assistant' as const,
        content: JSON.stringify({
          type: 'function_call',
          call_id: tc.id,
          name: tc.function.name,
          arguments: args,
        }),
        id: tc.id,
      };
    });
  }

  // Responses API: function_call -> assistant with JSON
  if (obj.type === 'function_call') {
    // Normalize arguments: parse then re-stringify for consistent formatting
    // This ensures {"a": 1} and {"a":1} produce the same hash
    const args = typeof obj.arguments === 'string'
      ? JSON.stringify(JSON.parse(obj.arguments))
      : JSON.stringify(obj.arguments ?? {});
    return {
      role: 'assistant',
      content: JSON.stringify({
        type: 'function_call',
        call_id: obj.call_id,
        name: obj.name,
        arguments: args,
      }),
      id: obj.call_id as string,
    };
  }

  // Responses API: function_call_output -> user with fenced JSON
  if (obj.type === 'function_call_output') {
    const json = JSON.stringify({
      type: 'function_call_output',
      call_id: obj.call_id,
      output: obj.output,
    });
    return {
      role: 'user',
      content: '```json\n' + json + '\n```',
      id: obj.call_id as string,
    };
  }

  return null;
}

/**
 * Extract system/developer message content from a ChatMessage array.
 * Exported for routes to build instructions.
 */
export function extractSystemMessage(messages: ChatMessage[]): string | undefined {
  const systemMsg = messages.find(m =>
    m.role === 'system' || (m.role as string) === 'developer'
  );
  if (systemMsg && 'content' in systemMsg) {
    const content = extractTextContent(systemMsg.content);
    return content || undefined;
  }
  return undefined;
}


/**
 * Core conversion: ChatMessage[] to Turn[].
 *
 * Handles tool-related messages:
 * - role: 'tool' -> user turn with JSON content
 * - assistant with tool_calls -> assistant turn(s) with JSON content
 */
function convertChatMessagesToTurns(messages: ChatMessage[]): Turn[] {
  const turns: Turn[] = [];

  for (const msg of messages) {
    // Skip system/developer messages - they're handled via instructions parameter
    if (msg.role === 'system' || (msg.role as string) === 'developer') {
      continue;
    }

    // Handle tool-related messages via normalizeInputItem
    const normalized = normalizeInputItem(msg);
    if (normalized) {
      const normalizedArray = Array.isArray(normalized) ? normalized : [normalized];
      for (const norm of normalizedArray) {
        // For function_call_output, add prefixed tool_name for Lumo context
        const content = norm.role === 'user'
          ? addToolNameToFunctionOutput(norm.content)
          : norm.content;
        turns.push({ role: norm.role === 'user' ? Role.User : Role.Assistant, content });
      }
      continue;
    }

    // Regular user/assistant message
    turns.push({
      role: msg.role === 'user' ? Role.User : Role.Assistant,
      content: extractTextContent(msg.content),
    });
  }

  return turns;
}

/**
 * Convert OpenAI ChatMessage[] to Lumo Turn[].
 * Returns clean turns without instruction injection (injection happens in LumoClient).
 *
 * @param messages - Array of chat messages
 */
export function convertMessagesToTurns(messages: ChatMessage[]): Turn[] {
  return convertChatMessagesToTurns(messages);
}

/**
 * Convert OpenAI Responses API input to Lumo Turn[].
 * Returns clean turns without instruction injection (injection happens in LumoClient).
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
    return [{ role: Role.User, content: input }];
  }

  // Array of messages -> ChatMessage[]
  // - function_call -> assistant turn with tool call JSON
  // - function_call_output -> user turn with JSON (via normalizeInputItem in convertChatMessagesToTurns)
  // - regular messages -> passed through
  const chatMessages: ChatMessage[] = [];
  for (const item of input) {
    if (typeof item !== 'object') continue;
    const itemType = 'type' in item ? (item as { type: string }).type : undefined;
    if (itemType === 'function_call') {
      const fc = item as unknown as { name: string; arguments: string };
      chatMessages.push({
        role: 'assistant',
        content: JSON.stringify({ name: fc.name, arguments: JSON.parse(fc.arguments || '{}') }),
      });
      continue;
    }
    // function_call_output will be handled by normalizeInputItem in convertChatMessagesToTurns
    if (itemType === 'function_call_output') {
      // Pass through as-is - convertChatMessagesToTurns will normalize it
      chatMessages.push(item as unknown as ChatMessage);
      continue;
    }
    if ('role' in item && 'content' in item) {
      const obj = item as { role: string; content: unknown };
      chatMessages.push({
        role: obj.role as 'user' | 'assistant' | 'system',
        content: extractTextContent(obj.content),
      });
    }
  }

  // If request instructions provided and no system message exists, add one
  if (requestInstructions && !chatMessages.some(m => m.role === 'system')) {
    chatMessages.unshift({ role: 'system', content: requestInstructions });
  }

  return convertChatMessagesToTurns(chatMessages);
}
