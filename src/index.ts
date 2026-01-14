import { APIServer } from './api/server.js';
import { logger } from './logger.js';

async function main() {
  logger.info('Starting Lumo Bridge...');

  const apiServer = new APIServer();
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
