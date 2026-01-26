import pino from 'pino';
import type { LogConfig } from './config.js';
import { resolveProjectPath } from './paths.js';

// Determine transport based on config
function getTransport(config?: LogConfig): pino.TransportSingleOptions {
  const target = config?.target ?? 'stdout';

  if (target === 'file') {
    return {
      target: 'pino/file',
      options: {
        destination: resolveProjectPath(config?.filePath ?? 'lumo-bridge.log'),
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
export function createLogger(config?: LogConfig): pino.Logger {
  return pino({
    level: config?.level ?? 'info',
    transport: getTransport(config),
  });
}

// Module-level logger instance, initialized lazily or via initLogger()
let _logger: pino.Logger | null = null;

// Initialize the global logger with mode-specific config
// Must be called early in entry point, before other modules use logger
export function initLogger(config?: LogConfig): void {
  _logger = createLogger(config);
}

// Get the global logger instance
// Falls back to default config if not initialized
export const logger: pino.Logger = new Proxy({} as pino.Logger, {
  get(_target, prop) {
    if (!_logger) {
      // Lazy init with default config if not explicitly initialized
      _logger = createLogger();
    }
    return (_logger as unknown as Record<string | symbol, unknown>)[prop];
  },
});

export default logger;
