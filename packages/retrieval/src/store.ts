/**
 * A vector store that is just a JSON file on disk.
 *
 * Fine for a few thousand short records: the whole file is read into memory and
 * every query is a linear scan. No index, no server, no native dependency —
 * which is the point. It exists so the query path can be built and evaluated
 * before the database question is settled, and it is invisible outside this
 * package: `Searcher` returns proposition ids either way, so swapping this for
 * pgvector changes nothing for anyone else.
 *
 * Unlike the scratch version this grew from, the store does no embedding. It
 * takes vectors and gives vectors back; `PropositionIndexer` and the searcher
 * own the `Embedder`. That split is what lets the eval reuse one store across
 * providers, and keeps the file readable without an API key.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { cosine, type Vector } from "./vectors.ts";

/** Bump when the on-disk shape changes incompatibly. */
const STORE_VERSION = 1;

/** Decimal places kept per component when serializing. Far below the embedding's own noise floor. */
const VECTOR_PRECISION = 6;

export type Metadata = Record<string, string | number | boolean>;

export interface StoredRecord {
  id: string;
  text: string;
  vector: Vector;
  metadata: Metadata;
  createdAt: string;
}

export interface StoreFile {
  version: number;
  /** Everything in `records` was embedded with exactly these settings. Mixing them silently costs recall. */
  model: string;
  dimensions: number;
  createdAt: string;
  records: StoredRecord[];
}

export interface StoreHit {
  record: StoredRecord;
  score: number;
}

export interface SearchOptions {
  topK?: number;
  /** Drop hits below this cosine score. */
  minScore?: number;
  /** Only consider records whose metadata matches every key here. */
  filter?: Metadata;
  /**
   * Arbitrary record filter, for conditions exact metadata matching cannot
   * express — "type is one of these five", a date range. Applied before
   * ranking, so `topK` counts records that actually qualify.
   */
  predicate?: (record: StoredRecord) => boolean;
}

/** Stable id, so re-adding the same text updates in place instead of duplicating. */
export function idFor(text: string): string {
  return createHash("sha256").update(text.trim()).digest("hex").slice(0, 12);
}

export class JsonVectorStore {
  readonly path: string;
  #data: StoreFile;

  private constructor(path: string, data: StoreFile) {
    this.path = path;
    this.#data = data;
  }

  static open(path: string, model: string, dimensions: number): JsonVectorStore {
    if (!existsSync(path)) {
      return new JsonVectorStore(path, {
        version: STORE_VERSION,
        model,
        dimensions,
        createdAt: new Date().toISOString(),
        records: [],
      });
    }

    const parsed = JSON.parse(readFileSync(path, "utf8")) as StoreFile;
    if (parsed.version !== STORE_VERSION) {
      throw new Error(`store at ${path} is version ${parsed.version}, expected ${STORE_VERSION}. Delete it and re-index.`);
    }
    // A store built with one model and queried with another returns confident
    // nonsense, so this is an error rather than a warning.
    if (parsed.model !== model || parsed.dimensions !== dimensions) {
      throw new Error(
        `store at ${path} holds ${parsed.model}/${parsed.dimensions}d vectors but this run uses ${model}/${dimensions}d. Delete it and re-index.`,
      );
    }
    return new JsonVectorStore(path, parsed);
  }

  get size(): number {
    return this.#data.records.length;
  }

  get info(): Omit<StoreFile, "records"> {
    const { records: _records, ...rest } = this.#data;
    return rest;
  }

  get bytesOnDisk(): number {
    return existsSync(this.path) ? statSync(this.path).size : 0;
  }

  all(): readonly StoredRecord[] {
    return this.#data.records;
  }

  get(id: string): StoredRecord | undefined {
    return this.#data.records.find((r) => r.id === id);
  }

  /** Insert or replace by id, then persist once. Idempotent: same id in, one record out. */
  upsert(records: readonly Omit<StoredRecord, "createdAt">[]): void {
    if (records.length === 0) return;
    const now = new Date().toISOString();
    for (const record of records) {
      const full: StoredRecord = { ...record, createdAt: now };
      const at = this.#data.records.findIndex((r) => r.id === full.id);
      if (at === -1) this.#data.records.push(full);
      else this.#data.records[at] = full;
    }
    this.save();
  }

  /** Rank every stored vector against an already-embedded query. */
  search(queryVector: Vector, opts: SearchOptions = {}): StoreHit[] {
    const { topK = 5, minScore, filter, predicate } = opts;
    if (this.#data.records.length === 0) return [];

    let candidates: readonly StoredRecord[] = this.#data.records;
    if (filter) {
      candidates = candidates.filter((r) => Object.entries(filter).every(([k, v]) => r.metadata[k] === v));
    }
    if (predicate) candidates = candidates.filter(predicate);

    let hits: StoreHit[] = candidates.map((record) => ({ record, score: cosine(queryVector, record.vector) }));
    hits.sort((a, b) => b.score - a.score);
    if (minScore !== undefined) hits = hits.filter((h) => h.score >= minScore);
    return hits.slice(0, topK);
  }

  /**
   * Near-duplicate records by pairwise cosine. Content-hash ids only catch
   * byte-identical text; overlapping transcript windows produce claims that are
   * reworded but mean the same thing, and only a similarity check finds those.
   * Pure local math — no embedding calls.
   */
  findDuplicates(threshold = 0.9): Array<{ a: StoredRecord; b: StoredRecord; score: number }> {
    const out: Array<{ a: StoredRecord; b: StoredRecord; score: number }> = [];
    const rs = this.#data.records;
    for (let i = 0; i < rs.length; i++) {
      for (let j = i + 1; j < rs.length; j++) {
        const score = cosine(rs[i]!.vector, rs[j]!.vector);
        if (score >= threshold) out.push({ a: rs[i]!, b: rs[j]!, score });
      }
    }
    return out.sort((x, y) => y.score - x.score);
  }

  remove(ids: readonly string[]): number {
    const before = this.#data.records.length;
    const drop = new Set(ids);
    this.#data.records = this.#data.records.filter((r) => !drop.has(r.id));
    const removed = before - this.#data.records.length;
    if (removed > 0) this.save();
    return removed;
  }

  clear(): void {
    this.#data.records = [];
    this.save();
  }

  /** Temp file + rename, so an interrupted write cannot truncate the store. */
  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    const serializable: StoreFile = {
      ...this.#data,
      records: this.#data.records.map((r) => ({
        ...r,
        vector: r.vector.map((v) => Number(v.toFixed(VECTOR_PRECISION))),
      })),
    };
    // Compact, not pretty-printed: one float per line doubles the file for nothing.
    writeFileSync(tmp, JSON.stringify(serializable), "utf8");
    renameSync(tmp, this.path);
  }
}
