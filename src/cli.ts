#!/usr/bin/env node
import arg from 'arg';

// Parse args before config init to handle --help without side effects
// stopAtPositional ensures --help after a subcommand is passed to the subcommand
const args = arg({
  '--help': Boolean,
  '-h': '--help',
}, {
  permissive: true,
  stopAtPositional: true,
  argv: process.argv.slice(2)
});

function printHelp(): void {
  console.log(`
lumo-tamer - Use Proton Lumo on the command line

Usage:
  tamer                      Interactive chat mode
  tamer "your prompt"        One-shot query
  tamer auth [method]        Authenticate to Proton
  tamer auth status          Show authentication status
  tamer --help               Show this help

Commands:
  auth                       Authenticate to Proton (login, browser, or rclone)

Options:
  -h, --help    Show help

`);
}

function printAuthHelp(): void {
  console.log(`
tamer auth - Authenticate to Proton

Usage:
  tamer auth                 Interactive method selection
  tamer auth <method>        Use specific method (login, browser, rclone)
  tamer auth status          Show current authentication status
  tamer auth --help          Show this help

Methods:
  login                      Enter Proton credentials
  browser                    Extract tokens from logged-in browser session
  rclone                     Paste rclone config section

`);
}

// Handle --help before config/logger init (console.log gets shimmed after init)
if (args['--help'] && args._.length === 0) {
  printHelp();
  process.exit(0);
}

// Handle tamer auth --help / tamer auth -h
if (args._[0] === 'auth' && (args._.includes('--help') || args._.includes('-h'))) {
  printAuthHelp();
  process.exit(0);
}

// Handle auth subcommand - init logger without console shim so console.log works
if (args._[0] === 'auth') {
  const { initConfig, getLogConfig } = await import('./app/config.js');
  initConfig('cli');
  const { initLogger } = await import('./app/logger.js');
  initLogger(getLogConfig(), { consoleShim: false });
  const { runAuthCommand } = await import('./auth/authenticate.js');
  await runAuthCommand(args._.slice(1));
  process.exit(0);
}

// Initialize config and logger for other commands
import { initConfig, getLogConfig } from './app/config.js';
initConfig('cli');

import { initLogger, logger } from './app/logger.js';
initLogger(getLogConfig());

// Default: run CLI client (chat)
import { Application } from './app/index.js';
import { CLIClient } from './cli/client.js';

async function main() {
  logger.info('Starting lumo-tamer cli...');

  const app = await Application.create();
  const cliClient = new CLIClient(app);
  await cliClient.run();

  process.exit(0);
}

main().catch(async (error) => {
  logger.fatal({ error });
  logger.flush();
  await new Promise(resolve => setTimeout(resolve, 200));
  process.exit(1);
});
