import { Page } from 'playwright';
import { chatboxSelectors, browserConfig } from '../config.js';
import { logger } from '../logger.js';

export interface Source {
  url: string;
  title: string;
}

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

  // Check if sources exist and get the first one to click
  const sourcesIconExists = await page.evaluate(
    (sourcesSel: string) => {
      const targetContainer = window.__lumoState?.targetContainer;
      if (!targetContainer) {
        console.log('[Lumo Browser] No target container in state');
        return false;
      }

      const sources = targetContainer.querySelectorAll(sourcesSel);
      if (sources.length > 0) {
        console.log('[Lumo Browser] Found', sources.length, 'sources at completion');
        return true;
      }
      return false;
    },
    sourcesSel
  );

  if (!sourcesIconExists) {
    return null; // No sources to process
  }

  logger.debug('Sources were detected in the response, extracting...');

  try {
    // Click the sources icon using the stored target container
    await page.evaluate(
      (sourcesSel: string) => {
        const targetContainer = window.__lumoState?.targetContainer;
        if (!targetContainer) return;

        const sourcesIcon = targetContainer.querySelector(sourcesSel) as HTMLElement;
        if (sourcesIcon) {
          console.log('[Lumo Browser] Clicking sources icon');
          sourcesIcon.click();
        }
      },
      sourcesSel
    );

    // Wait for sources panel to appear
    logger.debug('Waiting for sources panel to load...');
    await page.waitForSelector('.sources-panel', { timeout: 5000 });

    // Extract sources from the panel
    const sources = await page.evaluate(() => {
      const panel = document.querySelector('.sources-panel');
      if (!panel) return [];

      const links = panel.querySelectorAll('a');
      const results: Array<{ url: string; title: string }> = [];

      links.forEach((link) => {
        const urlSpan = link.querySelector('span');
        const titleP = link.querySelector('p');

        if (urlSpan && titleP) {
          const url = urlSpan.textContent?.trim() || '';
          const title = titleP.textContent?.trim() || '';

          if (url && title) {
            results.push({ url, title });
          }
        }
      });

      console.log('[Lumo Browser] Extracted', results.length, 'sources');
      return results;
    });

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
