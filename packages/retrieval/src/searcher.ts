/**
 * Query → ranked proposition ids.
 *
 * Vector-only today, and named for what it does. The kickoff's plan is to route
 * structured questions ("who owns X", "what's due Friday") to filters over the
 * claim fields and semantic ones to hybrid search — BM25 + vector fused with
 * reciprocal rank fusion (reading list B3) — with reranking after that. Both
 * are deferred until `evals/retrieval` says they earn their cost; `SearchHit.via`
 * already carries the path so the eval can attribute a hit when they land.
 *
 * Returns ids and scores only. The API hydrates them; answering writes prose.
 *
 * Scope note: `SearchQuery.projectId` is accepted but not enforced, because
 * `Proposition` carries no project link — only `meetingId`. One store holds one
 * project's claims by construction. Enforcing it needs a meeting→project map
 * that lives in `@meetai/memory`, which this package must not import.
 */

import type { Embedder, Searcher, SearchHit, SearchQuery } from "@meetai/core";
import type { JsonVectorStore, Metadata, StoredRecord } from "./store.ts";

export interface VectorSearcherOptions {
  /**
   * Hits below this cosine score are dropped. A floor is what makes "the corpus
   * cannot answer this" possible: without one, the nearest record always wins,
   * however unrelated. Tune it against the out-of-domain queries in the eval.
   */
  minScore?: number;
}

function matchesFilters(record: StoredRecord, filters: NonNullable<SearchQuery["filters"]>): boolean {
  const m: Metadata = record.metadata;
  if (filters.types?.length && !filters.types.includes(m["type"] as never)) return false;
  if (filters.speakers?.length && !filters.speakers.includes(String(m["speaker"] ?? ""))) return false;
  if (filters.meetingIds?.length && !filters.meetingIds.includes(String(m["meetingId"] ?? ""))) return false;

  // `from`/`to` compare against extraction time, which is the only date on a
  // Proposition. That is a proxy for meeting date and they diverge on a
  // re-extraction; indexing the meeting's own date would fix it.
  const date = String(m["extractedAt"] ?? "").slice(0, 10);
  if (filters.from && date && date < filters.from) return false;
  if (filters.to && date && date > filters.to) return false;
  return true;
}

export class VectorSearcher implements Searcher {
  readonly #embedder: Embedder;
  readonly #store: JsonVectorStore;
  readonly #minScore: number | undefined;

  constructor(embedder: Embedder, store: JsonVectorStore, options: VectorSearcherOptions = {}) {
    this.#embedder = embedder;
    this.#store = store;
    this.#minScore = options.minScore;
  }

  async search(query: SearchQuery): Promise<SearchHit[]> {
    if (this.#store.size === 0) return [];

    const [vector] = await this.#embedder.embed([query.text], "query");
    if (!vector) throw new Error("embedder returned no vector for the query");

    // Filtering happens before ranking so `limit` counts matching records, not
    // records that merely scored well and were then thrown away.
    const filters = query.filters;
    const hits = this.#store.search(vector, {
      topK: query.limit,
      ...(this.#minScore !== undefined ? { minScore: this.#minScore } : {}),
      ...(filters ? { predicate: (r: StoredRecord) => matchesFilters(r, filters) } : {}),
    });

    return hits.map((h) => ({ propositionId: h.record.id, score: h.score, via: "vector" as const }));
  }
}
