import pino from 'pino';
import { logConfig } from './config.js';

// Determine transport based on config
function getTransport(): pino.TransportSingleOptions {
  const target = logConfig?.target ?? 'stdout';

  if (target === 'file') {
    return {
      target: 'pino/file',
      options: {
        destination: logConfig?.filePath ?? 'lumo-bridge.log',
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

// Create logger instance
export const logger = pino({
  level: logConfig?.level ?? 'info',
  transport: getTransport(),
});

// Export convenience methods
export default logger;
