/**
 * Gemini embeddings over the REST API — no SDK, no dependencies.
 * Docs: https://ai.google.dev/gemini-api/docs/embeddings
 *
 * This is *an* `Embedder`, not *the* embedder. The kickoff's plan is a
 * self-hosted embedding service (`HttpEmbedder`); this exists because it works
 * today, and the retrieval eval needs something that works today to be worth
 * running. Swapping in the local model later changes one line in the container,
 * because both sides of the boundary only speak `Embedder`.
 *
 * `kind` maps to Gemini's `taskType`, and the mapping is asymmetric on purpose:
 * a document indexed as `RETRIEVAL_DOCUMENT` and a question embedded as
 * `RETRIEVAL_QUERY` score far better against each other than either does under
 * one shared task type. Measured at ~0.83 self-similarity when mixed — that gap
 * is real recall lost.
 */

import type { Embedder } from "@meetai/core";
import { normalize, type Vector } from "../vectors.ts";

const BASE = "https://generativelanguage.googleapis.com/v1beta";

/** The model's native width. Anything narrower is a Matryoshka truncation and needs renormalizing. */
const FULL_DIM = 3072;

const TASK_TYPE = {
  document: "RETRIEVAL_DOCUMENT",
  query: "RETRIEVAL_QUERY",
} as const;

interface BatchEmbedResponse {
  embeddings: Array<{ values: Vector }>;
}

export interface GeminiEmbedderOptions {
  apiKey: string;
  /** 768 was the measured sweet spot: a quarter of 3072's storage, same related/unrelated gap. */
  dimensions?: number;
  model?: string;
  /** Retries on 429 and 5xx, which is most of what this API fails with. */
  maxAttempts?: number;
}

export class GeminiEmbedder implements Embedder {
  readonly model: string;
  readonly dimensions: number;
  readonly #apiKey: string;
  readonly #maxAttempts: number;

  constructor(options: GeminiEmbedderOptions) {
    if (!options.apiKey) throw new Error("GeminiEmbedder needs an apiKey");
    this.#apiKey = options.apiKey;
    this.model = options.model ?? "gemini-embedding-001";
    this.dimensions = options.dimensions ?? 768;
    this.#maxAttempts = options.maxAttempts ?? 3;
  }

  async embed(texts: string[], kind: "document" | "query"): Promise<number[][]> {
    if (texts.length === 0) return [];

    const requests = texts.map((text) => ({
      model: `models/${this.model}`,
      content: { parts: [{ text }] },
      taskType: TASK_TYPE[kind],
      outputDimensionality: this.dimensions,
    }));

    const json = await this.#call<BatchEmbedResponse>(`models/${this.model}:batchEmbedContents`, { requests });
    const vectors = json.embeddings.map((e) => e.values);
    return this.dimensions === FULL_DIM ? vectors : vectors.map(normalize);
  }

  async #call<T>(path: string, body: unknown): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt++) {
      const res = await fetch(`${BASE}/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": this.#apiKey },
        body: JSON.stringify(body),
      });

      if (res.ok) return (await res.json()) as T;

      const text = await res.text();
      lastError = new Error(`Gemini ${res.status} ${res.statusText}: ${text.slice(0, 600)}`);
      // 4xx other than rate limiting is a bad request; retrying just repeats it.
      if (res.status !== 429 && res.status < 500) break;
      if (attempt < this.#maxAttempts) await new Promise((r) => setTimeout(r, 2 ** attempt * 250));
    }
    throw lastError;
  }
}
