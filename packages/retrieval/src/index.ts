/**
 * @meetai/retrieval — embeddings, indexing, and search over propositions.
 * Implements `Embedder`, `Indexer`, `Searcher` from @meetai/core. Returns
 * proposition ids; never transcript text, never answers.
 */

export { HttpEmbedder } from "./embedder.ts";
export { GeminiEmbedder, type GeminiEmbedderOptions } from "./embedders/gemini.ts";
export { PropositionIndexer } from "./indexer.ts";
export { VectorSearcher, type VectorSearcherOptions } from "./searcher.ts";
export {
  idFor,
  JsonVectorStore,
  type Metadata,
  type SearchOptions,
  type StoredRecord,
  type StoreFile,
  type StoreHit,
} from "./store.ts";
export { cosine, dot, norm, normalize, type Vector } from "./vectors.ts";
