/** Shared bits for the examples: one client instance and a tiny print helper. */
import { QwenProxyClient } from '../src/client/index.js';

export const qwen = new QwenProxyClient({
  baseUrl: process.env.PROXY_URL ?? 'http://127.0.0.1:8000',
  apiKey: process.env.API_KEY,
});

export const line = (label: string, value: unknown) =>
  console.log(`${label.padEnd(14)} ${typeof value === 'string' ? value : JSON.stringify(value)}`);
