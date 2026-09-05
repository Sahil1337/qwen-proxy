import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';

const int = (fallback: number) => z.coerce.number().int().positive().default(fallback);
const bool = (fallback: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .transform((v) => v === 'true' || v === '1')
    .default(fallback);
const str = (fallback: string) => z.string().min(1).default(fallback);
const optionalStr = z.string().min(1).optional();

function buildEnv(runtimeEnv: Record<string, string | undefined>) {
  return createEnv({
    server: {
      PORT: int(8000),
      API_KEY: optionalStr,
      LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
      /** pretty = coloured human-readable; json = one JSON line per event; auto = pretty on a TTY. */
      LOG_FORMAT: z.enum(['pretty', 'json', 'auto']).default('auto'),

      OLLAMA_MANAGED: bool(true),
      OLLAMA_BIN: str('ollama'),
      OLLAMA_BASE_URL: z.url().default('http://127.0.0.1:11434'),
      OLLAMA_MODELS: optionalStr,
      OLLAMA_START_TIMEOUT_MS: int(30_000),
      OLLAMA_PRELOAD: bool(true),

      MODEL: str('qwen3.5:4b'),
      NUM_CTX: int(8192),
      /** -1 lets Ollama's auto-fit decide. */
      NUM_GPU: z.coerce.number().int().min(-1).default(34),
      KV_CACHE_TYPE: z.enum(['f16', 'q8_0', 'q4_0']).default('q8_0'),
      FLASH_ATTENTION: bool(true),
      KEEP_ALIVE: str('30m'),
      MAX_PARALLEL: int(2),

      DEFAULT_MODE: z.enum(['thinking', 'fast', 'adaptive']).default('adaptive'),
      THINK_BUDGET_TOKENS: int(1024),
      DEFAULT_MAX_TOKENS: int(2048),
      ADAPTIVE_SHORT_TOKENS: int(60),
      ADAPTIVE_TOOLS_THINK: bool(true),
      CLASSIFIER_TIMEOUT_MS: int(3000),

      TOOL_INJECTION: z.enum(['native', 'prompt']).default('native'),
      TOOL_SCHEMA_SLIM: bool(true),

      QUEUE_TIMEOUT_MS: int(120_000),
      UPSTREAM_TIMEOUT_MS: int(600_000),
      MAX_PROMPT_TOKENS: int(7000),
    },
    runtimeEnv,
    // "" counts as "unset" so .env templates can leave values blank.
    emptyStringAsUndefined: true,
  });
}

export type Config = ReturnType<typeof buildEnv>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return buildEnv(env);
}
