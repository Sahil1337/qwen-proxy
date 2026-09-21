/**
 * Puts propositions into the index: embed the claim text — only the text, not
 * the meeting header, or every claim from one meeting drifts together for the
 * wrong reason — and store the vector keyed by proposition id.
 *
 * Idempotent on id: indexing the same proposition twice replaces, never
 * duplicates. Where the vectors live is this package's choice and nobody
 * else's; today that is a JSON file, and the interface is the same when it
 * becomes pgvector.
 */

import type { Embedder, Id, Indexer, Proposition } from "@meetai/core";
import type { JsonVectorStore, Metadata } from "./store.ts";

/** One request for 44 records costs about what one request for 1 does, so batch. */
const BATCH_SIZE = 100;

/** Only the fields a filter can match on. Everything else is hydrated from the store by id. */
function metadataFor(p: Proposition): Metadata {
  return {
    type: p.type,
    speaker: p.speaker ?? "",
    meetingId: p.meetingId,
    windowIndex: p.windowIndex,
    extractedAt: p.extractedAt,
    confidence: p.confidence,
  };
}

export class PropositionIndexer implements Indexer {
  readonly #embedder: Embedder;
  readonly #store: JsonVectorStore;

  constructor(embedder: Embedder, store: JsonVectorStore) {
    this.#embedder = embedder;
    this.#store = store;
  }

  async index(propositions: Proposition[]): Promise<void> {
    const usable = propositions.filter((p) => p.text.trim().length > 0);
    if (usable.length === 0) return;

    for (let i = 0; i < usable.length; i += BATCH_SIZE) {
      const batch = usable.slice(i, i + BATCH_SIZE);
      const vectors = await this.#embedder.embed(
        batch.map((p) => p.text.trim()),
        "document",
      );
      if (vectors.length !== batch.length) {
        throw new Error(`embedder returned ${vectors.length} vectors for ${batch.length} texts`);
      }
      // Keyed by proposition id, not by a hash of the text: two windows can
      // legitimately produce the same sentence, and they are still two claims
      // with two pieces of evidence.
      this.#store.upsert(
        batch.map((p, j) => ({
          id: p.id,
          text: p.text.trim(),
          vector: vectors[j]!,
          metadata: metadataFor(p),
        })),
      );
    }
  }

  async remove(propositionIds: Id[]): Promise<void> {
    this.#store.remove(propositionIds);
  }
}
