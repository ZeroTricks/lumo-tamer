import { Router, Request, Response } from 'express';
import { EndpointDependencies } from '../types.js';

export function createHealthRouter(deps: EndpointDependencies): Router {
  const router = Router();

  router.get('/health', (req: Request, res: Response) => {
    const authManager = deps.authManager;
    const auth = authManager?.getHealth() ?? { available: false };

    res.json({
      status: 'ok',
      queue: {
        size: deps.queue.getSize(),
        pending: deps.queue.getPending(),
      },
      auth,
    });
  });

  return router;
}
