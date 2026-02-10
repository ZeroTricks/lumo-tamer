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
  tamer server               Start API server
  tamer --help               Show this help

Commands:
  auth                       Authenticate to Proton (login, browser, or rclone)
  server                     Start OpenAI-compatible API server

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

function printServerHelp(): void {
  console.log(`
tamer server - Start OpenAI-compatible API server

Usage:
  tamer server               Start the API server
  tamer server --help        Show this help

The server listens on the port configured in config.yaml (default: 3003).
`);
}

// Handle --help before config/logger init (console.log gets shimmed after init)
if (args['--help'] && args._.length === 0) {
  printHelp();
  process.exit(0);
}

if (args._[0] === 'auth' && (args._.includes('--help') || args._.includes('-h'))) {
  printAuthHelp();
  process.exit(0);
}

if (args._[0] === 'server' && (args._.includes('--help') || args._.includes('-h'))) {
  printServerHelp();
  process.exit(0);
}

// Single init point - static imports now safe (help cases exited above)
import { initConfig, getLogConfig, getServerConfig } from './app/config.js';
import { initLogger, logger } from './app/logger.js';

const mode = args._[0] === 'server' ? 'server' : 'cli';
initConfig(mode);
initLogger(getLogConfig());

function handleFatalError(error: unknown): never {
  logger.fatal({ error });
  logger.flush();
  setTimeout(() => process.exit(1), 200);
  throw error; // never reached, satisfies return type
}

// Route commands
try {
  if (args._[0] === 'auth') {
    const { runAuthCommand } = await import('./auth/authenticate.js');
    await runAuthCommand(args._.slice(1));
    process.exit(0);
  }

  if (args._[0] === 'server') {
    const { Application } = await import('./app/index.js');
    const { APIServer } = await import('./api/server.js');
    const { validateTemplateOnce } = await import('./api/instructions.js');

    const serverConfig = getServerConfig();
    validateTemplateOnce(serverConfig.instructions.template);
    logger.info('Starting lumo-tamer API Server...');

    const app = await Application.create();
    const apiServer = new APIServer(app);
    await apiServer.start();

    process.on('SIGINT', () => { logger.info('\nShutting down...'); process.exit(0); });
    process.on('SIGTERM', () => { logger.info('\nShutting down...'); process.exit(0); });
  }
  else {
    // Default: CLI chat
    const { Application } = await import('./app/index.js');
    const { CLIClient } = await import('./cli/client.js');

    logger.info('Starting lumo-tamer cli...');
    const app = await Application.create();
    const cliClient = new CLIClient(app);
    await cliClient.run();
    process.exit(0);
  }
} catch (error) {
  handleFatalError(error);
}
