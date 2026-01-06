import { Page } from 'playwright';
import { chatboxSelectors } from '../config.js';

export class ChatboxInteractor {
  constructor(private page: Page) {}

  async sendMessage(message: string): Promise<void> {
    // Wait for input to be available
    await this.page.waitForSelector(chatboxSelectors.input, { timeout: 10000 });

    // Clear existing text and type new message
    const inputElement = this.page.locator(chatboxSelectors.input);
    await inputElement.clear();
    await inputElement.fill(message);

    // Get the last message count before sending
    const messagesBefore = await this.page.locator(chatboxSelectors.messages).count();

    // Click send button
    await this.page.click(chatboxSelectors.sendButton);

    // Wait for new message to appear (our sent message)
    await this.page.waitForFunction(
      ({ selector, count }) => {
        const elements = document.querySelectorAll(selector);
        return elements.length > count;
      },
      { selector: chatboxSelectors.messages, count: messagesBefore },
      { timeout: 10000 }
    );
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

  async *streamResponse(timeoutMs: number = 60000): AsyncGenerator<string, void, unknown> {
    const startTime = Date.now();
    let previousText = '';
    let stableCount = 0;
    const stabilityThreshold = 3;

    while (Date.now() - startTime < timeoutMs) {
      try {
        // Get all message elements and take the last one
        const messages = this.page.locator(chatboxSelectors.messages);
        const count = await messages.count();
        if (count === 0) {
          await new Promise(resolve => setTimeout(resolve, 100));
          continue;
        }
        const lastMessage = messages.nth(count - 1);
        const currentText = await lastMessage.innerText({ timeout: 1000 });

        // If text has changed, yield the delta
        if (currentText !== previousText) {
          const delta = currentText.slice(previousText.length);
          if (delta.length > 0) {
            yield delta;
            stableCount = 0;
          }
          previousText = currentText;
        } else if (currentText.length > 0) {
          // Text hasn't changed
          stableCount++;
          if (stableCount >= stabilityThreshold) {
            // Response complete
            return;
          }
        }

        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        // Continue waiting
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    throw new Error('Response timeout');
  }

  async getPageTitle(): Promise<string> {
    return await this.page.title();
  }

  async getPageUrl(): Promise<string> {
    return this.page.url();
  }
}
