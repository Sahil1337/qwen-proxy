import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { HttpOllamaClient } from './core/ollama.js';
import { OllamaSupervisor, preloadModel } from './core/supervisor.js';
import { createLogger } from './util/logger.js';

const config = loadConfig();
const log = createLogger(config.LOG_LEVEL);
const client = new HttpOllamaClient(config.OLLAMA_BASE_URL, config.UPSTREAM_TIMEOUT_MS);
const supervisor = config.OLLAMA_MANAGED ? new OllamaSupervisor(config, client, log) : undefined;

const SHUTDOWN_GRACE_MS = 15_000;

async function main(): Promise<void> {
  if (supervisor) await supervisor.start();
  else log.info({ url: config.OLLAMA_BASE_URL }, 'OLLAMA_MANAGED=false; using external Ollama');
  if (config.OLLAMA_PRELOAD) await preloadModel(client, config, log);

  const { app } = createApp({ config, client, log, ...(supervisor ? { supervisor } : {}) });
  const server = app.listen(config.PORT, () => {
    log.info(
      {
        port: config.PORT,
        model: config.MODEL,
        mode: config.DEFAULT_MODE,
        num_ctx: config.NUM_CTX,
        num_gpu: config.NUM_GPU,
      },
      'qwen-proxy listening',
    );
  });

  const shutdown = (signal: string) => {
    log.info({ signal }, 'shutting down');
    const force = setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS).unref();
    server.close(async () => {
      await supervisor?.stop();
      clearTimeout(force);
      process.exit(0);
    });
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  log.fatal({ err }, 'startup failed');
  process.exit(1);
});
