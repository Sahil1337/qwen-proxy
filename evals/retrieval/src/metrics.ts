/**
 * Retrieval metrics. Deliberately boring and deterministic: no model runs here,
 * so a number moving means retrieval changed, not that the weather did.
 *
 *   hit@1     the top result is relevant
 *   hit@3     something relevant is in the top 3
 *   recall@k  something relevant is anywhere in the top k
 *   MRR       1/rank of the first relevant result, 0 if absent
 *
 * Out-of-domain queries are scored inversely: they pass when *nothing* clears
 * the score floor. Without them a retriever that always returns its nearest
 * record looks perfect, because every in-domain query has an answer.
 */

export interface GoldenQuery {
  query: string;
  /** Case-insensitive substrings; a hit matching any of them counts as relevant. */
  expect: string[];
  kind: string;
}

export interface GradedHit {
  text: string;
  score: number;
  relevant: boolean;
}

export interface GradedQuery {
  query: GoldenQuery;
  hits: GradedHit[];
  /** 1-based rank of the first relevant hit; 0 when there is none. */
  firstRelevantRank: number;
  passed: boolean;
}

export interface Summary {
  total: number;
  inDomain: number;
  outOfDomain: number;
  hitAt1: number;
  hitAt3: number;
  recallAtK: number;
  mrr: number;
  outOfDomainRejected: number;
}

export const isOutOfDomain = (q: GoldenQuery): boolean => q.kind === "out-of-domain" || q.expect.length === 0;

export function isRelevant(text: string, expect: string[]): boolean {
  const haystack = text.toLowerCase();
  return expect.some((e) => haystack.includes(e.toLowerCase()));
}

export function grade(query: GoldenQuery, hits: Array<{ text: string; score: number }>): GradedQuery {
  const graded: GradedHit[] = hits.map((h) => ({ ...h, relevant: isRelevant(h.text, query.expect) }));
  const firstRelevantRank = graded.findIndex((h) => h.relevant) + 1;
  // An out-of-domain query passes by returning nothing at all: anything that
  // survived the score floor is a false positive by definition.
  const passed = isOutOfDomain(query) ? graded.length === 0 : firstRelevantRank > 0;
  return { query, hits: graded, firstRelevantRank, passed };
}

export function summarize(results: readonly GradedQuery[]): Summary {
  const inDomain = results.filter((r) => !isOutOfDomain(r.query));
  const outOfDomain = results.filter((r) => isOutOfDomain(r.query));
  const share = (n: number) => (inDomain.length === 0 ? 0 : n / inDomain.length);

  return {
    total: results.length,
    inDomain: inDomain.length,
    outOfDomain: outOfDomain.length,
    hitAt1: share(inDomain.filter((r) => r.firstRelevantRank === 1).length),
    hitAt3: share(inDomain.filter((r) => r.firstRelevantRank > 0 && r.firstRelevantRank <= 3).length),
    recallAtK: share(inDomain.filter((r) => r.firstRelevantRank > 0).length),
    mrr: inDomain.reduce((sum, r) => sum + (r.firstRelevantRank > 0 ? 1 / r.firstRelevantRank : 0), 0) / (inDomain.length || 1),
    outOfDomainRejected: outOfDomain.length === 0 ? 1 : outOfDomain.filter((r) => r.passed).length / outOfDomain.length,
  };
}
