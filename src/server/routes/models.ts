import { Router } from 'express';
import type { AppContext } from '../app.js';

export function modelsRouter(ctx: AppContext): Router {
  const router = Router();
  const model = { id: ctx.config.MODEL, object: 'model' as const, created: ctx.startedAt, owned_by: 'ollama' };

  router.get('/models', (_req, res) => {
    res.json({ object: 'list', data: [model] });
  });
  router.get('/models/:id', (req, res, next) => {
    if (req.params.id === model.id) res.json(model);
    else next();
  });
  return router;
}
