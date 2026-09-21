/**
 * Runtime configuration for the API process, read from that app's own
 * `.env` — never a shared root one: the proxy runs on a different machine
 * from the API, and a shared env file would be a lie.
 *
 * Validated with `@t3-oss/env-core` + zod, the same way `apps/proxy` does it,
 * so a missing or malformed value fails at startup with the variable named
 * rather than surfacing as `undefined` three layers down.
 *
 * The `Config` the rest of the system sees is deliberately *not* the env
 * shape: env names are an implementation detail of this file, so renaming
 * `PROXY_BASE_URL` never ripples into `apps/api`. Deployment owns the left
 * side, the composition root reads the right side.
 *
 * Bun loads `.env` from the process's working directory on its own, so there
 * is no loader here.
 */

import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export type Config = {
  /** Where the API listens. */
  port: number;
  /** qwen-proxy, e.g. http://nitro.lan:8000. */
  proxyBaseUrl: string;
  proxyApiKey: string | undefined;
  /** The embedding service (runs on the Mac in the prototype, not on the GPU laptop). */
  embedderBaseUrl: string;
  /** Extraction window target in seconds; see windows.ts. */
  windowSeconds: number;
  /** Where the JSON vector index lives, until a database replaces it. */
  indexPath: string;
};

function readEnv(runtimeEnv: Record<string, string | undefined>) {
  return createEnv({
    server: {
      PORT: z.coerce.number().int().positive().default(3000),
      /** Required: there is no sensible default for someone else's machine. */
      PROXY_BASE_URL: z.url(),
      PROXY_API_KEY: z.string().min(1).optional(),
      EMBEDDER_BASE_URL: z.url(),
      WINDOW_SECONDS: z.coerce.number().int().positive().default(150),
      INDEX_PATH: z.string().min(1).default("data/index.json"),
    },
    runtimeEnv,
    // "" counts as "unset" so .env templates can leave values blank.
    emptyStringAsUndefined: true,
  });
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const e = readEnv(env);
  return {
    port: e.PORT,
    proxyBaseUrl: e.PROXY_BASE_URL,
    proxyApiKey: e.PROXY_API_KEY,
    embedderBaseUrl: e.EMBEDDER_BASE_URL,
    windowSeconds: e.WINDOW_SECONDS,
    indexPath: e.INDEX_PATH,
  };
}
