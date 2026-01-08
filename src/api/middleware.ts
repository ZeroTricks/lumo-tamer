import express, { Request, Response, NextFunction } from 'express';
import { logger } from '../logger.js';

export function setupAuthMiddleware(apiKey: string): express.RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    // Skip auth for health endpoint
    if (req.path === '/health') {
      return next();
    }

    const key = req.headers.authorization?.replace('Bearer ', '');
    if (key !== apiKey) {
      return res.status(401).json({ error: 'Invalid API key' });
    }
    next();
  };
}

export function setupLoggingMiddleware(): express.RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    logger.debug(`${req.method} ${req.path}`);
    next();
  };
}
