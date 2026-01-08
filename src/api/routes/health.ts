import { Router, Request, Response } from 'express';
import { EndpointDependencies } from '../types.js';

export function createHealthRouter(deps: EndpointDependencies): Router {
  const router = Router();

  router.get('/health', (req: Request, res: Response) => {
    res.json({
      status: 'ok',
      queue: {
        size: deps.queue.getSize(),
        pending: deps.queue.getPending()
      }
    });
  });

  return router;
}
