import { Page } from 'playwright';
import { chatboxSelectors } from '../config.js';

// Extend Window interface for custom properties
declare global {
  interface Window {
    __lumoObserver?: MutationObserver;
    __lumoLastText?: string;
    __lumoTextChanged?: boolean;
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
      try {
        await this.page.waitForFunction(
          (expectedCount: number) => {
            const elements = document.querySelectorAll('.assistant-msg-container');
            const currentCount = elements.length;
            if (currentCount > expectedCount) {
              console.log('[Lumo Browser] Count increased!', currentCount, '>', expectedCount);
              return true;
            }
            return false;
          },
          { timeout: 20000, polling: 100 },
          messagesBefore
        );
        console.log('[Lumo] sendMessage: Container count increased');
      } catch (error) {
        console.error('[Lumo] sendMessage: Timeout waiting for container count increase:', error);
        throw error;
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

  async streamResponse(
    onDelta?: (delta: string) => void | Promise<void>,
    timeoutMs: number = 60000
  ): Promise<string> {
    console.log('[Lumo] streamResponse called, setting up MutationObserver');
    const startTime = Date.now();
    let previousText = '';
    const noChangeTimeoutWithText = 2000; // Complete after 2s of no changes when we have text
    const noChangeTimeoutEmpty = 20000; // Wait longer (10s) when no text received yet

    // Set up MutationObserver in the browser to watch the LAST .assistant-msg-container
    const selector = chatboxSelectors.messages;
    const contentElements = this.contentElements;

    console.log('[Lumo] About to inject MutationObserver with selector:', selector, 'contentElements:', contentElements);

    // Setup MutationObserver using a real function (with __name stub in place)
    await this.page.evaluate(
      ({ sel, cont }: { sel: string; cont: string }) => {
        console.log('[Lumo Browser] Setting up observer for selector:', sel, 'content:', cont);
        const win = window as any;

        if (win.__lumoObserver) {
          console.log('[Lumo Browser] Disconnecting existing observer');
          win.__lumoObserver.disconnect();
        }

        win.__lumoLastText = '';
        win.__lumoTextChanged = false;

        const updateText = () => {
          const containers = document.querySelectorAll(sel);
          console.log('[Lumo Browser] updateText: Found', containers.length, 'containers');
          if (containers.length === 0) return;

          const lastContainer = containers[containers.length - 1];
          const paragraphs = lastContainer.querySelectorAll(cont);
          console.log('[Lumo Browser] updateText: Found', paragraphs.length, 'paragraphs in last container');

          let fullText = '';
          paragraphs.forEach((p: any, i: number) => {
            fullText += (i > 0 ? '\n' : '') + (p.textContent || '');
          });

          if (fullText !== win.__lumoLastText) {
            console.log('[Lumo Browser] Text changed:', fullText.length, 'chars');
            win.__lumoLastText = fullText;
            win.__lumoTextChanged = true;
          }
        };

        updateText();
        console.log('[Lumo Browser] Initial text captured:', win.__lumoLastText ? win.__lumoLastText.length : 0, 'chars');

        const observer = new MutationObserver((mutations) => {
          console.log('[Lumo Browser] Mutation detected, mutations:', mutations.length);
          updateText();
        });

        const containers = document.querySelectorAll(sel);
        console.log('[Lumo Browser] Found', containers.length, 'containers for observation');
        if (containers.length > 0) {
          const lastContainer = containers[containers.length - 1];
          console.log('[Lumo Browser] Observing element:', lastContainer.tagName, lastContainer.className);

          observer.observe(lastContainer, {
            childList: true,
            subtree: true,
            characterData: true
          });

          win.__lumoObserver = observer;
          console.log('[Lumo Browser] Observer setup complete');
        } else {
          console.error('[Lumo Browser] No containers found to observe!');
        }
      },
      { sel: selector, cont: contentElements }
    );
    console.log('[Lumo] MutationObserver injection completed');

    // Event-driven loop: wait for text changes using waitForFunction
    while (Date.now() - startTime < timeoutMs) {
      try {
        console.log(`[Lumo] Waiting for text changes... (prevText length: ${previousText.length})`);

        // Use longer timeout when no text received yet (container may still be loading)
        const currentTimeout = previousText.length === 0 ? noChangeTimeoutEmpty : noChangeTimeoutWithText;
        console.log(`[Lumo] Using timeout: ${currentTimeout}ms`);

        // Wait for text to change or timeout
        await this.page.waitForFunction(
          (prevText: string) => {
            const win = window as any;
            return win.__lumoTextChanged && win.__lumoLastText !== prevText;
          },
          { timeout: currentTimeout },
          previousText
        );

        // Get the updated text and reset the flag
        const currentText = await this.page.evaluate(() => {
          console.log('[Lumo Browser] Text change detected, resetting flag');
          window.__lumoTextChanged = false;
          return window.__lumoLastText;
        });

        console.log(`[Lumo] Received text update: ${currentText.length} chars (was ${previousText.length})`);

        // Calculate and send delta
        const delta = currentText.slice(previousText.length);
        if (delta.length > 0 && onDelta) {
          console.log(`[Lumo] Sending delta: ${delta.length} chars`);
          await onDelta(delta);
        }

        previousText = currentText;

      } catch (error) {
        // Timeout means no changes detected for 2s - response is complete
        console.log('[Lumo] No changes detected for 2s, response complete');
        const finalText = await this.page.evaluate(() => window.__lumoLastText || '');

        // Clean up observer
        await this.page.evaluate(() => {
          console.log('[Lumo Browser] Cleaning up observer');
          if (window.__lumoObserver) {
            window.__lumoObserver.disconnect();
            delete window.__lumoObserver;
            delete window.__lumoLastText;
            delete window.__lumoTextChanged;
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
