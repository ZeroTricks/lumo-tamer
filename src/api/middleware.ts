import express, { Request, Response, NextFunction } from 'express';
import { logger } from '../app/logger.js';
import { getMetrics } from '../app/metrics.js';

export function setupAuthMiddleware(apiKey: string): express.RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    // Skip auth for health and metrics endpoints
    if (req.path === '/health' || req.path === '/metrics') {
      return next();
    }

    const key = req.headers.authorization?.replace('Bearer ', '');
    if (key !== apiKey) {
      getMetrics()?.authFailuresTotal.inc();
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
