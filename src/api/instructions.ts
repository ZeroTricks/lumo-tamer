import { OpenAIResponseRequest, OpenAIChatRequest, EndpointDependencies } from './types.js';
import { logger } from '../logger.js';
import { setBehaviourFromInstructions } from '../browser/behaviour.js';
import { browserConfig } from '../config.js';

// Module-level variable to track last processed instructions
let lastInstructionsContent: string | null = null;

/**
 * Handles developer messages from the request input/messages array.
 * Extracts the last developer message, logs it (shortened), and processes it.
 */
export async function handleInstructions(
  request: OpenAIResponseRequest | OpenAIChatRequest,
  deps: EndpointDependencies
): Promise<void> {
  // Return early if behaviour overwrite is not allowed
  if (!browserConfig.behaviourAllowOverwrite) {
    return;
  }

  let messages: Array<{ role: string; content: string }> | undefined;

  // Extract messages array from either request type
  if ('input' in request && Array.isArray(request.input)) {
    // Filter to only include message items, not function_call_output items
    messages = request.input.filter((item): item is { role: string; content: string } =>
      typeof item === 'object' && 'role' in item && 'content' in item
    );
  } else if ('messages' in request && Array.isArray(request.messages)) {
    messages = request.messages;
  }

  if (!messages) {
    return;
  }

  let instructionsContent = "";

  const lastDeveloperMessage = [...messages].reverse().find(m => m.role === 'developer');
  if (lastDeveloperMessage)
    instructionsContent += lastDeveloperMessage.content;

  
  // Check if tools should be included
  if (browserConfig.instructionsUseTools && 'tools' in request && request.tools && request.tools.length > 0) {
    logger.debug(`tools detected: ${request.tools.map(({name}) => name).join()}`);
    const toolsJson = JSON.stringify(request.tools, null, 2);
    instructionsContent += `\n\n${browserConfig.instructionsToolsDescription}\n${toolsJson}`;
  }

  // Check if instructions have changed
  if (instructionsContent === lastInstructionsContent) {
    logger.debug('Instructions unchanged, skipping behaviour update');
    return;
  }

  const shortened = instructionsContent.substring(0, 100);
  logger.info(`Developer message: ${shortened}${instructionsContent.length > 100 ? '...' : ''}`);

  const page = await deps.getPage();
  await setBehaviourFromInstructions(page, instructionsContent);

  // Update the stored instructions after successful update
  lastInstructionsContent = instructionsContent;
}
