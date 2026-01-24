// Install console shim early, before importing upstream modules
import { installConsoleShim } from './proton-shims/console.js';
installConsoleShim();

// Initialize config mode and logger before other imports
import { initConfig, getLogConfig } from './app/config.js';
initConfig('cli');

import { initLogger, logger } from './app/logger.js';
initLogger(getLogConfig());

import { Application } from './app/index.js';
import { CLIClient } from './cli/client.js';

async function main() {
  logger.info('Starting Lumo Bridge CLI...');

  const app = await Application.create();
  const cliClient = new CLIClient(app);
  await cliClient.run();

  process.exit(0);
}

main().catch(console.error);
