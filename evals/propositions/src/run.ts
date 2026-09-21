/**
 * Entry point: `bun run eval` from the repo root.
 *
 * Configuration is environment variables, validated in `env.ts` — read that
 * file for the full list and the defaults. The common case is choosing a
 * proxy:
 *
 *   PROXY_BASE_URL=http://nitro.lan:8000 bun run eval
 */

import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { EXTRACTION_PROMPT } from "@meetai/ai/prompts";
import { QwenProxyClient } from "qwen-proxy/client";
import { loadEvalEnv } from "./env.ts";
import { fixturesFromTranscript } from "./fixtures.ts";
import { runEvaluation } from "./runner.ts";

const env = loadEvalEnv();

const transcriptPath = env.EVAL_TRANSCRIPT ?? join(import.meta.dir, "..", "fixtures", "kickoff-2026-09-07.txt");

const fixtures = fixturesFromTranscript(basename(transcriptPath, ".txt"), readFileSync(transcriptPath, "utf8"), {
  windowSeconds: env.EVAL_WINDOW,
});

await runEvaluation({
  client: new QwenProxyClient({ baseUrl: env.PROXY_BASE_URL, apiKey: env.PROXY_API_KEY, timeoutMs: 180_000 }),
  label: env.PROXY_BASE_URL,
  fixtures,
  systemPrompt: EXTRACTION_PROMPT,
  mode: env.EVAL_MODE,
  toolChoice: env.EVAL_TOOL_CHOICE,
  stream: env.EVAL_STREAM,
  manual: env.EVAL_MANUAL,
  suppress: env.EVAL_SUPPRESS,
  saveOutput: env.EVAL_SAVE,
});
