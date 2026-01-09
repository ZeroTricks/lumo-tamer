import { Page } from 'playwright';
import { logger } from '../logger.js';
import { chatboxSelectors } from '../config.js';

/**
 * Sets the behaviour text in the application's personalization settings.
 *
 * @param page - Playwright page instance
 * @param behaviourText - The text to enter in the behaviour field
 */
export async function setBehaviour(page: Page, behaviourText: string): Promise<void> {
  logger.info('Setting behaviour in personalization settings...');

  // Open settings and navigate to personalization
  await page
    .locator(chatboxSelectors.settingsCog)
    .click();

  await page
    .locator(chatboxSelectors.personalizationMenu)
    .click();

  // Enter behaviour text
  await page
    .locator(chatboxSelectors.behaviourField)
    .first()  // there's another for mobile
    .fill(behaviourText, { timeout: 1000 });

  // Save and close
  await page
    .locator(chatboxSelectors.saveSettings)
    .first()  // there's another for mobile
    .click({force: true}); // possibly disabled when nothing changed

  await page
    .locator(chatboxSelectors.modalClose)
    .click();

  logger.info('Behaviour successfully set');
}
