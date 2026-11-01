/**
 * Converts OpenAI message formats to MessageForStore format.
 *
 * MessageForStore is compatible with Lumo's Turn type (role + content)
 * but also includes an optional `id` field for deduplication of tool messages.
 */

import type { OpenAIChatMessage, OpenAIResponseMessage, OpenAIToolCall, StandardChatMessage } from './types.js';
import { Role } from '../lumo-client/index.js';
import { addToolNameToFunctionOutput } from './tools/call-id.js';
import { createImageCounter, extractImages, readImagePart, type ImageCounter } from './images.js';
import { logger } from '../app/logger.js';
import { type MessageForStore } from 'src/conversations/types.js';

/**
 * Extract text from OpenAI-compatible content shapes.
 * Supports:
 * - string
 * - [{ type: 'text', text: '...' }]
 * - [{ text: '...' }]
 * - { text: '...' }
 * Image parts are skipped here; see extractImages().
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
 * Convert tool-related message formats to MessageForStore.
 *
 * Handles both Chat Completions (role: 'tool', tool_calls) and
 * Responses API (function_call, function_call_output) formats.
 *
 * Tool-related items are converted to user/assistant roles with JSON content,
 * since Lumo's tool_call/tool_result roles are reserved for SSE tools.
 *
 * @param counter - Request-wide image counter (Responses API tool outputs may carry images)
 * @returns Converted message(s), or null if item is not a tool message
 */
export function convertToolMessage(
  item: unknown,
  counter: ImageCounter = createImageCounter()
): MessageForStore | MessageForStore[] | null {
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
      role: Role.User,
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
        role: Role.Assistant,
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
      role: Role.Assistant,
      content: JSON.stringify({
        type: 'function_call',
        call_id: obj.call_id,
        name: obj.name,
        arguments: args,
      }),
      id: obj.call_id as string,
    };
  }

  // Responses API: function_call_output -> user with fenced JSON.
  // `output` may be a string or an array of input_text/input_image items; images
  // go through the image pipeline instead of being stringified into the prompt.
  if (obj.type === 'function_call_output') {
    const { output, images } = splitToolOutput(obj.output, counter);
    const json = JSON.stringify({
      type: 'function_call_output',
      call_id: obj.call_id,
      output,
    });
    return {
      role: Role.User,
      content: '```json\n' + json + '\n```',
      id: obj.call_id as string,
      ...(images.length > 0 ? { images } : {}),
    };
  }

  return null;
}

/** Split a Responses API tool output into its text (string or joined text items) and decoded images. */
function splitToolOutput(output: unknown, counter: ImageCounter): { output: unknown; images: NonNullable<MessageForStore['images']> } {
  if (!Array.isArray(output)) return { output, images: [] };
  const images = extractImages(output, counter);
  const texts = output
    .filter((part) => readImagePart(part) === undefined)
    .map((part) => (typeof part === 'object' && part !== null && typeof (part as { text?: unknown }).text === 'string'
      ? (part as { text: string }).text
      : JSON.stringify(part)));
  return { output: texts.join('\n'), images };
}

/**
 * Extract system/developer message content from a ChatMessage array.
 * Exported for routes to build instructions.
 */
export function extractSystemMessage(messages: OpenAIChatMessage[]): string | undefined {
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
 * Convert OpenAI ChatMessage[] to MessageForStore[].
 *
 * Handles tool-related messages:
 * - role: 'tool' -> user message with JSON content
 * - assistant with tool_calls -> assistant message(s) with JSON content
 *
 * Preserves semantic IDs (call_id) for tool messages to enable deduplication.
 */
export function convertOpenAIChatMessages(messages: OpenAIChatMessage[]): MessageForStore[] {
  const result: MessageForStore[] = [];
  const counter = createImageCounter();

  for (const msg of messages) {
    // Skip system/developer messages - they're handled via instructions parameter
    if (msg.role === 'system' || (msg.role as string) === 'developer') {
      continue;
    }

    // Handle tool-related messages via convertToolMessage
    const converted = convertToolMessage(msg, counter);
    if (converted) {
      const convertedArray = Array.isArray(converted) ? converted : [converted];
      for (const item of convertedArray) {
        // For function_call_output, add prefixed tool_name for Lumo context
        const content = item.role === Role.User
          ? addToolNameToFunctionOutput(item.content ?? '')
          : item.content;
        result.push({ role: item.role, content, id: item.id, ...(item.images ? { images: item.images } : {}) });
      }
      continue;
    }

    // Regular user/assistant message
    result.push(convertContentMessage(msg.role === 'user' ? Role.User : Role.Assistant, msg.content, counter));
  }

  return result;
}

/**
 * Convert a user/assistant message with string or content-parts content.
 * Images are only accepted on user messages (what OpenAI vision clients send);
 * image parts on other roles are dropped.
 *
 * An image-only user message gets a placeholder text naming the images, so the
 * persisted/synced message is not blank and the turn always has content.
 */
function convertContentMessage(role: Role, content: unknown, counter: ImageCounter): MessageForStore {
  const message: MessageForStore = { role, content: extractTextContent(content) };
  if (role === Role.User) {
    const images = extractImages(content, counter);
    if (images.length > 0) {
      message.images = images;
      if (!message.content) {
        message.content = `[${images.length === 1 ? 'Image' : 'Images'}: ${images.map((i) => i.name).join(', ')}]`;
      }
    }
  } else if (Array.isArray(content) && content.some(isImagePart)) {
    logger.debug({ role }, 'Ignoring image parts on non-user message');
  }
  return message;
}

function isImagePart(part: unknown): boolean {
  if (typeof part !== 'object' || part === null) return false;
  const type = (part as { type?: unknown }).type;
  return type === 'image_url' || type === 'input_image';
}

/**
 * Convert OpenAI Responses API input to MessageForStore[].
 *
 * Handles both string input and message array input.
 * Preserves semantic IDs for tool messages to enable deduplication.
 */
export function convertOpenAIResponseMessages(
  input: string | OpenAIResponseMessage[] | undefined,
  requestInstructions?: string
): MessageForStore[] {
  if (!input) {
    return [];
  }

  // Simple string input
  if (typeof input === 'string') {
    return [{ role: Role.User, content: input }];
  }

  // Array of messages -> ChatMessage[]
  // - function_call -> assistant turn with tool call JSON
  // - function_call_output -> user turn with JSON (via convertToolMessage in convertChatMessages)
  // - regular messages -> passed through
  const chatMessages: OpenAIChatMessage[] = [];
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
    // function_call_output will be handled by convertToolMessage in convertChatMessages
    if (itemType === 'function_call_output') {
      // Pass through as-is - convertChatMessages will normalize it
      chatMessages.push(item as unknown as OpenAIChatMessage);
      continue;
    }
    if ('role' in item && 'content' in item) {
      // Pass content through unchanged (string or parts): convertOpenAIChatMessages
      // extracts text and decodes image parts.
      const obj = item as { role: string; content: unknown };
      chatMessages.push({
        role: obj.role as 'user' | 'assistant' | 'system',
        content: obj.content as StandardChatMessage['content'],
      });
    }
  }

  // If request instructions provided and no system message exists, add one
  if (requestInstructions && !chatMessages.some(m => m.role === 'system')) {
    chatMessages.unshift({ role: 'system', content: requestInstructions });
  }

  return convertOpenAIChatMessages(chatMessages);
}
