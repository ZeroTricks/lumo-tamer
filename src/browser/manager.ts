import { chromium, BrowserContext, Page } from 'playwright';
import { browserConfig, chatboxSelectors } from '../config.js';
import {promises as dns} from 'dns';
import { logger } from '../logger.js';

const host = new URL(browserConfig.cdpEndpoint).hostname;

const { address } = await dns.lookup(host, {
  family: 4,
  hints: dns.ADDRCONFIG,
});

const ipEndPoint = browserConfig.cdpEndpoint.replace(host, address);

export class BrowserManager {
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  async initialize(): Promise<void> {
    logger.debug('Initializing browser...');
    logger.debug(`Connecting to remote browser at ${browserConfig.cdpEndpoint} (${ipEndPoint}) ...`);

    const browser = await chromium.connectOverCDP(ipEndPoint);

    // Get the default context (remote browsers don't support persistent contexts the same way)
    const contexts = browser.contexts();
    this.context = contexts.length > 0 ? contexts[0] : await browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });

    logger.info(`Connected to remote browser at ${browserConfig.cdpEndpoint} (${ipEndPoint})`);

    // Get or create page
    this.page = this.context.pages()[0] || await this.context.newPage();

    // Stub the __name helper to prevent TypeScript/tsx injection errors
    await this.page.addInitScript(() => {
      (window as any).__name = (func: any) => func;
    });

    // Forward browser console logs to Node.js
    this.page.on('console', (msg: any) => {
      const type = msg.type();
      const text = msg.text();
      logger.debug(`[Browser ${type}] ${text}`);
    });

    await this.page.goto(browserConfig.url);

    logger.info(`Navigated to: ${browserConfig.url}`);

    // Enable web search if configured
    if (browserConfig.enableWebSearch) {
      try {
        logger.debug(`Clicking web search button: ${chatboxSelectors.webSearch}`);
        await this.page.click(chatboxSelectors.webSearch);
        logger.info('Web search enabled');
      } catch (error) {
        logger.warn(`Failed to click web search button: ${error}`);
      }
    }
  }

  async getPage(): Promise<Page> {
    if (!this.page) {
      throw new Error('Browser not initialized. Call initialize() first.');
    }
    return this.page;
  }

  async close(): Promise<void> {
    await this.context?.close();
    logger.info('Browser closed (session automatically persisted)');
  }
}
