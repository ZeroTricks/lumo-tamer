// Install console shim early, before importing upstream modules
import { installConsoleShim } from './proton-shims/console.js';
installConsoleShim();

import { APIServer } from './api/server.js';
import { logger } from './logger.js';

async function main() {
  logger.info('Starting Lumo Bridge...');

  const apiServer = await APIServer.create();
  await apiServer.start();

  // Graceful shutdown
  process.on('SIGINT', () => {
    logger.info('\nShutting down...');
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    logger.info('\nShutting down...');
    process.exit(0);
  });
}

main().catch(console.error);
