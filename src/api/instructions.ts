/**
 * Instructions handling for API mode.
 *
 * In the browser-based approach, instructions were set via the Lumo UI's
 * "How should Lumo behave?" settings. In API mode, instructions are injected
 * directly into the conversation via the message converter.
 *
 * This file is kept for backwards compatibility but the function is now a no-op.
 * Instructions are handled in message-converter.ts by appending system messages
 * as "[Personal context: ...]" to the first user message.
 */

import { OpenAIResponseRequest, OpenAIChatRequest, EndpointDependencies } from './types.js';
import { logger } from '../logger.js';

/**
 * Handles developer messages from the request.
 * In API mode, this is a no-op - instructions are handled in message-converter.ts
 *
 * @deprecated Instructions are now handled via message conversion
 */
export async function handleInstructions(
  request: OpenAIResponseRequest | OpenAIChatRequest,
  _deps: EndpointDependencies
): Promise<void> {
  // No-op in API mode
  // Instructions are handled in message-converter.ts by injecting system messages
  // into the conversation turns as "[Personal context: ...]"

  // Log if developer message is present (for debugging)
  let messages: Array<{ role: string; content: string }> | undefined;

  if ('input' in request && Array.isArray(request.input)) {
    messages = request.input.filter((item): item is { role: string; content: string } =>
      typeof item === 'object' && 'role' in item && 'content' in item
    );
  } else if ('messages' in request && Array.isArray(request.messages)) {
    messages = request.messages;
  }

  if (messages) {
    const developerMsg = messages.find(m => m.role === 'developer' || m.role === 'system');
    if (developerMsg) {
      const shortened = developerMsg.content.substring(0, 100);
      logger.debug(`System/developer message present: ${shortened}${developerMsg.content.length > 100 ? '...' : ''}`);
    }
  }
}
