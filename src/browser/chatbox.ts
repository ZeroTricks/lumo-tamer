import { Page } from 'playwright';
import { chatboxSelectors, responseTimeouts } from '../config.js';

// Extend Window interface for custom properties
declare global {
  interface Window {
    __lumoObserver?: MutationObserver;
    __lumoLastText?: string;
    __lumoTextChanged?: boolean;
    __lumoCompleted?: boolean;
    __lumoLastChangeTime?: number;
  }
}

export class ChatboxInteractor {
  private contentElements = 'p';

  constructor(private page: Page) {}

  async sendMessage(message: string): Promise<void> {
    console.log('[Lumo] sendMessage: Waiting for input field...');
    // Wait for input to be available
    await this.page.waitForSelector(chatboxSelectors.input, { timeout: 10000 });

    console.log('[Lumo] sendMessage: Filling message...');
    // Clear existing text and type new message
    const inputElement = this.page.locator(chatboxSelectors.input);
    await inputElement.clear();
    await inputElement.fill(message);

    // Get the last message count before sending
    const messagesBefore = await this.page.locator(chatboxSelectors.messages).count();
    console.log(`[Lumo] sendMessage: Current message count: ${messagesBefore}`);

    // Click send button
    console.log('[Lumo] sendMessage: Clicking send button...');
    await this.page.click(chatboxSelectors.sendButton);

    // Wait a moment for UI to update
    await new Promise(resolve => setTimeout(resolve, 100));

    // Check count immediately after clicking
    const messagesAfterClick = await this.page.locator(chatboxSelectors.messages).count();
    console.log(`[Lumo] sendMessage: Message count after click: ${messagesAfterClick}`);

    // Wait for new assistant message container to appear (appears immediately with loading animation)
    console.log('[Lumo] sendMessage: Waiting for new assistant container...');

    if (messagesBefore === 0) {
      // First message - just wait for first container to appear
      console.log('[Lumo] sendMessage: First message - waiting for first container...');
      await this.page.waitForSelector(chatboxSelectors.messages, { timeout: 20000 });
      console.log('[Lumo] sendMessage: First container appeared');
    } else {
      // Subsequent messages - wait for count to increase
      console.log('[Lumo] sendMessage: Waiting for count to increase from', messagesBefore);

      // Check if count already increased
      if (messagesAfterClick > messagesBefore) {
        console.log('[Lumo] sendMessage: Container count already increased to', messagesAfterClick);
      } else {
        // If not, wait for it to increase
        try {
          await this.page.waitForFunction(
            ({ selector, expectedCount }: { selector: string; expectedCount: number }) => {
              const elements = document.querySelectorAll(selector);
              const currentCount = elements.length;
              console.log('[Lumo Browser] Checking count:', currentCount, 'expected:', expectedCount);
              if (currentCount > expectedCount) {
                console.log('[Lumo Browser] Count increased!', currentCount, '>', expectedCount);
                return true;
              }
              return false;
            },
            { timeout: 20000, polling: 100 },
            { selector: chatboxSelectors.messages, expectedCount: messagesBefore }
          );
          console.log('[Lumo] sendMessage: Container count increased');
        } catch (error) {
          console.error('[Lumo] sendMessage: Timeout waiting for container count increase:', error);
          throw error;
        }
      }
    }
  }

  async waitForResponse(timeoutMs: number = 60000): Promise<string> {
    const startTime = Date.now();
    let previousText = '';
    let stableCount = 0;
    const stabilityThreshold = 3; // Number of checks with same text to consider complete

    while (Date.now() - startTime < timeoutMs) {
      try {
        // Get all message elements and take the last one
        const messages = this.page.locator(chatboxSelectors.messages);
        const count = await messages.count();
        if (count === 0) {
          await new Promise(resolve => setTimeout(resolve, 500));
          continue;
        }
        const lastMessage = messages.nth(count - 1);
        const currentText = await lastMessage.innerText({ timeout: 1000 });

        // Check if text has stabilized (stopped changing)
        if (currentText === previousText && currentText.length > 0) {
          stableCount++;
          if (stableCount >= stabilityThreshold) {
            return currentText;
          }
        } else {
          stableCount = 0;
          previousText = currentText;
        }

        // Small delay between checks
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (error) {
        // Element might not be ready yet, continue waiting
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    throw new Error('Response timeout');
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
   * - Completion phase: Cleanup observer and return full text
   *
   * COMPLETION CONDITIONS (whichever happens first):
   * - Completion indicator detected (immediate exit)
   * - No text changes for 2s (after some text received)
   * - No text changes for 20s (if no text received yet - indicates error/empty response)
   * - Overall timeout reached (default 60s)
   *
   * @param onDelta - Callback invoked with each new chunk of text as it arrives
   * @param timeoutMs - Maximum time to wait for the entire response (default 60s)
   * @returns The complete response text
   */
  async streamResponse(
    onDelta?: (delta: string) => void | Promise<void>,
    timeoutMs: number = 60000
  ): Promise<string> {
    console.log('[Lumo] streamResponse called, setting up MutationObserver');
    const startTime = Date.now();
    let previousText = '';
    const noChangeTimeoutWithText = responseTimeouts.withText; // Complete after N ms of no changes when we have text
    const noChangeTimeoutEmpty = responseTimeouts.empty; // Wait longer when no text received yet

    // Set up MutationObserver in the browser to watch the LAST .assistant-msg-container
    const selector = chatboxSelectors.messages;
    const contentElements = this.contentElements;

    console.log('[Lumo] About to inject MutationObserver with selector:', selector, 'contentElements:', contentElements);

    // ========== BROWSER SETUP PHASE ==========
    // Inject a MutationObserver into the browser context that will monitor the DOM
    // for changes and set flags when text changes or completion indicator appears
    await this.page.evaluate(
      ({ sel, cont, indicatorSel }: { sel: string; cont: string; indicatorSel?: string }) => {
        console.log('[Lumo Browser] Setting up observer for selector:', sel, 'content:', cont, 'indicator:', indicatorSel);
        const win = window as any;

        // Clean up any existing observer from previous calls
        if (win.__lumoObserver) {
          console.log('[Lumo Browser] Disconnecting existing observer');
          win.__lumoObserver.disconnect();
        }

        // Initialize state flags that we'll check from Node.js
        win.__lumoLastText = '';           // Stores the accumulated text
        win.__lumoTextChanged = false;     // Flag: set to true when text or completion changes
        win.__lumoCompleted = false;       // Flag: set to true when completion indicator appears

        // This function is called on every DOM mutation
        const updateText = () => {
          const containers = document.querySelectorAll(sel);
          console.log('[Lumo Browser] updateText: Found', containers.length, 'containers');
          if (containers.length === 0) return;

          // Get the last message container (the current response)
          const lastContainer = containers[containers.length - 1];
          const paragraphs = lastContainer.querySelectorAll(cont);
          console.log('[Lumo Browser] updateText: Found', paragraphs.length, 'paragraphs in last container');

          // Extract all text from paragraph elements
          let fullText = '';
          paragraphs.forEach((p: any, i: number) => {
            fullText += (i > 0 ? '\n' : '') + (p.textContent || '');
          });

          // If text changed, update state and set change flag
          if (fullText !== win.__lumoLastText) {
            console.log('[Lumo Browser] Text changed:', fullText.length, 'chars');
            win.__lumoLastText = fullText;
            win.__lumoTextChanged = true;
          }

          // Check for completion indicator (e.g., thumb-up icon)
          if (indicatorSel && !win.__lumoCompleted) {
            const indicator = lastContainer.querySelector(indicatorSel);
            if (indicator) {
              console.log('[Lumo Browser] Completion indicator detected!');
              win.__lumoCompleted = true;
              win.__lumoTextChanged = true; // Wake up waitForFunction immediately
            }
          }
        };

        // Run updateText once to capture initial state
        updateText();
        console.log('[Lumo Browser] Initial text captured:', win.__lumoLastText ? win.__lumoLastText.length : 0, 'chars');

        // Create MutationObserver that will call updateText on every DOM change
        const observer = new MutationObserver((mutations) => {
          console.log('[Lumo Browser] Mutation detected, mutations:', mutations.length);
          updateText();
        });

        // Attach observer to the last message container
        const containers = document.querySelectorAll(sel);
        console.log('[Lumo Browser] Found', containers.length, 'containers for observation');
        if (containers.length > 0) {
          const lastContainer = containers[containers.length - 1];
          console.log('[Lumo Browser] Observing element:', lastContainer.tagName, lastContainer.className);

          observer.observe(lastContainer, {
            childList: true,      // Watch for added/removed child nodes
            subtree: true,        // Watch all descendants, not just direct children
            characterData: true   // Watch for text content changes
          });

          win.__lumoObserver = observer;
          console.log('[Lumo Browser] Observer setup complete');
        } else {
          console.error('[Lumo Browser] No containers found to observe!');
        }
      },
      { sel: selector, cont: contentElements, indicatorSel: chatboxSelectors.completionIndicator }
    );
    console.log('[Lumo] MutationObserver injection completed');

    // ========== STREAMING LOOP ==========
    // Repeatedly wait for changes, send deltas, and check for completion
    while (Date.now() - startTime < timeoutMs) {
      try {
        console.log(`[Lumo] Waiting for text changes... (prevText length: ${previousText.length})`);

        // Adaptive timeout: wait longer if we haven't received any text yet (empty response scenario)
        const currentTimeout = previousText.length === 0 ? noChangeTimeoutEmpty : noChangeTimeoutWithText;
        console.log(`[Lumo] Using timeout: ${currentTimeout}ms`);

        const waitStart = Date.now();

        // Custom timeout promise (because Playwright's built-in timeout doesn't work reliably)
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Custom timeout')), currentTimeout);
        });

        // Wait for __lumoTextChanged flag to become true OR timeout
        // The flag is set by the browser-side observer when text or completion indicator changes
        await Promise.race([
          this.page.waitForFunction(
            (prevText: string) => {
              const win = window as any;
              return win.__lumoTextChanged && win.__lumoLastText !== prevText;
            },
            { timeout: 300000 }, // Very long timeout - we control actual timeout with Promise.race
            previousText
          ),
          timeoutPromise
        ]);

        const waitDuration = Date.now() - waitStart;
        console.log(`[Lumo] waitForFunction returned after ${waitDuration}ms`);

        // Fetch the current state from the browser
        const { text: currentText, completed } = await this.page.evaluate(() => {
          console.log('[Lumo Browser] Text change detected, resetting flag');
          const text = window.__lumoLastText || '';
          const completed = window.__lumoCompleted || false;
          window.__lumoTextChanged = false;  // Reset so we wait for next change
          return { text, completed };
        });

        console.log(`[Lumo] Received text update: ${currentText.length} chars (was ${previousText.length}), completed: ${completed}`);

        // Calculate the delta (only the new text since last iteration)
        const delta = currentText.slice(previousText.length);
        if (delta.length > 0 && onDelta) {
          console.log(`[Lumo] Sending delta: ${delta.length} chars`);
          await onDelta(delta);  // Send new text chunk to callback
        }

        previousText = currentText;

        // ========== COMPLETION CHECK ==========
        // If the completion indicator was detected (e.g., thumb-up icon), exit immediately
        if (completed) {
          console.log('[Lumo] Completion indicator detected by observer, response complete');
          // Clean up observer
          await this.page.evaluate(() => {
            console.log('[Lumo Browser] Cleaning up observer');
            if (window.__lumoObserver) {
              window.__lumoObserver.disconnect();
              delete window.__lumoObserver;
              delete window.__lumoLastText;
              delete window.__lumoTextChanged;
              delete window.__lumoCompleted;
            }
          });
          return currentText;
        }

      } catch (error) {
        // ========== TIMEOUT COMPLETION ==========
        // No changes detected for N seconds - assume response is complete
        const elapsed = Date.now() - startTime;
        console.log(`[Lumo] Timeout after ${elapsed}ms, response complete`);
        const finalText = await this.page.evaluate(() => window.__lumoLastText || '');

        // Clean up observer
        await this.page.evaluate(() => {
          console.log('[Lumo Browser] Cleaning up observer');
          if (window.__lumoObserver) {
            window.__lumoObserver.disconnect();
            delete window.__lumoObserver;
            delete window.__lumoLastText;
            delete window.__lumoTextChanged;
            delete window.__lumoCompleted;
          }
        });

        return finalText || previousText;
      }
    }

    // Clean up observer on timeout
    await this.page.evaluate(() => {
      if (window.__lumoObserver) {
        window.__lumoObserver.disconnect();
        delete window.__lumoObserver;
        delete window.__lumoLastText;
        delete window.__lumoTextChanged;
      }
    });

    throw new Error('Response timeout');
  }

  async getPageTitle(): Promise<string> {
    return await this.page.title();
  }

  async getPageUrl(): Promise<string> {
    return this.page.url();
  }
}
