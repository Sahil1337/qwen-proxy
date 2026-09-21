/**
 * The eval's configuration, validated once at startup.
 *
 * Every knob is an environment variable rather than a source edit, so a run
 * against a different proxy, transcript or mode is a shell prefix. A bad value
 * names itself here instead of producing a confusing run: `EVAL_MODE=thinkng`
 * fails immediately rather than silently extracting in the wrong mode for
 * twenty minutes of GPU time.
 */

import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

/** `1`, `true`, `0`, `false` — anything else is a typo worth failing on. */
const bool = (fallback: boolean) =>
  z
    .enum(["true", "false", "1", "0"])
    .transform((v) => v === "true" || v === "1")
    .default(fallback);

export function loadEvalEnv(runtimeEnv: Record<string, string | undefined> = process.env) {
  return createEnv({
    server: {
      /** The proxy to evaluate against. Point this at your own; run `bun run dev:proxy` for a local one. */
      PROXY_BASE_URL: z.url().default("http://127.0.0.1:8000"),
      PROXY_API_KEY: z.string().min(1).optional(),

      /** A transcript file; defaults to the kickoff fixture next to this package. */
      EVAL_TRANSCRIPT: z.string().min(1).optional(),
      /** Window target in seconds. Unset uses ingestion's default. */
      EVAL_WINDOW: z.coerce.number().int().positive().optional(),

      EVAL_MODE: z.enum(["fast", "thinking", "adaptive"]).default("thinking"),
      EVAL_TOOL_CHOICE: z.enum(["auto", "required"]).default("auto"),

      EVAL_STREAM: bool(true),
      /** Pause for a verdict after each window. */
      EVAL_MANUAL: bool(true),
      /** Print only the transcript and the propositions per window. */
      EVAL_SUPPRESS: bool(true),
      /** Write `out/latest/`. */
      EVAL_SAVE: bool(true),
    },
    runtimeEnv,
    emptyStringAsUndefined: true,
  });
}

export type EvalEnv = ReturnType<typeof loadEvalEnv>;
