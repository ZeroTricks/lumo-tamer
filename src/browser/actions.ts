import { Page } from 'playwright';
import { logger } from '../logger.js';

/**
 * Starts a new chat by clicking the "new chat" button.
 * @param page - The Playwright page instance
 */
export async function startNewChat(page: Page): Promise<void> {
  logger.debug('Starting new chat...');

  logger.debug('Waiting for new chat button...');
  await page.waitForSelector('use[*|href="#ic-pen-square"]', { timeout: 1000 });

  logger.debug('Clicking new chat button...');
  await page.click('use[*|href="#ic-pen-square"]');

  logger.info('New chat started');
}

/**
 * Starts a private chat by creating a new chat and then clicking the private button.
 * @param page - The Playwright page instance
 */
export async function startPrivateChat(page: Page): Promise<void> {
  logger.debug('Starting private chat...');

  // First, start a new chat
  await startNewChat(page);

  logger.debug('Waiting for private button...');
  await page.waitForSelector('.button-ghost-norm', { timeout: 1000 });

  logger.debug('Clicking private button...');
  await page.click('.button-ghost-norm');

  logger.info('Private chat started');
}
