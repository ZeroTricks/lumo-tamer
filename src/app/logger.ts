import pino from 'pino';
import type { LogConfig } from './config.js';
import { resolveProjectPath } from './paths.js';

// Determine transport based on config
function getTransport(config: LogConfig): pino.TransportSingleOptions {
  if (config.target === 'file') {
    return {
      target: 'pino/file',
      options: {
        destination: resolveProjectPath(config.filePath),
        mkdir: true,
      },
    };
  }

  // Default: stdout with pretty printing
  return {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'HH:MM:ss',
      ignore: 'pid,hostname',
    },
  };
}

// Create logger instance with given config
export function createLogger(config: LogConfig): pino.Logger {
  return pino({
    level: config.level,
    transport: getTransport(config),
  });
}

// Module-level logger instance
// Must be initialized via initLogger() before use
let _logger: pino.Logger;

// Initialize the global logger with mode-specific config
// Must be called early in entry point, before other modules use logger
export function initLogger(config: LogConfig): void {
  _logger = createLogger(config);
}

// Get the global logger instance
export function getLogger(): pino.Logger {
  if (!_logger) {
    throw new Error('Logger not initialized. Call initLogger() first.');
  }
  return _logger;
}

// Export logger as a getter for convenience
// Will throw if accessed before initLogger()
export const logger = new Proxy({} as pino.Logger, {
  get(_target, prop) {
    return (getLogger() as unknown as Record<string | symbol, unknown>)[prop];
  },
});

export default logger;
