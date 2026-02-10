#!/usr/bin/env node
// Initialize config and logger before other imports
import { initConfig, getLogConfig, getServerConfig } from './app/config.js';
initConfig('server');

import { initLogger, logger } from './app/logger.js';
initLogger(getLogConfig());

import { Application } from './app/index.js';
import { APIServer } from './api/server.js';
import { validateTemplateOnce } from './api/instructions.js';

async function main() {
  // Validate server config early - will throw if missing
  const serverConfig = getServerConfig();

  // Validate template and replace patterns at startup
  validateTemplateOnce(serverConfig.instructions.template);

  logger.info('Starting lumo-tamer API Server...');

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

main().catch(async (error) => {
  logger.fatal({ error });
  logger.flush();
  await new Promise(resolve => setTimeout(resolve, 200));
  process.exit(1);
});
