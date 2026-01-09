import { Page } from 'playwright';
import { logger } from '../logger.js';
import { chatboxSelectors } from '../config.js';

/**
 * Starts a new chat by clicking the "new chat" button.
 * @param page - The Playwright page instance
 */
export async function startNewChat(page: Page): Promise<void> {
  logger.debug('Starting new chat...');
  await page
    .locator(chatboxSelectors.newChatButton)
    .click({ timeout: 1000 });
  logger.info('New chat started');
}

/**
 * Starts a private chat by creating a new chat and then clicking the private button.
 * @param page - The Playwright page instance
 */
export async function startPrivateChat(page: Page): Promise<void> {
  logger.debug('Starting private chat...');
  await startNewChat(page);
  await page
    .locator(chatboxSelectors.privateButton)
    .click({ timeout: 1000 });
  logger.info('Private chat started');
}
