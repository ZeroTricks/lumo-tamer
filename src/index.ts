// Install console shim early, before importing upstream modules
import { installConsoleShim } from './proton-shims/console.js';
installConsoleShim();

import { Application } from './app/index.js';
import { APIServer } from './api/server.js';
import { CLIClient } from './cli/client.js';
import { serverConfig, cliConfig } from './app/config.js';
import { logger } from './app/logger.js';

async function main() {
  logger.info('Starting Lumo Bridge...');

  // Create shared application context
  const app = await Application.create();

  // Start API server if enabled (default: true)
  if (serverConfig.enabled !== false) {
    const apiServer = new APIServer(app);
    await apiServer.start();
  }

  // Start CLI if enabled
  if (cliConfig?.enabled) {
    const cliClient = new CLIClient(app);
    await cliClient.run();

    // If CLI-only mode (no server), exit after CLI ends
    if (serverConfig.enabled === false) {
      process.exit(0);
    }
    // If both modes, CLI has ended but server keeps running
    logger.info('CLI session ended. API server still running.');
  }

  // If neither mode is enabled, warn and exit
  if (serverConfig.enabled === false && !cliConfig?.enabled) {
    logger.warn('Neither API server nor CLI is enabled. Nothing to do.');
    process.exit(0);
  }

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
