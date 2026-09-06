import { Router } from 'express';
import type { AppContext } from '../app.js';
import { asyncHandler } from '../middleware.js';

const PROBE_TIMEOUT_MS = 2000;

export function healthRouter(ctx: AppContext): Router {
  const { client, config, queue, supervisor } = ctx;
  const router = Router();

  router.get(
    '/health',
    asyncHandler(async (_req, res) => {
      const [version, running] = await Promise.allSettled([
        client.version(AbortSignal.timeout(PROBE_TIMEOUT_MS)),
        client.ps(AbortSignal.timeout(PROBE_TIMEOUT_MS)),
      ]);
      const reachable = version.status === 'fulfilled';
      const models = running.status === 'fulfilled' ? running.value : [];
      const loaded = models.find((m) => m.name === config.MODEL || m.model === config.MODEL);

      res.status(reachable ? 200 : 503).json({
        status: reachable ? 'ok' : 'degraded',
        ollama: {
          reachable,
          version: reachable ? version.value : null,
          managed: supervisor ? !supervisor.external : false,
          pid: supervisor?.managedPid ?? null,
        },
        model: {
          name: config.MODEL,
          loaded: Boolean(loaded),
          size_vram: loaded?.size_vram ?? null,
          context_length: loaded?.context_length ?? null,
        },
        queue: { waiting: queue.waiting, running: queue.running, concurrency: config.MAX_PARALLEL },
      });
    }),
  );
  return router;
}
