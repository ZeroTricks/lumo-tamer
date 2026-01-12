import { Page } from 'playwright';
import { chatboxSelectors, responseTimeouts, browserConfig } from '../config.js';
import { logger } from '../logger.js';
import { processSources, formatSources } from './sources.js';
import { processToolCalls } from './tools.js';
import { setBehaviour } from './behaviour.js';
import { openChatByKeyword, startNewChat, startPrivateChat } from './actions.js';
import type { ToolCall } from '../types.js';

// Extend Window interface for custom properties
declare global {
  interface Window {
    __lumoState?: {
      observer: MutationObserver;
      lastText: string;
      textChanged: boolean;
      completed: boolean;
      lastMessageContainer: Element;
    };
  }
}

export class ChatboxInteractor {

  constructor(private page: Page) { }

  /**
   * Executes a command and returns a response message.
   * @param command - The command message (with or without leading '/')
   * @returns A response message describing the result
   */
  async executeCommand(command: string): Promise<string> {
    // Strip leading '/' if present and parse command with parameters
    const commandText = command.startsWith('/')
      ? command.slice(1).trim()
      : command.trim();

    // Extract command name and parameters: /command param1 param2 ...
    const match = commandText.match(/^(\S+)(?:\s+(.*))?$/);
    const commandName = match?.[1] || commandText;
    const params = match?.[2] || '';
    const lowerCommand = commandName.toLowerCase();

    logger.info(`Executing command: /${lowerCommand}${params ? ` with params: ${params}` : ''}`);

    switch (lowerCommand) {
      case 'behave':
      case 'defaultbehaviour':
        await setBehaviour(this.page, browserConfig.behaviour);
        return 'Behaviour settings updated successfully.';
      case 'new':
      case 'clear':
      case 'reset':
        await startNewChat(this.page);
        return 'New chat started.';
      case 'private':
        await startPrivateChat(this.page);
        return 'Shhhhh 🤫';
      case 'open':
        return openChatByKeyword(this.page, params);

      default:
        logger.warn(`Unknown command: /${commandName}`);
        throw new Error(`Unknown command: /${commandName}`);
    }
  }

  /**
   * Gets a response for a message, handling both commands and regular messages.
   * Supports both streaming (with callback) and non-streaming (without callback) modes.
   *
   * @param message - The message or command to process
   * @param onDelta - Optional callback for streaming deltas as they arrive
   * @param timeoutMs - Maximum time to wait for response (default 60s)
   * @returns The complete response text and any tool calls
   */
  async getResponse(
    message: string,
    onDelta?: (delta: string) => void | Promise<void>,
    timeoutMs: number = 60000
  ): Promise<{ text: string; toolCalls: ToolCall[] | null }> {
    // Check if this is a command
    if (message.startsWith('/')) {
      // Execute command and get response
      const commandResponse = await this.executeCommand(message);

      // If streaming callback provided, send the response through it
      if (onDelta) {
        await onDelta(commandResponse);
      }

      return { text: commandResponse, toolCalls: null };
    } else {
      const cleanMessage = message.replace(/jason/i, 'JSON');

      // Regular message - send and stream/wait for response
      await this.sendMessage(cleanMessage);
      return await this.streamResponse(onDelta, timeoutMs);
    }
  }

  private async cleanupObserver(): Promise<void> {
    await this.page.evaluate(() => {
      logger.debug('Cleaning up observer');
      if (window.__lumoState) {
        window.__lumoState.observer.disconnect();
        delete window.__lumoState;
      }
    });
  }

  async sendMessage(message: string): Promise<void> {
    logger.info(`[User] ${message}`);

    logger.debug('sendMessage: Waiting for input field...');
    // Wait for input to be available
    await this.page.waitForSelector(chatboxSelectors.input, { timeout: 10000 });

    logger.debug('sendMessage: Filling message...');
    // Clear existing text and type new message
    const inputElement = this.page.locator(chatboxSelectors.input);
    await inputElement.clear();
    await inputElement.fill(message);

    // Get the last message count before sending
    const messagesBefore = await this.page.locator(chatboxSelectors.messages).count();
    logger.debug(`sendMessage: Current message count: ${messagesBefore}`);

    // Click send button
    logger.debug('sendMessage: Sending message...');
    await inputElement.press('Enter');

    // Wait a moment for UI to update
    await new Promise(resolve => setTimeout(resolve, 100));

    // Check count immediately after clicking
    const messagesAfterClick = await this.page.locator(chatboxSelectors.messages).count();
    logger.debug(`sendMessage: Message count after click: ${messagesAfterClick}`);

    // Wait for new assistant message container to appear (appears immediately with loading animation)
    logger.debug('sendMessage: Waiting for new assistant container...');

    if (messagesBefore === 0) {
      // First message - just wait for first container to appear
      logger.debug('sendMessage: First message - waiting for first container...');
      await this.page.waitForSelector(chatboxSelectors.messages, { timeout: 20000 });
      logger.debug('sendMessage: First container appeared');
    } else {
      // Subsequent messages - wait for count to increase
      logger.debug(`sendMessage: Waiting for count to increase from ${messagesBefore}`);

      // Check if count already increased
      if (messagesAfterClick > messagesBefore) {
        logger.debug(`sendMessage: Container count already increased to' ${messagesAfterClick}`);
      } else {
        // If not, wait for it to increase
        try {
          await this.page.waitForFunction(
            ({ selector, expectedCount }: { selector: string; expectedCount: number }) => {
              const elements = document.querySelectorAll(selector);
              const currentCount = elements.length;
              logger.debug(`Checking count: ${currentCount}, expected: ${expectedCount}`);
              if (currentCount > expectedCount) {
                logger.debug(`Count increased! ${currentCount}>${expectedCount}`);
                return true;
              }
              return false;
            },
            { selector: chatboxSelectors.messages, expectedCount: messagesBefore },
            { timeout: 20000, polling: 100 }
          );
          logger.debug('sendMessage: Container count increased');
        } catch (error) {
          logger.error(`sendMessage: Timeout waiting for container count increase:`);
          logger.error(error);
          throw error;
        }
      }
    }
  }

  async waitForResponse(timeoutMs: number = 60000): Promise<{ text: string; toolCalls: ToolCall[] | null }> {
    return await this.streamResponse(undefined, timeoutMs);
  }

  /**
   * Injects a MutationObserver into the browser to monitor the last message container.
   * The observer tracks text changes and completion indicators.
   */
  private async setupResponseObserver(): Promise<void> {
    const lastMessageSelector = chatboxSelectors.messages;

    logger.debug(`Injecting MutationObserver on last '${lastMessageSelector} ...'`);

    await this.page.evaluate(
      ({ lastMessageSelector, contentElements, messageCompletionMarker }: {
          lastMessageSelector: string;
          contentElements: string;
          messageCompletionMarker: string
      }) => {
        logger.debug(`Setting up observer for selector: ${lastMessageSelector}, content: ${contentElements}, indicator: ${messageCompletionMarker}`);

        // Clean up any existing observer from previous calls
        if (window.__lumoState) {
          logger.debug('Disconnecting existing observer');
          window.__lumoState.observer.disconnect();
        }

        // Lock onto the last container at setup time to avoid switching containers mid-stream
        const containers = document.querySelectorAll(lastMessageSelector);
        logger.debug(`Setup: Found ${containers.length} containers`);
        if (containers.length === 0) {
          console.error('No containers found at setup!');
          return;
        }
        const lastMessageContainer = containers[containers.length - 1];
        logger.debug(`'Locked onto container: ${lastMessageContainer.tagName}  ${lastMessageContainer.className}`);

        // Initialize state object that we'll check from Node.js
        window.__lumoState = {
          observer: null as any, // Will be set after creating the observer
          lastText: '',
          textChanged: false,
          completed: false,
          lastMessageContainer
        };

        // This function is called on every DOM mutation of lastMessageContainer
        const updateText = () => {

          let completed = false;

          // Check for completion indicator (e.g., thumb-up icon)
          if (!window.__lumoState!.completed) {
            const indicator = lastMessageContainer.querySelector(messageCompletionMarker);
            if (indicator) {
              logger.debug('Completion indicator detected! Waiting briefly for final text...');
              // Wait a bit before marking as completed to allow any pending text mutations to process
              // This prevents a race condition where the completion indicator appears before final text
              setTimeout(() => {
                logger.debug('Marking as completed after delay');
                window.__lumoState!.completed = true;
                window.__lumoState!.textChanged = true; // Wake up waitForFunction immediately
              }, 150);
              completed = true;
            }
          }

          const blocks = lastMessageContainer.querySelectorAll(contentElements);
          logger.debug(`updateText: Found ${ blocks.length} paragraphs in target container`);

          // Extract all text from completed blocks
          // This is related to https://github.com/ProtonMail/WebClients/blob/main/applications/lumo/src/app/ui/components/LumoMarkdown/ProgressiveMarkdownRenderer.tsx ,
          // Although we don't reuse anything from there
          let fullText = '';
          const lastCompleteBlockIndex = blocks.length - (completed ? 0 : 1);

          for (let index = 0; index < lastCompleteBlockIndex; index++) {
            const block = blocks[index];
            fullText += (index > 0 ? '\n' : '') + (block.textContent || '');
          }

          // If text changed, update state and set change flag
          if (fullText !== window.__lumoState!.lastText) {
            logger.debug(`Text changed: ${fullText.length} chars`);
            window.__lumoState!.lastText = fullText;
            window.__lumoState!.textChanged = true;
          }
        };

        // Run updateText once to capture initial state
        updateText();
        logger.debug(`Initial text captured: ${window.__lumoState.lastText ? window.__lumoState.lastText.length : 0} chars`);

        // Create MutationObserver that will call updateText on every DOM change
        const observer = new MutationObserver((mutations) => {
          logger.debug(`Mutation detected, mutations: ${mutations.length}`);
          updateText();
        });

        // Attach observer to the target container
        logger.debug('Attaching observer to target container');
        observer.observe(lastMessageContainer, {
          childList: true,      // Watch for added/removed child nodes
          subtree: true,        // Watch all descendants, not just direct children
          characterData: true   // Watch for text content changes
        });

        window.__lumoState.observer = observer;
        logger.debug('Observer setup complete');
      },
      {
        lastMessageSelector,
        contentElements: chatboxSelectors.contentElements,
        messageCompletionMarker: chatboxSelectors.messageCompletionMarker
      }
    );
  }

  /**
   * Waits for text changes in the browser, with adaptive timeout based on whether text has been received.
   * @param previousText - The text received so far
   * @param noChangeTimeoutWithText - Timeout when text has been received
   * @param noChangeTimeoutEmpty - Timeout when no text received yet
   * @returns The current text and completion status, or null if timeout
   */
  private async waitForTextChange(
    previousText: string,
    noChangeTimeoutWithText: number,
    noChangeTimeoutEmpty: number
  ): Promise<{ text: string; completed: boolean } | null> {
    logger.debug(`Waiting for text changes... (prevText length: ${previousText.length})`);

    // Adaptive timeout: wait longer if we haven't received any text yet (empty response scenario)
    const currentTimeout = previousText.length === 0 ? noChangeTimeoutEmpty : noChangeTimeoutWithText;

    const waitStart = Date.now();

    try {
      // Wait for textChanged flag to become true OR timeout
      // The flag is set by the browser-side observer when text or completion indicator changes
      await this.page.waitForFunction(
        (prevText: string) => {
          return window.__lumoState?.completed || (window.__lumoState?.textChanged && window.__lumoState.lastText !== prevText);
        },
        previousText,
        { timeout: currentTimeout }
      );

      const waitDuration = Date.now() - waitStart;

      // Fetch the current state from the browser
      const { text: currentText, completed } = await this.page.evaluate(() => {
        logger.debug('Text change detected, resetting flag');
        const text = window.__lumoState?.lastText || '';
        const completed = window.__lumoState?.completed || false;
        if (window.__lumoState) {
          window.__lumoState.textChanged = false;  // Reset so we wait for next change
        }
        return { text, completed };
      });

      logger.debug(`Delta (${waitDuration}ms, ${previousText.length}→${currentText.length}${completed ? ', complete' : ''}): ${currentText.slice(previousText.length)}`);

      return { text: currentText, completed };
    } catch (error) {
      // Timeout occurred
      return null;
    }
  }

  /**
   * Processes a text delta by invoking the callback if provided.
   */
  private async processDelta(delta: string, onDelta?: (delta: string) => void | Promise<void>): Promise<void> {
    if (delta.length > 0 && onDelta) {
      await onDelta(delta);
    }
  }

  /**
   * Finalizes the response by processing sources, tool calls, logging, and cleaning up.
   */
  private async finalizeResponse(
    currentText: string,
    onDelta?: (delta: string) => void | Promise<void>
  ): Promise<{ text: string; toolCalls: ToolCall[] | null }> {
    let finalText = currentText;
    const sources = await processSources(this.page);
    if (sources) {
      const sourcesText = formatSources(sources);
      finalText += sourcesText;
      // Send sources through the streaming callback
      await this.processDelta(sourcesText, onDelta);
    }

    const toolCalls = await processToolCalls(this.page);

    logger.info(`[Assistant] ${finalText}`);
    await this.cleanupObserver();
    return { text: finalText, toolCalls };
  }

  /**
   * Streams the chatbot's response as it's being generated in the browser DOM.
   *
   * HOW IT WORKS:
   * 1. Injects a MutationObserver into the browser to watch the last message container
   * 2. The observer tracks two things:
   *    - Text changes (new content being added to the response)
   *    - Completion indicator (e.g., a thumb-up icon that signals response is done)
   * 3. When either event occurs, the observer sets a flag (__lumoTextChanged) to notify us
   * 4. We use waitForFunction with a timeout to wait for these notifications
   * 5. When notified, we send any new text delta to the callback
   * 6. We exit when: completion indicator appears OR text stops changing for N seconds
   *
   * NORMAL EVENT FLOW:
   * - Setup phase: Inject observer into browser, start monitoring
   * - Streaming phase (repeats): Wait for change → Get new text → Send delta → Check completion
   * - Completion phase: Cleanup observer and return full text and tool calls
   *
   * COMPLETION CONDITIONS (whichever happens first):
   * - Completion indicator detected (immediate exit)
   * - No text changes for 2s (after some text received)
   * - No text changes for 20s (if no text received yet - indicates error/empty response)
   * - Overall timeout reached (default 60s)
   *
   * @param onDelta - Callback invoked with each new chunk of text as it arrives
   * @param timeoutMs - Maximum time to wait for the entire response (default 60s)
   * @returns The complete response text and any tool calls
   */
  async streamResponse(
    onDelta?: (delta: string) => void | Promise<void>,
    timeoutMs: number = 60000
  ): Promise<{ text: string; toolCalls: ToolCall[] | null }> {
    const startTime = Date.now();
    let previousText = '';
    const noChangeTimeoutWithText = responseTimeouts.withText;
    const noChangeTimeoutEmpty = responseTimeouts.empty;

    // Setup phase: Inject observer into browser
    await this.setupResponseObserver();

    // Streaming loop: Repeatedly wait for changes, send deltas, and check for completion
    while (Date.now() - startTime < timeoutMs) {
      const result = await this.waitForTextChange(
        previousText,
        noChangeTimeoutWithText,
        noChangeTimeoutEmpty
      );

      // Timeout occurred - response is complete
      if (result === null) {
        const elapsed = Date.now() - startTime;
        logger.warn(`Timeout after ${elapsed}ms, response considered complete`);

        const currentText = await this.page.evaluate(() => window.__lumoState?.lastText || '');
        const finalResult = await this.finalizeResponse(currentText || previousText, onDelta);
        return finalResult;
      }

      const { text: currentText, completed } = result;

      // Process the delta
      const delta = currentText.slice(previousText.length);
      await this.processDelta(delta, onDelta);
      previousText = currentText;

      // Check for completion
      if (completed) {
        logger.debug('Completion indicator detected, response complete');
        const finalResult = await this.finalizeResponse(currentText, onDelta);
        return finalResult;
      }
    }

    // Overall timeout reached
    await this.cleanupObserver();
    throw new Error('Response timeout');
  }

}
