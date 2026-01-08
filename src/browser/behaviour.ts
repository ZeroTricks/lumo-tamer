import { Page } from 'playwright';
import { logger } from '../logger.js';

/**
 * Sets the behaviour text in the application's personalization settings.
 *
 * @param page - Playwright page instance
 * @param behaviourText - The text to enter in the behaviour field
 */
export async function setBehaviour(page: Page, behaviourText: string): Promise<void> {
  logger.info('Setting behaviour in personalization settings...');

  // Step 1: Open settings by clicking the cog wheel icon
  logger.debug('Opening settings...');
  await page.click('use[*|href="#ic-cog-wheel"]');

  // Step 2: Wait for and click the personalization tab (sliders icon)
  logger.debug('Waiting for personalization tab...');
  await page.waitForSelector('use[*|href="#ic-sliders"]', { timeout: 10000 });
  logger.debug('Clicking personalization tab...');
  await page.click('use[*|href="#ic-sliders"]');

  // Step 3: Wait for the behaviour textarea and enter text
  logger.debug('Waiting for behaviour textarea...');
  const behaviourSelector = '.personalization-field:nth-child(4) textarea:nth-child(1)';
  await page.waitForSelector(behaviourSelector, { timeout: 10000 });
  logger.debug(`Entering behaviour text: ${behaviourText}`);
  await page.fill(behaviourSelector, behaviourText);

  // Step 4: Save by clicking the save button
  logger.debug('Saving settings...');
  await page.click('.personalization-footer .button-solid-norm');

  // Step 5: Close settings dialog
  logger.debug('Closing settings...');
  await page.click('.modal-close-button');

  logger.info('Behaviour successfully set');
}
