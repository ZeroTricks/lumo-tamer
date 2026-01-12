import { Page } from 'playwright';
import { chatboxSelectors, responseTimeouts, browserConfig } from '../config.js';
import { logger } from '../logger.js';
import { processSources, formatSources } from './sources.js';
import { processToolCalls } from './tools.js';
import { setBehaviour } from './behaviour.js';
import { openChatByKeyword, startNewChat, startPrivateChat } from './actions.js';
import type { ToolCall } from '../types.js';
import type { BrowserManager } from './manager.js';

export class ChatboxInteractor {
  private currentQueue: ReturnType<typeof this.createMutationQueue> | null = null;

  constructor(
    private page: Page,
    private browserManager: BrowserManager
  ) { }

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

  /**
   * Creates a mutation queue for event-driven communication from browser to Node.
   * The browser calls onMutation() when DOM changes, Node waits via waitForNext().
   */
  private createMutationQueue(): {
    onMutation: (text: string, hasCompletionMarker: boolean) => void;
    waitForNext: (timeout: number) => Promise<{ text: string; hasCompletionMarker: boolean } | null>;
  } {
    let pendingResolve: ((value: { text: string; hasCompletionMarker: boolean }) => void) | null = null;

    return {
      onMutation: (text: string, hasCompletionMarker: boolean) => {
        if (pendingResolve) {
          pendingResolve({ text, hasCompletionMarker });
          pendingResolve = null;
        }
      },
      waitForNext: (timeout: number) => {
        return new Promise((resolve) => {
          pendingResolve = resolve;

          // Timeout fallback
          setTimeout(() => {
            if (pendingResolve === resolve) {
              pendingResolve = null;
              resolve(null);
            }
          }, timeout);
        });
      }
    };
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

    logger.debug('Sending message...');
    // Clear existing text and type new message
    const inputElement = this.page.locator(chatboxSelectors.input);
    await inputElement.clear();
    await inputElement.fill(message);
    await inputElement.press('Enter');

    // Wait a moment for UI to update
    await new Promise(resolve => setTimeout(resolve, 100));

  }

  /**
   * Injects a MutationObserver into the browser to monitor the last message container.
   * Uses exposeBinding for event-driven communication from browser to Node.
   */
  private async setupResponseObserver(): Promise<{
    waitForNext: (timeout: number) => Promise<{ text: string; hasCompletionMarker: boolean } | null>;
  }> {
    const lastMessageSelector = chatboxSelectors.messages;

    // Create event queue in Node context
    const queue = this.createMutationQueue();
    this.currentQueue = queue;

    // Register callback with BrowserManager (binding already exposed during initialization)
    this.browserManager.setResponseMutationHandler((text: string, hasCompletionMarker: boolean) => {
      this.currentQueue?.onMutation(text, hasCompletionMarker);
    });

    logger.debug(`Injecting MutationObserver on last '${lastMessageSelector}...'`);

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
        logger.debug(`Locked onto container: ${lastMessageContainer.tagName} ${lastMessageContainer.className}`);

        // Minimal state - just container and observer
        window.__lumoState = {
          observer: null as any,
          lastMessageContainer
        };

        // Minimal mutation handler - just extract and send to Node
        const onMutation = () => {
          // Extract text from blocks
          const blocks = lastMessageContainer.querySelectorAll(contentElements);

          // Check for completion marker
          const hasCompletionMarker = !!lastMessageContainer.querySelector(messageCompletionMarker);

          // Determine last complete block (skip last if not completed)
          const lastCompleteBlockIndex = blocks.length - (hasCompletionMarker ? 0 : 1);

          // Extract text
          let fullText = '';
          for (let index = 0; index < lastCompleteBlockIndex; index++) {
            const block = blocks[index];
            fullText += (index > 0 ? '\n' : '') + (block.textContent || '');
          }

          // Send to Node - no comparison, no state tracking
          if (typeof window.__responseMutationHandler === 'function') {
            window.__responseMutationHandler(fullText, hasCompletionMarker);
          }
        };

        // Debouncing to reduce excessive calls
        let debounceTimer: ReturnType<typeof setTimeout> | null = null;
        const DEBOUNCE_MS = 50;

        const onMutationDebounced = () => {
          if (debounceTimer) {
            clearTimeout(debounceTimer);
          }

          debounceTimer = setTimeout(() => {
            onMutation();
            debounceTimer = null;
          }, DEBOUNCE_MS);
        };

        // Run once to capture initial state
        onMutation();
        logger.debug('Initial mutation sent');

        // Create MutationObserver that will call onMutation on every DOM change
        const observer = new MutationObserver((mutations) => {
          logger.debug(`Mutation detected, mutations: ${mutations.length}`);
          onMutationDebounced();
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

    return queue;
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
   * 2. Browser extracts text and completion marker on each mutation, sends via exposeBinding
   * 3. Node receives notifications through queue, compares text, calculates deltas
   * 4. All state tracking (completion, text comparison) happens in Node context
   * 5. We exit when: completion marker detected OR text stops changing for N seconds
   *
   * NORMAL EVENT FLOW:
   * - Setup phase: Create queue, expose binding, inject observer into browser
   * - Streaming phase (repeats): Wait for mutation → Compare text → Send delta → Check completion
   * - Completion phase: Cleanup observer and return full text and tool calls
   *
   * COMPLETION CONDITIONS (whichever happens first):
   * - Completion marker detected (immediate exit)
   * - No text changes for 5s (after some text received)
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
    let isCompleted = false;
    const noChangeTimeoutWithText = responseTimeouts.withText;
    const noChangeTimeoutEmpty = responseTimeouts.empty;

    // Setup phase: Create queue and inject observer
    const queue = await this.setupResponseObserver();

    // Streaming loop - all logic in Node
    while (Date.now() - startTime < timeoutMs) {
      const currentTimeout = previousText.length === 0
        ? noChangeTimeoutEmpty
        : noChangeTimeoutWithText;

      const result = await queue.waitForNext(currentTimeout);

      // Timeout occurred
      if (result === null) {
        const elapsed = Date.now() - startTime;
        logger.warn(`Timeout after ${elapsed}ms, response considered complete`);
        return await this.finalizeResponse(previousText, onDelta);
      }

      const { text: currentText, hasCompletionMarker } = result;

      // Track completion in Node
      if (hasCompletionMarker) {
        isCompleted = true;
      }

      // Calculate delta in Node (browser sent full text)
      if (currentText !== previousText) {
        const delta = currentText.slice(previousText.length);
        await this.processDelta(delta, onDelta);
        previousText = currentText;
      }

      // Check for completion
      if (isCompleted) {
        logger.debug('Completion marker detected, response complete');
        return await this.finalizeResponse(currentText, onDelta);
      }
    }

    // Overall timeout reached
    await this.cleanupObserver();
    throw new Error('Response timeout');
  }

}
