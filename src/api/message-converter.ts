/**
 * Converts OpenAI message format to Lumo Turn format
 */

import type { ChatMessage, ResponseInputItem, OpenAITool, OpenAIToolCall } from './types.js';
import type { Turn } from '../lumo-client/index.js';
import { getServerInstructionsConfig, getCustomToolsConfig } from '../app/config.js';
import { isCommand } from '../app/commands.js';
import { applyToolPrefix, applyReplacePatterns, interpolateTemplate } from './tools/prefix.js';

// ── Input normalization ───────────────────────────────────────────────

/**
 * Normalized message format (role + content only).
 * Used for both Lumo turns and persistence.
 */
export interface NormalizedMessage {
  role: 'user' | 'assistant';
  content: string;
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

  // Chat Completions: role: 'tool' -> user with JSON
  if (obj.role === 'tool' && 'tool_call_id' in obj) {
    return {
      role: 'user',
      content: JSON.stringify({
        type: 'function_call_output',
        call_id: obj.tool_call_id,
        output: obj.content,
      }),
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
    };
  }

  // Responses API: function_call_output -> user with JSON
  if (obj.type === 'function_call_output') {
    return {
      role: 'user',
      content: JSON.stringify({
        type: 'function_call_output',
        call_id: obj.call_id,
        output: obj.output,
      }),
    };
  }

  return null;
}

// ── Tool instruction building ────────────────────────────────────────

/**
 * Build tool instructions to append to message.
 * Uses template from config to assemble forTools, client instructions, and tools JSON.
 * Returns undefined if tools are disabled or no tools provided.
 *
 * @param tools - Optional array of OpenAI tool definitions
 * @param clientInstructions - Optional instructions from client (system/developer message)
 * @returns Formatted instruction string for tools, or undefined
 */
function buildToolsInstruction(tools?: OpenAITool[], clientInstructions?: string): string | undefined {
  const toolsConfig = getCustomToolsConfig();
  if (!toolsConfig.enabled || !tools || tools.length === 0) {
    return undefined;
  }

  const instructionsConfig = getServerInstructionsConfig();
  const { prefix, replacePatterns } = toolsConfig;

  // Apply prefix to tool names
  const prefixedTools = applyToolPrefix(tools, prefix);

  // Apply replace patterns to client instructions
  const cleanedInstructions = clientInstructions
    ? applyReplacePatterns(clientInstructions, replacePatterns)
    : '';

  // Build template variables
  const toolsJson = JSON.stringify(prefixedTools, null, 2);
  const vars: Record<string, string> = {
    forTools: instructionsConfig.forTools,
    clientInstructions: cleanedInstructions,
    toolsJson,
  };

  // Interpolate template
  return interpolateTemplate(instructionsConfig.template, vars);
}

/**
 * Compute effective instructions by combining config defaults with request instructions.
 *
 * When tools are provided:
 * - The toolsInstruction includes forTools, cleaned client instructions, and tools JSON
 *
 * When no tools:
 * - If request has instructions: use request instructions
 * - If no request instructions: use default (or undefined)
 *
 * @param requestInstructions - System/developer message from request
 * @param toolsInstruction - Optional tools instruction (from buildToolsInstruction, already includes client instructions)
 */
function getEffectiveInstructions(
  requestInstructions?: string,
  toolsInstruction?: string
): string | undefined {
  const instructionsConfig = getServerInstructionsConfig();
  const defaultInstructions = instructionsConfig?.default;

  // When tools are provided, use the assembled tools instruction
  if (toolsInstruction) {
    return toolsInstruction;
  }

  // No tools - use request instructions or fall back to default
  if (requestInstructions) {
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
  // System messages always have string content (not null)
  if (systemMsg && 'content' in systemMsg && typeof systemMsg.content === 'string') {
    return systemMsg.content;
  }
  return undefined;
}

/**
 * Core conversion: ChatMessage[] to Turn[] with instruction injection.
 *
 * Per Lumo's pattern, instructions are injected as
 * "[Personal context: ...]" appended to the first user message.
 *
 * Handles tool-related messages:
 * - role: 'tool' -> user turn with JSON content
 * - assistant with tool_calls -> assistant turn(s) with JSON content
 */
function convertChatMessagesToTurns(messages: ChatMessage[], instructions?: string): Turn[] {
  const turns: Turn[] = [];
  let instructionsInjected = false;

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
        turns.push(norm);
      }
      continue;
    }

    // Regular user/assistant message
    const content = typeof msg.content === 'string' ? msg.content : '';

    // Inject instructions into first user message (but not if it's a command)
    if (msg.role === 'user' && instructions && !instructionsInjected && !isCommand(content)) {
      turns.push({
        role: 'user',
        content: `${content}\n\n[Personal context: ${instructions}]`,
      });
      instructionsInjected = true;
      continue;
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
 *
 * @param messages - Array of chat messages
 * @param tools - Optional array of tool definitions (triggers legacy tool mode)
 */
export function convertMessagesToTurns(messages: ChatMessage[], tools?: OpenAITool[]): Turn[] {
  const systemContent = extractSystemMessage(messages);
  const toolsInstruction = buildToolsInstruction(tools, systemContent);
  const instructions = getEffectiveInstructions(systemContent, toolsInstruction);
  return convertChatMessagesToTurns(messages, instructions);
}

/**
 * Convert OpenAI Responses API input to Lumo Turn[].
 * Handles both string input and message array input.
 */
export function convertResponseInputToTurns(
  input: string | ResponseInputItem[] | undefined,
  requestInstructions?: string,
  tools?: OpenAITool[]
): Turn[] {
  if (!input) {
    return [];
  }

  // Simple string input
  if (typeof input === 'string') {
    // Don't append instructions to commands (e.g., /help, /save)
    if (isCommand(input)) {
      return [{ role: 'user', content: input }];
    }

    const toolsInstruction = buildToolsInstruction(tools, requestInstructions);
    const instructions = getEffectiveInstructions(requestInstructions, toolsInstruction);
    let content = input;
    if (instructions) {
      content = `${content}\n\n[Personal context: ${instructions}]`;
    }
    return [{ role: 'user', content }];
  }

  // Array of messages -> ChatMessage[]
  // - function_call -> assistant turn with tool call JSON
  // - function_call_output -> filtered out (appended separately by handler)
  // - regular messages -> passed through
  const chatMessages: ChatMessage[] = [];
  for (const item of input) {
    if (typeof item !== 'object') continue;
    const itemType = 'type' in item ? (item as { type: string }).type : undefined;
    if (itemType === 'function_call_output') continue;
    if (itemType === 'function_call') {
      const fc = item as unknown as { name: string; arguments: string };
      chatMessages.push({
        role: 'assistant',
        content: JSON.stringify({ name: fc.name, arguments: JSON.parse(fc.arguments || '{}') }),
      });
      continue;
    }
    if ('role' in item && 'content' in item) {
      chatMessages.push({
        role: (item as { role: string }).role as 'user' | 'assistant' | 'system',
        content: (item as { content: string }).content,
      });
    }
  }

  // If request instructions provided and no system message exists, add one
  if (requestInstructions && !chatMessages.some(m => m.role === 'system')) {
    chatMessages.unshift({ role: 'system', content: requestInstructions });
  }

  const systemContent = extractSystemMessage(chatMessages);
  const toolsInstruction = buildToolsInstruction(tools, systemContent);
  const instructions = getEffectiveInstructions(systemContent, toolsInstruction);
  return convertChatMessagesToTurns(chatMessages, instructions);
}
