import { Router, Request, Response } from 'express';
import { serverConfig } from '../../app/config.js';

export function createModelsRouter(): Router {
  const router = Router();

  router.get('/v1/models', (req: Request, res: Response) => {
    res.json({
      object: 'list',
      data: [
        {
          id: serverConfig.apiModelName,
          object: 'model',
          created: Date.now(),
          owned_by: 'lumo-bridge',
        },
      ],
    });
  });

  return router;
}
