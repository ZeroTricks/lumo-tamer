import { Router, Request, Response } from 'express';
import { getServerConfig } from '../../app/config.js';

export function createModelsRouter(): Router {
  const router = Router();
  const serverConfig = getServerConfig();

  router.get('/v1/models', (req: Request, res: Response) => {
    res.json({
      object: 'list',
      data: serverConfig.allowedModels.map((id) => ({
        id,
        object: 'model',
        created: Date.now(),
        owned_by: 'proton',
      })),
    });
  });

  return router;
}
