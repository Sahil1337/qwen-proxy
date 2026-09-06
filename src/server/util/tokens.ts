/**
 * Cheap token estimate (chars / 4). Used only for routing heuristics and the
 * prompt-size guard; Ollama reports real counts after generation.
 */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

export const estimateJsonTokens = (value: unknown): number =>
  value === undefined ? 0 : estimateTokens(JSON.stringify(value));
