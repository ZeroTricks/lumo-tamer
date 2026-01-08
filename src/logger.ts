import pino from 'pino';

// Get log level from environment, default to 'debug'
const logLevel = (process.env.LOG_LEVEL || 'debug').toLowerCase();

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
