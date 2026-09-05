import { Writable } from 'node:stream';
import pino, { type Logger } from 'pino';

export type { Logger };
export type LogFormat = 'pretty' | 'json' | 'auto';

/**
 * `json`: one pino JSON line per event (production, log shippers).
 * `pretty`: coloured, human-readable lines with multi-line blocks for the
 * model's prompt, reasoning, tool calls and answer.
 * `auto`: pretty on a terminal, json otherwise.
 */
export function createLogger(level: string, format: LogFormat = 'auto'): Logger {
  const pretty = format === 'pretty' || (format === 'auto' && Boolean(process.stdout.isTTY));
  const base = { service: 'qwen-proxy' };
  return pretty ? pino({ level, base }, prettyDestination()) : pino({ level, base });
}

// ---------------------------------------------------------------------------
// Pretty formatter (no dependency; ~1 screen of code)
// ---------------------------------------------------------------------------

const useColor = !process.env['NO_COLOR'];
const paint = (code: string, text: string) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const dim = (t: string) => paint('2', t);
const bold = (t: string) => paint('1', t);
const blue = (t: string) => paint('34', t);
const green = (t: string) => paint('32', t);
const yellow = (t: string) => paint('33', t);
const red = (t: string) => paint('31', t);
const gray = (t: string) => paint('90', t);
const magenta = (t: string) => paint('35', t);
const cyan = (t: string) => paint('36', t);

const LEVELS: Record<number, string> = {
  10: gray('TRACE'),
  20: blue('DEBUG'),
  30: green('INFO '),
  40: yellow('WARN '),
  50: red('ERROR'),
  60: red(bold('FATAL')),
};

/** Fields rendered as indented blocks below the line instead of key=value. */
const BLOCKS: Array<[key: string, title: string, colour: (t: string) => string]> = [
  ['prompt', 'prompt', cyan],
  ['reasoning', 'reasoning', magenta],
  ['tool_calls', 'tool calls', yellow],
  ['content', 'answer', green],
  ['err', 'error', red],
];
const HIDDEN = new Set(['level', 'time', 'msg', 'pid', 'hostname', 'service', 'ollama']);

function clock(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function block(title: string, colour: (t: string) => string, body: string): string {
  const lines = body.split('\n');
  return [`  ${colour('┌')} ${colour(bold(title))}`, ...lines.map((l) => `  ${colour('│')} ${l}`)].join('\n');
}

function renderBlock(key: string, value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (key === 'tool_calls') {
    const calls = value as Array<{ function: { name: string; arguments: string } }>;
    return calls.length ? calls.map((c) => `${c.function.name}(${c.function.arguments})`).join('\n') : undefined;
  }
  if (key === 'err') {
    const e = value as { type?: string; message?: string; stack?: string };
    return [e.message ?? String(value), ...(e.stack ? [dim(e.stack)] : [])].join('\n');
  }
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

export function formatPretty(line: string): string {
  let rec: Record<string, unknown>;
  try {
    rec = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return line;
  }
  const level = LEVELS[Number(rec['level'])] ?? String(rec['level']);
  const head = `${dim(clock(Number(rec['time'])))} ${level} ${bold(String(rec['msg'] ?? ''))}`;

  // Forwarded Ollama output: keep it on one dim line.
  if (typeof rec['ollama'] === 'string') return `${head} ${gray(rec['ollama'])}`;

  const blockKeys = new Set(BLOCKS.map(([k]) => k));
  const fields = Object.entries(rec)
    .filter(([k]) => !HIDDEN.has(k) && !blockKeys.has(k))
    .map(([k, v]) => `${dim(k + '=')}${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' ');
  const blocks = BLOCKS.map(([key, title, colour]) => {
    const body = renderBlock(key, rec[key]);
    return body === undefined ? undefined : block(title, colour, body);
  }).filter((b): b is string => b !== undefined);

  return [fields ? `${head} ${fields}` : head, ...blocks].join('\n');
}

function prettyDestination(): Writable {
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      for (const line of chunk.toString().split('\n')) {
        if (line.trim()) process.stdout.write(formatPretty(line) + '\n');
      }
      callback();
    },
  });
}
