#!/usr/bin/env node

import arg from 'arg';
import './shims/uint8array-base64-polyfill.js';

const args = arg({
  '--help': Boolean,
  '-h': '--help',
  '--home': String,
}, {
  permissive: true,
  argv: process.argv.slice(2)
});

// Initialize home directory BEFORE importing config (which has eager loaders)
import { initHome } from './app/paths.js';
initHome(args['--home']);

// Now safe to import config and logger
const { initConfig, getLogConfig } = await import('./app/config.js');
const { initLogger, logger } = await import('./app/logger.js');
const { printAuthHelp, printHelp, printServerHelp } = await import('./app/terminal.js');

const mode = args._[0] === 'server' ? 'server' : 'cli';
initConfig(mode);
initLogger(getLogConfig());

// Handle --help for main command and subcommands
if (args['--help'] || args._.includes('--help') || args._.includes('-h')) {
  switch (args._[0]) {
    case 'auth': printAuthHelp(); break;
    case 'server': printServerHelp(); break;
    default: printHelp();
  }
  process.exit(0);
}


// Handle uncaught errors with proper log flush (stack trace depends on log.target config)
async function handleFatalError(error: unknown): Promise<never> {
  logger.fatal({ error });
  await new Promise<void>((resolve) => logger.flush(() => resolve()));
  process.exit(1);
}
process.on('unhandledRejection', handleFatalError);
process.on('uncaughtException', handleFatalError);

// Route commands
if (args._[0] === 'auth') {
  const { runAuthCommand } = await import('./auth/authenticate.js');
  await runAuthCommand(args._.slice(1));
  process.exit(0);
} else if (args._[0] === 'server') {
  const { Application } = await import('./app/index.js');
  const { APIServer } = await import('./api/server.js');

  logger.info('Starting lumo-tamer API Server...');

  const app = await Application.create();
  const apiServer = new APIServer(app);
  await apiServer.start();

  process.on('SIGINT', () => { logger.info('\nShutting down...'); process.exit(0); });
  process.on('SIGTERM', () => { logger.info('\nShutting down...'); process.exit(0); });
} else {
  // Default: CLI chat
  const { Application } = await import('./app/index.js');
  const { CLIClient } = await import('./cli/client.js');

  logger.info('Starting lumo-tamer cli...');
  const app = await Application.create();
  const cliClient = new CLIClient(app);
  await cliClient.run();
  process.exit(0);
}
