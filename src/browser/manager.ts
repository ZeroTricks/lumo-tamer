import { chromium, BrowserContext, Page } from 'playwright';
import { browserConfig } from '../config.js';
import fs from 'fs/promises';
import path from 'path';

export class BrowserManager {
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  async initialize(): Promise<void> {
    console.log('Initializing browser...');

    // Ensure user data directory exists
    await fs.mkdir(browserConfig.userDataDir, { recursive: true });

    this.context = await chromium.launchPersistentContext(browserConfig.userDataDir, {
      headless: browserConfig.headless,
      viewport: { width: 1280, height: 720 },
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
      ],
    });

    console.log(`Browser launched (headless: ${browserConfig.headless})`);

    // Get or create page
    this.page = this.context.pages()[0] || await this.context.newPage();
    await this.page.goto(browserConfig.url);

    console.log(`Navigated to: ${browserConfig.url}`);
  }

  async getPage(): Promise<Page> {
    if (!this.page) {
      throw new Error('Browser not initialized. Call initialize() first.');
    }
    return this.page;
  }

  async close(): Promise<void> {
    await this.context?.close();
    console.log('Browser closed (session automatically persisted)');
  }
}
