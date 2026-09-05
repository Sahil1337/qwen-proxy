/**
 * Manual playground against a running proxy (not part of the unit tests).
 *
 *   bun run dev     # terminal 1 (LOG_LEVEL=debug to also see reasoning in the proxy log)
 *   bun run try     # terminal 2; or PROXY_URL=http://host:8000 bun run try
 *
 * Edit PROMPTS and TOOLS below. Each prompt is sent once; when the model calls
 * a tool, the fake result from `runTool` is sent back and the final answer is
 * printed. Every step shows the router decision, the model's full reasoning,
 * the tool calls with their results, the answer, and timing.
 */

const PROXY_URL = process.env.PROXY_URL ?? 'http://127.0.0.1:8000';
const API_KEY = process.env.API_KEY;
const MAX_TOKENS = 400;

// ---------------------------------------------------------------------------
// Tools the model can call. Keep schemas small: they are rendered into the
// prompt on every request (the proxy strips validation-only keywords).
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_memory',
      description: 'Search past meeting notes and decisions. Returns matching snippets with dates.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to look for' },
          limit: { type: 'integer', minimum: 1, maximum: 10, description: 'Max results, default 5' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_meeting',
      description: 'Fetch the full transcript summary of one meeting by date.',
      parameters: {
        type: 'object',
        properties: { date: { type: 'string', description: 'YYYY-MM-DD' } },
        required: ['date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_task',
      description: 'Create a follow-up task for a person.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          assignee: { type: 'string' },
          due: { type: 'string', description: 'YYYY-MM-DD' },
        },
        required: ['title', 'assignee'],
      },
    },
  },
];

/** Fake tool implementations so a round trip can complete offline. */
function runTool(name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case 'search_memory':
      return [
        { date: '2026-08-28', text: 'Agreed: Pro tier at $49/month. Decision final.' },
        { date: '2026-09-02', text: 'Launch moved to March 10 after QA found two blockers.' },
      ].slice(0, Number(args['limit'] ?? 5));
    case 'get_meeting':
      return {
        date: args['date'],
        summary: 'Pricing review. Attendees: Sahil, Priya. Outcome: $49 Pro tier confirmed.',
      };
    case 'create_task':
      return { id: 'task_123', ...args, status: 'open' };
    default:
      return { error: `unknown tool ${name}` };
  }
}

// ---------------------------------------------------------------------------
// Prompts to try. `mode` is optional: 'fast' | 'thinking' | 'adaptive'.
// ---------------------------------------------------------------------------

type Mode = 'fast' | 'thinking' | 'adaptive';
/** `stream: true` prints tokens as they arrive (reasoning in magenta, answer in green). */
const PROMPTS: Array<{ prompt: string; mode?: Mode; tools?: boolean; stream?: boolean; system?: string }> = [
  { prompt: 'What did we decide about pricing?', tools: true },
  { prompt: 'Create a task for Priya to update the pricing page by next Friday.', tools: true },
  { prompt: 'Why did the launch move? Check the notes first.', tools: true },
  {
    prompt: 'Summarise in one line: the launch moved to March because QA found two blockers.',
    tools: false,
    mode: 'fast',
  },
  {
    prompt: 'Explain in three short sentences why a 4B model benefits from a thinking budget.',
    tools: false,
    stream: true,
  },
];

const SYSTEM =
  'You are an assistant for a meeting-notes product. Use tools when the answer depends on past meetings. Be concise.';

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

const useColor = !process.env['NO_COLOR'] && Boolean(process.stdout.isTTY);
const paint = (code: string) => (t: string) => (useColor ? `\x1b[${code}m${t}\x1b[0m` : t);
const c = {
  dim: paint('2'),
  bold: paint('1'),
  red: paint('31'),
  green: paint('32'),
  yellow: paint('33'),
  blue: paint('34'),
  magenta: paint('35'),
  cyan: paint('36'),
  gray: paint('90'),
};

const block = (title: string, colour: (t: string) => string, body: string) => {
  console.log(`   ${colour('┌')} ${colour(c.bold(title))}`);
  for (const l of body.split('\n')) console.log(`   ${colour('│')} ${l}`);
};
const clip = (s: string, n = 400) => (s.length > n ? `${s.slice(0, n)}… (${s.length} chars)` : s);
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

// ---------------------------------------------------------------------------

type Message = { role: string; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string };
type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };

async function chat(messages: Message[], opts: { tools: boolean; mode?: Mode; stream?: boolean }) {
  const started = Date.now();
  const res = await fetch(`${PROXY_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(API_KEY ? { authorization: `Bearer ${API_KEY}` } : {}) },
    body: JSON.stringify({
      model: 'qwen3.5:4b',
      messages,
      ...(opts.tools ? { tools: TOOLS } : {}),
      ...(opts.mode ? { mode: opts.mode } : {}),
      ...(opts.stream ? { stream: true } : {}),
      max_tokens: MAX_TOKENS,
    }),
  });
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(((await res.json()) as any).error)}`);
  const body = opts.stream ? await collectStream(res) : ((await res.json()) as any);
  return { body, ms: Date.now() - started };
}

/**
 * Reads the SSE stream, echoing tokens live, and rebuilds a non-streaming
 * style response from the chunks so the rest of the script can treat both
 * paths the same. Thinking arrives as `delta.reasoning_content`, the answer as
 * `delta.content`; the final chunk carries finish_reason, usage and meetiq.
 */
async function collectStream(res: Response) {
  const acc = {
    reasoning: '',
    content: '',
    tool_calls: [] as ToolCall[],
    finish_reason: 'stop',
    usage: {},
    meetiq: {},
  };
  let phase: 'none' | 'reasoning' | 'content' = 'none';
  const enter = (next: 'reasoning' | 'content') => {
    if (phase === next) return;
    if (phase !== 'none') process.stdout.write('\n');
    process.stdout.write(`   ${next === 'reasoning' ? c.magenta('▸ reasoning ') : c.green('▸ answer ')}`);
    phase = next;
  };
  let buffer = '';
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += new TextDecoder().decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n\n')) >= 0) {
      const event = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 2);
      if (!event.startsWith('data: ') || event === 'data: [DONE]') continue;
      const data = JSON.parse(event.slice(6));
      if (data.error) throw new Error(JSON.stringify(data.error));
      const choice = data.choices[0];
      if (choice.delta.reasoning_content) {
        enter('reasoning');
        process.stdout.write(c.magenta(choice.delta.reasoning_content));
        acc.reasoning += choice.delta.reasoning_content;
      }
      if (choice.delta.content) {
        enter('content');
        process.stdout.write(c.green(choice.delta.content));
        acc.content += choice.delta.content;
      }
      if (choice.delta.tool_calls) acc.tool_calls.push(...choice.delta.tool_calls);
      if (choice.finish_reason) {
        acc.finish_reason = choice.finish_reason;
        acc.usage = data.usage;
        acc.meetiq = data.meetiq;
      }
    }
  }
  if (phase !== 'none') process.stdout.write('\n');
  return {
    choices: [
      {
        finish_reason: acc.finish_reason,
        message: {
          content: acc.content || null,
          ...(acc.reasoning ? { reasoning_content: acc.reasoning } : {}),
          ...(acc.tool_calls.length ? { tool_calls: acc.tool_calls } : {}),
        },
      },
    ],
    usage: acc.usage,
    meetiq: acc.meetiq,
  };
}

function showStep(r: Awaited<ReturnType<typeof chat>>, streamed = false) {
  const msg = r.body.choices[0].message;
  const m = r.body.meetiq;
  const route = `${m.mode_used}${m.router.detail ? ` (${m.router.rule}: ${m.router.detail})` : ` (${m.router.rule})`}`;
  const flags = [m.think_budget_hit ? c.yellow('budget hit') : '', m.retries ? c.yellow(`${m.retries} retry`) : '']
    .filter(Boolean)
    .join(' ');
  console.log(
    `   ${c.dim('route')} ${c.blue(route)}  ${c.dim('tools')} ${m.tool_parse}  ${c.dim('time')} ${secs(r.ms)}  ${c.dim('speed')} ${m.timing.eval_tps} tok/s  ${c.dim('tokens')} ${r.body.usage.completion_tokens} ${flags}`,
  );
  if (msg.reasoning_content)
    block(
      `reasoning (${r.body.usage.completion_tokens_details.reasoning_tokens} tokens)`,
      c.magenta,
      msg.reasoning_content.trim(),
    );
  for (const call of msg.tool_calls ?? [])
    console.log(
      `   ${c.yellow('⚙')} ${c.yellow(c.bold(call.function.name))}${c.yellow('(')}${call.function.arguments}${c.yellow(')')}`,
    );
  if (msg.content) block('answer', c.green, msg.content.trim());
  if (!msg.content && !msg.tool_calls?.length)
    console.log(`   ${c.red('(empty answer)')} finish_reason=${r.body.choices[0].finish_reason}`);
}

async function main() {
  const health = (await (await fetch(`${PROXY_URL}/health`)).json()) as any;
  console.log(
    `${c.bold('proxy')} ${PROXY_URL}  ${health.status === 'ok' ? c.green('ok') : c.red(health.status)}  model loaded=${health.model.loaded}  ollama managed=${health.ollama.managed}`,
  );

  const summary: Array<{ prompt: string; mode: string; calls: number; ms: number; tps: number }> = [];

  for (const [i, p] of PROMPTS.entries()) {
    console.log(`\n${c.cyan('━━')} ${c.bold(`${i + 1}/${PROMPTS.length}`)} ${c.cyan(p.prompt)}`);
    const messages: Message[] = [
      { role: 'system', content: p.system ?? SYSTEM },
      { role: 'user', content: p.prompt },
    ];
    const opts = { tools: p.tools ?? true, ...(p.mode ? { mode: p.mode } : {}), ...(p.stream ? { stream: true } : {}) };
    const row = { prompt: p.prompt, mode: '', calls: 0, ms: 0, tps: 0 };

    let r = await chat(messages, opts);
    row.mode = r.body.meetiq.mode_used;
    row.ms += r.ms;
    row.tps = r.body.meetiq.timing.eval_tps;
    showStep(r, Boolean(p.stream));

    // Round trip: run every tool the model asked for and send the results back.
    let hops = 0;
    while (r.body.choices[0].finish_reason === 'tool_calls' && hops++ < 3) {
      const msg = r.body.choices[0].message;
      messages.push({ role: 'assistant', content: msg.content, tool_calls: msg.tool_calls });
      for (const call of msg.tool_calls as ToolCall[]) {
        row.calls++;
        const result = runTool(call.function.name, JSON.parse(call.function.arguments));
        const text = JSON.stringify(result);
        messages.push({ role: 'tool', tool_call_id: call.id, content: text });
        console.log(`   ${c.gray('↩')} ${c.gray(`${call.function.name} result:`)} ${c.dim(clip(text))}`);
      }
      console.log(`   ${c.dim(`── hop ${hops}: sending tool results back`)}`);
      r = await chat(messages, opts);
      row.ms += r.ms;
      showStep(r, Boolean(p.stream));
    }
    summary.push(row);
  }

  console.log(`\n${c.bold('summary')}`);
  for (const s of summary) {
    console.log(
      `  ${c.blue(s.mode.padEnd(8))} ${String(s.calls).padStart(2)} tool call(s)  ${secs(s.ms).padStart(7)}  ${String(s.tps).padStart(5)} tok/s  ${c.dim(clip(s.prompt, 60))}`,
    );
  }
}

main().catch((err) => {
  console.error(c.red(String(err)));
  process.exit(1);
});
