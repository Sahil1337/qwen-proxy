import { Ajv } from 'ajv';
import express, { Router, type Express } from 'express';
import type { Config } from './config.js';
import type { OllamaClient } from './core/ollama.js';
import { RequestQueue } from './core/queue.js';
import { createClassifier, type Classifier } from './core/router.js';
import type { OllamaSupervisor } from './core/supervisor.js';
import { bearerAuth, errorHandler, notFound, requestId } from './middleware.js';
import { chatRouter } from './routes/chat.js';
import { healthRouter } from './routes/health.js';
import { modelsRouter } from './routes/models.js';
import { routeRouter } from './routes/route.js';
import type { Logger } from './util/logger.js';

export interface AppDeps {
  config: Config;
  client: OllamaClient;
  log: Logger;
  supervisor?: OllamaSupervisor;
  /** Injectable for tests; defaults to one model call. */
  classify?: Classifier;
}

/** Everything a route handler needs. */
export interface AppContext extends AppDeps {
  ajv: Ajv;
  queue: RequestQueue;
  classify: Classifier;
  startedAt: number;
}

export function createApp(deps: AppDeps): { app: Express; ctx: AppContext } {
  const ctx: AppContext = {
    ...deps,
    ajv: new Ajv({ allErrors: true, strict: false }),
    queue: new RequestQueue(deps.config.MAX_PARALLEL, deps.config.QUEUE_TIMEOUT_MS),
    classify: deps.classify ?? createClassifier(deps.client, deps.config),
    startedAt: Math.floor(Date.now() / 1000),
  };

  const app = express();
  app.disable('x-powered-by');
  app.use(requestId());
  app.use(express.json({ limit: '2mb' }));

  app.use(healthRouter(ctx));

  const v1 = Router();
  v1.use(bearerAuth(ctx.config.API_KEY));
  v1.use(chatRouter(ctx));
  v1.use(modelsRouter(ctx));
  v1.use(routeRouter(ctx));
  app.use('/v1', v1);

  app.use(notFound);
  app.use(errorHandler(ctx.log));
  return { app, ctx };
}
