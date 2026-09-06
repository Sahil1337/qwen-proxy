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

const shortId = (v: unknown) => (typeof v === 'string' ? v.slice(0, 12) : '');
const secs = (ms: unknown) => `${(Number(ms ?? 0) / 1000).toFixed(1)}s`;
const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v));

/** A request arrived: what was asked, how it will be treated. */
function renderRequest(rec: Record<string, unknown>): string {
  const facts = [
    cyan(bold(String(rec['mode_requested'] ?? 'adaptive'))),
    `~${str(rec['prompt_estimate'])} tok`,
    Number(rec['tool_count'] ?? 0) > 0 ? `${str(rec['tool_count'])} tool(s)` : '',
    rec['response_format'] ? `format ${str(rec['response_format'])}` : '',
    rec['stream'] ? 'stream' : '',
  ].filter(Boolean);
  const head = `${cyan('▶')} ${cyan(bold('request'))}  ${dim(shortId(rec['request_id']))}  ${facts.join(dim(' · '))}`;
  const body = renderBlock('prompt', rec['prompt']);
  return body === undefined ? head : `${head}\n${block('prompt', cyan, body)}`;
}

/** A request finished successfully. */
function renderCompletion(rec: Record<string, unknown>): string {
  const flags = [
    rec['think_budget_hit'] ? yellow('budget hit') : '',
    Number(rec['retries'] ?? 0) > 0 ? yellow(`${str(rec['retries'])} retry`) : '',
    Number(rec['queue_wait_ms'] ?? 0) > 1000 ? yellow(`queued ${secs(rec['queue_wait_ms'])}`) : '',
  ].filter(Boolean);
  const route = `${str(rec['mode_used'])} (${str(rec['router_rule'])}${rec['router_detail'] ? `: ${str(rec['router_detail'])}` : ''})`;
  const tokens = `${str(rec['completion_tokens'])} tok${Number(rec['thinking_tokens'] ?? 0) > 0 ? ` (${str(rec['thinking_tokens'])} thinking)` : ''}`;
  const timing = `${secs(rec['total_ms'])} (prompt ${secs(rec['prompt_eval_ms'])}, gen ${secs(rec['eval_ms'])})`;
  const facts = [
    green(bold(route)),
    str(rec['finish_reason']),
    tokens,
    bold(`${str(rec['eval_tps'])} tok/s`),
    timing,
    ...flags,
  ];
  const lines = [
    `${green('✔')} ${green(bold('done'))}     ${dim(shortId(rec['request_id']))}  ${facts.join(dim(' · '))}`,
  ];
  const calls = renderBlock('tool_calls', rec['tool_calls']);
  if (calls !== undefined) lines.push(block(`tool calls (${str(rec['tool_parse'])})`, yellow, calls));
  const answer = renderBlock('content', rec['answer']);
  if (answer !== undefined) lines.push(block('answer', green, answer));
  return lines.join('\n');
}

/** A request failed; the client got an error envelope. */
function renderFailure(rec: Record<string, unknown>): string {
  const head = `${red('✖')} ${red(bold('failed'))}   ${dim(shortId(rec['request_id']))}  ${red(bold(`${str(rec['status'])} ${str(rec['code'])}`))}${dim(' · ')}${secs(rec['total_ms'])}`;
  return `${head}\n${block('error', red, str(rec['message']))}`;
}

const EVENT_RENDERERS: Record<string, (rec: Record<string, unknown>) => string> = {
  'chat.request': renderRequest,
  'chat.completion': renderCompletion,
  'chat.completion failed': renderFailure,
};

export function formatPretty(line: string): string {
  let rec: Record<string, unknown>;
  try {
    rec = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return line;
  }
  const stamp = dim(clock(Number(rec['time'])));
  const msg = String(rec['msg'] ?? '');

  // Forwarded Ollama output: keep it on one dim line.
  if (typeof rec['ollama'] === 'string') return `${stamp} ${gray(rec['ollama'])}`;

  const render = EVENT_RENDERERS[msg];
  if (render) return `${stamp} ${render(rec)}`;

  const level = LEVELS[Number(rec['level'])] ?? String(rec['level']);
  const head = `${stamp} ${level} ${bold(msg)}`;
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
