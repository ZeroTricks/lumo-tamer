import pino from 'pino';
import { serverConfig } from './config.js';

// Get log level from config
const logLevel = serverConfig.logLevel;

// Create logger instance with pretty printing for development
export const logger = pino({
  level: logLevel,
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'HH:MM:ss',
      ignore: 'pid,hostname',
    },
  },
});

// Export convenience methods
export default logger;
