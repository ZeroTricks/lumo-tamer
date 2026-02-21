// Metrics router - exposes /metrics endpoint for Prometheus
import { Router } from 'express';
import type { MetricsService } from '../../app/metrics.js';

export function createMetricsRouter(metrics: MetricsService): Router {
  const router = Router();

  router.get('/metrics', async (_req, res) => {
    res.set('Content-Type', metrics.getContentType());
    res.end(await metrics.getMetrics());
  });

  return router;
}
