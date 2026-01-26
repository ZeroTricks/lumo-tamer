// Install console shim early, before importing upstream modules
import { installConsoleShim } from './proton-shims/console.js';
installConsoleShim();

// Initialize config mode and logger before other imports
import { initConfig, getLogConfig, getServerConfig } from './app/config.js';
initConfig('server');

import { initLogger, logger } from './app/logger.js';
initLogger(getLogConfig());

import { Application } from './app/index.js';
import { APIServer } from './api/server.js';

async function main() {
  // Validate server config early - will throw if missing
  getServerConfig();

  logger.info('Starting Lumo Bridge API Server...');

  const app = await Application.create();
  const apiServer = new APIServer(app);
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

main().catch((err) => {
  logger.fatal({ error: err.message, stack: err.stack }, 'Fatal error');
  process.exit(1);
});
