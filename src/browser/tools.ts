import { Page } from 'playwright';
import { logger } from '../logger.js';
import type { ToolCall } from '../types.js';

/**
 * Processes tool calls detected in the response by extracting and parsing
 * JSON from <pre> elements within the last message container.
 *
 * This is called once at the end of the response to extract tool call information.
 * Uses Playwright's locator API to query <pre> elements from the last message container.
 *
 * Workflow:
 * 1. Get the selector for message containers from config
 * 2. Find the last message container (the most recent assistant response)
 * 3. Query for all <pre> elements within that container
 * 4. For each <pre>:
 *    - Extract text content
 *    - Attempt JSON.parse()
 *    - Validate structure (must have 'name' and 'arguments' fields)
 *    - Add valid tool calls to results array
 * 5. Return the tool calls array or null if none found
 *
 * @returns Array of tool calls with name and arguments, or null if no tool calls found
 */
export async function processToolCalls(page: Page): Promise<ToolCall[] | null> {
  // logger.debug('Checking for tool calls in response...');

  try {
    // Get the target container element handle from __lumoState
    // This ensures we're checking the same container that was observed during streaming
    const lastMessageContainerHandle = await page.evaluateHandle(() => window.__lumoState?.lastMessageContainer);
    const lastMessageContainer = lastMessageContainerHandle.asElement();

    if (!lastMessageContainer) {
      logger.warn('No target container found in __lumoState');
      return null;
    }

    // Query for <pre> elements within the target container
    const preElementHandles = await lastMessageContainer.$$('pre');
    const count = preElementHandles.length;

    logger.debug(`Found ${count} <pre> elements in target container`);

    if (count === 0) {
      // logger.debug('No <pre> elements found in response');
      return null;
    }

    const results: ToolCall[] = [];

    // Process each <pre> element
    for (let i = 0; i < count; i++) {
      const preElement = preElementHandles[i];
      const content = (await preElement.textContent())?.trim() || '';

      if (!content) {
        // logger.debug(`<pre>[${i}] is empty, skipping`);
        continue;
      }

      try {
        const parsed = JSON.parse(content);

        // Validate structure: must have 'name' and 'arguments' fields
        if (parsed && typeof parsed === 'object' && 'name' in parsed && 'arguments' in parsed) {
          const toolCall: ToolCall = {
            name: String(parsed.name),
            arguments: parsed.arguments
          };

          logger.debug(`<pre>[${i}] Tool called: ${toolCall.name}`);
          results.push(toolCall);
        } else {
          logger.warn(`<pre>[${i}] Invalid structure (missing 'name' or 'arguments')`);
          logger.warn(parsed);
        }
      } catch (error) {
        logger.warn(`<pre>[${i}] JSON parse failed: ${error instanceof Error ? error.message : String(error)}`);
        logger.warn(content);
      }
    }

    if (results.length > 0) {
      logger.info(`Found ${results.length} tool calls:`);
      results.forEach((toolCall, index) => {
        logger.info(`  [${index + 1}] ${toolCall.name}`);
        logger.debug(`      arguments: ${JSON.stringify(toolCall.arguments)}`);
      });
      return results;
    } else {
      logger.debug('No valid tool calls found in response');
      return null;
    }
  } catch (error) {
    logger.error('Failed to extract tool calls:');
    logger.error(error);
    return null;
  }
}
