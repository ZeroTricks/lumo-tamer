import { chromium, BrowserContext, Page } from 'playwright';
import { browserConfig, chatboxSelectors } from '../config.js';
import { promises as dns, ADDRCONFIG } from 'dns';
import { logger } from '../logger.js';

const host = new URL(browserConfig.cdpEndpoint).hostname;

const { address } = await dns.lookup(host, {
  family: 4,
  hints: ADDRCONFIG,
});

const ipEndPoint = browserConfig.cdpEndpoint.replace(host, address);

export class BrowserManager {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private responseMutationHandler: ((text: string, hasCompletionMarker: boolean) => void) | null = null;

  /**
   * Sets the mutation callback that will be invoked when browser mutations occur.
   * This should be called by ChatboxInteractor before streaming responses.
   */
  setResponseMutationHandler(callback: (text: string, hasCompletionMarker: boolean) => void): void {
    this.responseMutationHandler = callback;
  }

  async initialize(): Promise<void> {
    logger.debug('Initializing browser...');
    logger.debug(`Connecting to remote browser at ${browserConfig.cdpEndpoint} (${ipEndPoint}) ...`);

    const browser = await chromium.connectOverCDP(ipEndPoint);

    // Get the default context (remote browsers don't support persistent contexts the same way)
    const contexts = browser.contexts();
    this.context = contexts.length > 0 ? contexts[0] : await browser.newContext();

    logger.info(`Connected to remote browser at ${browserConfig.cdpEndpoint} (${ipEndPoint})`);

    // Get or create page
    this.page = this.context.pages()[0] || await this.context.newPage();

    // Expose binding for mutation observer to call from browser context
    await this.page.exposeBinding('__responseMutationHandler', (source, text: string, hasCompletionMarker: boolean) => {
      this.responseMutationHandler?.(text, hasCompletionMarker);
    });
    logger.debug('Registered __responseMutationHandler binding');

    await this.page.addInitScript(() => {
      const w = window as any;
      
      // Stub the __name helper to prevent TypeScript/tsx injection errors
      w.__name = (func: any) => func;

      // Allow for logger calls inside page contexts (console.logs don't work there anyway)
      w.logger = {
        ...w['console'],
        debug: w['console'].log,
        info: w['console'].log,
      };
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
        logger.debug(`Clicking web search button: ${chatboxSelectors.webSearchToggle}`);
        await this.page.click(chatboxSelectors.webSearchToggle);
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
