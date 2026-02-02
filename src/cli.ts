#!/usr/bin/env node
// Initialize config and logger before other imports
import { initConfig, getLogConfig } from './app/config.js';
initConfig('cli');

import { initLogger, logger } from './app/logger.js';
initLogger(getLogConfig());

import { Application } from './app/index.js';
import { CLIClient } from './cli/client.js';

async function main() {
  logger.info('Starting lumo-tamer cli...');

  const app = await Application.create();
  const cliClient = new CLIClient(app);
  await cliClient.run();

  process.exit(0);
}

main().catch(async (err) => {
  logger.fatal({ error: err.message, stack: err.stack });
  logger.flush();
  await new Promise(resolve => setTimeout(resolve, 200));
  process.exit(1);
});
