/**
 * Converts OpenAI message format to Lumo Turn format
 */

import type { ChatMessage, ResponseInputItem, OpenAITool } from './types.js';
import type { Turn } from '../lumo-client/index.js';
import { instructionsConfig } from '../config.js';

/**
 * Build tool instructions to append to message.
 * Combines instructions.forTools config with JSON representation of provided tools.
 *
 * @param tools - Array of OpenAI tool definitions
 * @returns Formatted instruction string for tools
 */
export function buildToolsInstruction(tools: OpenAITool[]): string {
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
 *
 * @param messages - Array of chat messages
 * @param tools - Optional array of tool definitions (triggers legacy tool mode)
 */
export function convertMessagesToTurns(messages: ChatMessage[], tools?: OpenAITool[]): Turn[] {
  const systemContent = extractSystemMessage(messages);
  const toolsInstruction = tools && tools.length > 0 ? buildToolsInstruction(tools) : undefined;
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
    const toolsInstruction = tools && tools.length > 0 ? buildToolsInstruction(tools) : undefined;
    const instructions = getEffectiveInstructions(requestInstructions, toolsInstruction);
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
  const toolsInstruction = tools && tools.length > 0 ? buildToolsInstruction(tools) : undefined;

  const instructions = getEffectiveInstructions(systemContent, toolsInstruction);
  return convertChatMessagesToTurns(chatMessages, instructions);
}
