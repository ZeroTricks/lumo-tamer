import { Page } from 'playwright';
import { chatboxSelectors, browserConfig } from '../config.js';
import { logger } from '../logger.js';
import type { Source } from '../types.js';

/**
 * Formats sources into a markdown string to append to the response.
 */
export function formatSources(sources: Source[]): string {
  const sourcesText = sources
    .map((source, index) => `[${index + 1}] ${source.title}: ${source.url}`)
    .join('\n');
  return `\n\nSources:\n${sourcesText}`;
}

/**
 * Processes sources detected in the response.
 * This is called once at the end of the response to extract source information.
 * Uses the target container stored in __lumoState to ensure we're checking the same
 * container that was being observed during streaming (avoids race conditions).
 *
 * Workflow:
 * 1. Check if sources icon exists in the target container
 * 2. Click the sources icon to open the sources panel
 * 3. Wait for .sources-panel to load
 * 4. Extract {url, title} pairs from the panel
 * 5. Return the sources array or null if none found
 *
 * @returns Array of sources with url and title, or null if no sources found
 */
export async function processSources(page: Page): Promise<Source[] | null> {
  if (!browserConfig.showSources || !chatboxSelectors.sources) {
    return null;
  }

  const sourcesSel = chatboxSelectors.sources;

  try {
    // Get the target container element handle from __lumoState
    // This ensures we're checking the same container that was observed during streaming
    const targetContainerHandle = await page.evaluateHandle(() => window.__lumoState?.targetContainer);
    const targetContainer = targetContainerHandle.asElement();

    if (!targetContainer) {
      logger.debug('No target container found in __lumoState');
      return null;
    }

    // Check if sources icons exist in the target container
    const sourcesIcons = await targetContainer.$$(sourcesSel);

    if (sourcesIcons.length === 0) {
      logger.debug('No sources found in response');
      return null; // No sources to process
    }

    logger.debug(`Found ${sourcesIcons.length} sources, extracting...`);

    // Click the first sources icon
    await sourcesIcons[0].click();

    // Wait for sources panel to appear
    logger.debug('Waiting for sources panel to load...');
    await page.waitForSelector('.sources-panel', { timeout: 5000 });

    // Get the sources panel
    const sourcesPanel = await page.$('.sources-panel');
    if (!sourcesPanel) {
      logger.warn('Sources panel not found after clicking');
      return null;
    }

    // Extract all links from the panel
    const linkHandles = await sourcesPanel.$$('a');
    const sources: Source[] = [];

    for (const link of linkHandles) {
      const urlSpan = await link.$('span');
      const titleP = await link.$('p');

      if (urlSpan && titleP) {
        const url = (await urlSpan.textContent())?.trim() || '';
        const title = (await titleP.textContent())?.trim() || '';

        if (url && title) {
          sources.push({ url, title });
        }
      }
    }

    logger.debug(`Extracted ${sources.length} sources`);

    if (sources.length > 0) {
      logger.info(`Found ${sources.length} sources:`);
      sources.forEach((source, index) => {
        logger.info(`  [${index + 1}] ${source.title} - ${source.url}`);
      });
      return sources;
    } else {
      logger.warn('Sources panel opened but no sources were extracted');
      return null;
    }
  } catch (error) {
    logger.error('Failed to extract sources:');
    logger.error(error);
    return null;
  }
}
