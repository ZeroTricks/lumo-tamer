import { BrowserManager } from './browser/manager.js';
import { APIServer } from './api/server.js';
import { logger } from './logger.js';

async function main() {
  logger.info('Starting Lumo Bridge...');

  const browserManager = new BrowserManager();
  await browserManager.initialize();

  const apiServer = new APIServer(browserManager);
  await apiServer.start();

  // Graceful shutdown
  process.on('SIGINT', async () => {
    logger.info('\nShutting down...');
    await browserManager.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    logger.info('\nShutting down...');
    await browserManager.close();
    process.exit(0);
  });
}

main().catch(console.error);
