// Metrics middleware for request tracking
import { Request, Response, NextFunction } from 'express';
import type { MetricsService } from './service.js';

// Normalize paths to base endpoints for consistent labeling
function normalizeEndpoint(path: string): string {
  if (path.startsWith('/v1/responses')) return '/v1/responses';
  if (path.startsWith('/v1/chat/completions')) return '/v1/chat/completions';
  if (path.startsWith('/v1/models')) return '/v1/models';
  if (path.startsWith('/v1/auth')) return '/v1/auth';
  return path;
}

export function createMetricsMiddleware(metrics: MetricsService): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction) => {
    const startTime = process.hrtime.bigint();

    res.on('finish', () => {
      const endpoint = normalizeEndpoint(req.path);
      const duration = Number(process.hrtime.bigint() - startTime) / 1e9;

      // Determine streaming from request body (if available)
      const streaming = req.body?.stream === true ? 'true' : 'false';

      metrics.httpRequestsTotal.inc({
        endpoint,
        method: req.method,
        status: res.statusCode.toString(),
        streaming,
      });

      metrics.httpRequestDuration.observe(
        { endpoint, method: req.method },
        duration
      );
    });

    next();
  };
}
