/**
 * Converts OpenAI message format to Lumo Turn format
 */

import type { ChatMessage, ResponseInputItem, OpenAITool } from './types.js';
import type { Turn } from '../lumo-client/index.js';
import { getInstructionsConfig, getToolsConfig } from '../app/config.js';
import { isCommand } from '../app/commands.js';

/**
 * Build tool instructions to append to message.
 * Combines instructions.forTools config with JSON representation of provided tools.
 * Returns undefined if tools are disabled or no tools provided.
 *
 * @param tools - Optional array of OpenAI tool definitions
 * @returns Formatted instruction string for tools, or undefined
 */
function buildToolsInstruction(tools?: OpenAITool[]): string | undefined {
  const toolsConfig = getToolsConfig();
  if (!toolsConfig.enabled || !tools || tools.length === 0) {
    return undefined;
  }
  const instructionsConfig = getInstructionsConfig();
  const forTools = instructionsConfig?.forTools ?? '';
  const toolsJson = JSON.stringify(tools, null, 2);
  return `${forTools}\n\nAvailable tools:\n${toolsJson}`;
}

/**
 * Compute effective instructions by combining config defaults with request instructions.
 *
 * - If request has instructions and append=true: default + request
 * - If request has instructions and append=false: request only
 * - If no request instructions: default (or undefined)
 * - If toolsInstruction provided, append it at the end
 *
 * @param requestInstructions - System/developer message from request
 * @param toolsInstruction - Optional tools instruction (from buildToolsInstruction)
 */
function getEffectiveInstructions(
  requestInstructions?: string,
  toolsInstruction?: string
): string | undefined {
  const instructionsConfig = getInstructionsConfig();
  const defaultInstructions = instructionsConfig?.default;
  const append = instructionsConfig?.append ?? false;

  let result: string | undefined;

  if (requestInstructions) {
    if (append && defaultInstructions) {
      result = `${defaultInstructions}\n\n${requestInstructions}`;
    } else {
      result = requestInstructions;
    }
  } else {
    result = defaultInstructions;
  }

  // Append tools instruction if provided
  if (toolsInstruction) {
    result = result ? `${result}\n\n${toolsInstruction}` : toolsInstruction;
  }

  return result;
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

    // Inject instructions into first user message (but not if it's a command)
    if (msg.role === 'user' && instructions && !instructionsInjected && !isCommand(content)) {
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
 *
 * @param messages - Array of chat messages
 * @param tools - Optional array of tool definitions (triggers legacy tool mode)
 */
export function convertMessagesToTurns(messages: ChatMessage[], tools?: OpenAITool[]): Turn[] {
  const systemContent = extractSystemMessage(messages);
  const instructions = getEffectiveInstructions(systemContent, buildToolsInstruction(tools));
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

    const instructions = getEffectiveInstructions(requestInstructions, buildToolsInstruction(tools));
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
  const instructions = getEffectiveInstructions(systemContent, buildToolsInstruction(tools));
  return convertChatMessagesToTurns(chatMessages, instructions);
}
