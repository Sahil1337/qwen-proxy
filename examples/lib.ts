/** Shared helpers for the examples. Only `fetch` is used; no SDK required. */

export const PROXY_URL = process.env.PROXY_URL ?? 'http://127.0.0.1:8000';
export const MODEL = 'qwen3.5:4b';

const headers = () => ({
  'content-type': 'application/json',
  ...(process.env.API_KEY ? { authorization: `Bearer ${process.env.API_KEY}` } : {}),
});

/** POST JSON and return the parsed body; throws on a non-2xx status with the proxy's error envelope. */
export async function post<T = any>(path: string, body: unknown): Promise<{ body: T; headers: Headers }> {
  const res = await fetch(`${PROXY_URL}${path}`, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
  const json = (await res.json()) as any;
  if (!res.ok) throw new Error(`${res.status} ${json.error?.code}: ${json.error?.message}`);
  return { body: json as T, headers: res.headers };
}

/** POST with `stream: true` and yield each parsed SSE chunk until `[DONE]`. */
export async function* stream(path: string, body: unknown): AsyncGenerator<any> {
  const res = await fetch(`${PROXY_URL}${path}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ ...(body as object), stream: true }),
  });
  if (!res.ok || !res.body) throw new Error(`${res.status} ${await res.text()}`);
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let end: number;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const event = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 2);
      if (!event.startsWith('data: ')) continue;
      const data = event.slice(6);
      if (data === '[DONE]') return;
      yield JSON.parse(data);
    }
  }
}

export const line = (label: string, value: unknown) =>
  console.log(`${label.padEnd(14)} ${typeof value === 'string' ? value : JSON.stringify(value)}`);
