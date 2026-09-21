/**
 * Vector math. Pure, dependency-free, and deliberately separate from any
 * embedding provider: the store and the searcher need cosine, they do not need
 * to know who produced the numbers.
 */

export type Vector = number[];

export function norm(v: Vector): number {
  let sum = 0;
  for (const x of v) sum += x * x;
  return Math.sqrt(sum);
}

/**
 * Truncated Matryoshka outputs come back un-normalized, and cosine on
 * un-normalized vectors is not cosine. Normalize once at the boundary rather
 * than hoping every provider did it.
 */
export function normalize(v: Vector): Vector {
  const n = norm(v);
  return n === 0 ? v : v.map((x) => x / n);
}

export function dot(a: Vector, b: Vector): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
}

export function cosine(a: Vector, b: Vector): number {
  const d = norm(a) * norm(b);
  return d === 0 ? 0 : dot(a, b) / d;
}
