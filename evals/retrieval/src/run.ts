/**
 * Retrieval eval: index a set of extracted claims, run a golden query set
 * against them, and print metrics instead of eyeballing a few searches.
 *
 *   GEMINI_API_KEY=... bun run eval:retrieval
 *
 * This is the eval `docs/architecture.md` gates hybrid search and reranking on.
 * Neither is worth building until this exists, because "the reranker helped" is
 * unfalsifiable without a baseline — and a reranker is exactly the kind of
 * component that feels like it is working.
 *
 * The index is cached at EVAL_STORE, so a second run costs no embedding calls.
 * Delete it, or set EVAL_REINDEX=1, after changing the claims or the model.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Proposition } from "@meetai/core";
import { GeminiEmbedder, JsonVectorStore, PropositionIndexer, VectorSearcher } from "@meetai/retrieval";
import { loadEvalEnv } from "./env.ts";
import { grade, isOutOfDomain, summarize, type GoldenQuery } from "./metrics.ts";

const env = loadEvalEnv();
const fixtures = join(import.meta.dir, "..", "fixtures");

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

/**
 * The propositions eval writes `out/latest/claims.json` in exactly this shape,
 * so its output is this eval's input — extraction quality and retrieval quality
 * measured over the same claims.
 */
interface ClaimsFile {
  fixture: string;
  propositions: Array<{ text: string; type: string; speaker: string | null; confidence: number }>;
}

/**
 * Fill in the fields a persisted `Proposition` has and a raw extraction does
 * not. The eval never stores these, so synthetic ids are fine — but they are
 * stable across runs (index position), so a cached store still matches.
 */
function asPropositions(file: ClaimsFile[]): Proposition[] {
  const now = new Date().toISOString();
  return file.flatMap((entry, windowIndex) =>
    entry.propositions.map((p, i) => ({
      ...p,
      type: p.type as Proposition["type"],
      id: `eval-${windowIndex}-${i}`,
      meetingId: "eval-meeting",
      windowIndex,
      evidence: { meetingId: "eval-meeting", lineIndexes: [0] },
      extractorVersion: "eval-fixture",
      extractedAt: now,
    })),
  );
}

const claimsPath = env.EVAL_CLAIMS ?? join(fixtures, "claims.json");
const claims = asPropositions(JSON.parse(readFileSync(claimsPath, "utf8")) as ClaimsFile[]);
const golden = JSON.parse(readFileSync(join(fixtures, "golden-queries.json"), "utf8")) as GoldenQuery[];

const embedder = new GeminiEmbedder({
  apiKey: env.GEMINI_API_KEY,
  model: env.EMBED_MODEL,
  dimensions: env.EMBED_DIMENSIONS,
});
const store = JsonVectorStore.open(env.EVAL_STORE, embedder.model, embedder.dimensions);

console.log(`\n  ${claims.length} claims · ${golden.length} queries · ${embedder.model}/${embedder.dimensions}d`);
console.log(dim(`  top ${env.EVAL_TOP_K}, score floor ${env.EVAL_MIN_SCORE}\n`));

if (env.EVAL_REINDEX || store.size !== claims.length) {
  if (env.EVAL_REINDEX) store.clear();
  process.stdout.write(dim(`  indexing ${claims.length} claims… `));
  await new PropositionIndexer(embedder, store).index(claims);
  console.log(dim(`done (${(store.bytesOnDisk / 1024).toFixed(0)} KB at ${store.path})\n`));
} else {
  console.log(dim(`  reusing cached index at ${store.path}\n`));
}

const searcher = new VectorSearcher(embedder, store, { minScore: env.EVAL_MIN_SCORE });

const results = [];
for (const query of golden) {
  const hits = await searcher.search({ projectId: "eval", text: query.query, limit: env.EVAL_TOP_K });
  // Ids are all the searcher returns, by design. The eval hydrates through the
  // store it owns — exactly as the API will hydrate through the proposition
  // store it owns.
  const withText = hits.map((h) => ({ text: store.get(h.propositionId)?.text ?? "", score: h.score }));
  const result = grade(query, withText);
  results.push(result);

  const mark = result.passed ? green("pass") : red("FAIL");
  const rank = isOutOfDomain(query)
    ? `${result.hits.length} above floor`
    : result.firstRelevantRank > 0
      ? `rank ${result.firstRelevantRank}`
      : "not found";
  console.log(`  ${mark}  ${dim(`[${query.kind}]`)} ${query.query}`);
  console.log(dim(`        ${rank}${result.hits[0] ? ` · top ${result.hits[0].score.toFixed(3)}: ${result.hits[0].text.slice(0, 72)}` : ""}`));
}

const s = summarize(results);
const failed = results.filter((r) => !r.passed);

console.log(`\n  ${"─".repeat(58)}`);
console.log(`  hit@1 ${pct(s.hitAt1)}   hit@3 ${pct(s.hitAt3)}   recall@${env.EVAL_TOP_K} ${pct(s.recallAtK)}   MRR ${s.mrr.toFixed(3)}`);
console.log(`  out-of-domain rejected ${pct(s.outOfDomainRejected)} ${dim(`(${s.outOfDomain} queries)`)}`);
console.log(`  ${results.length - failed.length}/${results.length} passed\n`);

process.exit(failed.length > 0 ? 1 : 0);
