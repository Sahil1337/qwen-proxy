import type { Config } from '../config.js';
import { estimateTokens } from '../util/tokens.js';
import type {
  OllamaChatChunk,
  OllamaChatRequest,
  OllamaClient,
  OllamaFormat,
  OllamaMessage,
  OllamaOptions,
  OllamaToolCall,
} from './ollama.js';

const OPEN = '<think>';
const CLOSE = '</think>';

/** Length of the longest prefix of `tag` that `text` ends with (0 if none). */
function partialTagSuffix(text: string, tag: string): number {
  for (let k = Math.min(tag.length - 1, text.length); k > 0; k--) {
    if (text.endsWith(tag.slice(0, k))) return k;
  }
  return 0;
}

/**
 * Incremental splitter that routes `<think>...</think>` spans to `thinking`
 * and everything else to `content`. Safe to feed one token at a time: a tag
 * split across chunks is held back until it resolves.
 */
export class ThinkSplitter {
  private buffer = '';
  private inside = false;

  push(chunk: string): { content: string; thinking: string } {
    this.buffer += chunk;
    let content = '';
    let thinking = '';
    for (;;) {
      const tag = this.inside ? CLOSE : OPEN;
      const at = this.buffer.indexOf(tag);
      if (at >= 0) {
        const before = this.buffer.slice(0, at);
        if (this.inside) thinking += before;
        else content += before;
        this.buffer = this.buffer.slice(at + tag.length);
        this.inside = !this.inside;
        continue;
      }
      const hold = partialTagSuffix(this.buffer, tag);
      const emit = this.buffer.slice(0, this.buffer.length - hold);
      this.buffer = this.buffer.slice(this.buffer.length - hold);
      if (this.inside) thinking += emit;
      else content += emit;
      return { content, thinking };
    }
  }

  flush(): { content: string; thinking: string } {
    const rest = this.buffer;
    this.buffer = '';
    return this.inside ? { content: '', thinking: rest } : { content: rest, thinking: '' };
  }
}

export function splitThink(text: string): { content: string; thinking: string } {
  const splitter = new ThinkSplitter();
  const a = splitter.push(text);
  const b = splitter.flush();
  return { content: a.content + b.content, thinking: a.thinking + b.thinking };
}

export const stripThink = (text: string): string => splitThink(text).content;

// ---------------------------------------------------------------------------
// One model turn with thinking handling
// ---------------------------------------------------------------------------

export type Mode = 'fast' | 'thinking';

export interface TurnInput {
  messages: OllamaMessage[];
  mode: Mode;
  maxTokens: number;
  options: OllamaOptions;
  tools?: unknown[];
  format?: OllamaFormat;
}

export interface Delta {
  content?: string;
  reasoning?: string;
}

export interface UpstreamTiming {
  /** Model (re)load time, ms. Non-zero means Ollama reloaded the model for this call. */
  loadMs: number;
  promptEvalMs: number;
  evalMs: number;
}

export interface TurnResult {
  content: string;
  thinking: string;
  nativeToolCalls: OllamaToolCall[];
  doneReason: string | undefined;
  promptTokens: number;
  completionTokens: number;
  budgetHit: boolean;
  upstreamCalls: number;
  upstreamMs: number;
  timing: UpstreamTiming;
  /** Exact payloads sent to Ollama, in order. */
  requests: OllamaChatRequest[];
}

const addTiming = (a: UpstreamTiming, b: UpstreamTiming): UpstreamTiming => ({
  loadMs: a.loadMs + b.loadMs,
  promptEvalMs: a.promptEvalMs + b.promptEvalMs,
  evalMs: a.evalMs + b.evalMs,
});

export const FORCED_CLOSE = '\n\nBased on the above, the final answer is:';

/**
 * The exact Ollama payload for a turn. In thinking mode the model may spend
 * THINK_BUDGET_TOKENS on reasoning on top of the caller's answer budget.
 */
export function turnRequest(config: Config, input: TurnInput, stream: boolean): OllamaChatRequest {
  const think = input.mode === 'thinking';
  const numPredict = think ? config.THINK_BUDGET_TOKENS + input.maxTokens : input.maxTokens;
  return {
    model: config.MODEL,
    messages: input.messages,
    stream,
    think,
    options: { ...input.options, num_predict: numPredict },
    ...(input.tools ? { tools: input.tools } : {}),
    ...(input.format ? { format: input.format } : {}),
  };
}

/**
 * Runs one turn in `fast` (think:false) or `thinking` (think:true) mode.
 * In thinking mode the response is capped at THINK_BUDGET_TOKENS + maxTokens.
 * If the model spends the whole budget thinking and produces no answer, a
 * second call continues from the truncated thinking with a forced close.
 */
export async function runTurn(
  client: OllamaClient,
  config: Config,
  input: TurnInput,
  signal?: AbortSignal,
  onDelta?: (delta: Delta) => void,
): Promise<TurnResult> {
  const stream = Boolean(onDelta);
  const first = await callOnce(client, turnRequest(config, input, stream), signal, onDelta);
  if (input.mode !== 'thinking' || first.thinking.trim().length === 0 || first.nativeToolCalls.length > 0) return first;

  // The budget covers thinking + answer. If generation stopped on length with no answer, or with an
  // answer far shorter than the caller asked for, the model spent the budget thinking: continue from
  // the truncated thinking (and any partial answer) with thinking disabled.
  const partial = first.content.trimEnd();
  const cutOff = first.doneReason === 'length' && estimateTokens(partial) < input.maxTokens;
  if (partial.length > 0 && !cutOff) return first;

  const prefix: OllamaMessage = {
    role: 'assistant',
    content: `${OPEN}\n${first.thinking.trimEnd()}\n${CLOSE}${partial ? partial : FORCED_CLOSE}`,
  };
  const continuation = turnRequest(config, { ...input, mode: 'fast', messages: [...input.messages, prefix] }, stream);
  const second = await callOnce(
    client,
    continuation,
    signal,
    onDelta ? (d) => d.content && onDelta({ content: d.content }) : undefined,
  );
  return {
    ...second,
    content: partial + second.content,
    thinking: first.thinking,
    budgetHit: true,
    promptTokens: first.promptTokens + second.promptTokens,
    completionTokens: first.completionTokens + second.completionTokens,
    upstreamCalls: first.upstreamCalls + second.upstreamCalls,
    upstreamMs: first.upstreamMs + second.upstreamMs,
    timing: addTiming(first.timing, second.timing),
    requests: [...first.requests, ...second.requests],
  };
}

async function callOnce(
  client: OllamaClient,
  req: OllamaChatRequest,
  signal?: AbortSignal,
  onDelta?: (d: Delta) => void,
): Promise<TurnResult> {
  const started = Date.now();
  const splitter = new ThinkSplitter();
  const result: TurnResult = {
    content: '',
    thinking: '',
    nativeToolCalls: [],
    doneReason: undefined,
    promptTokens: 0,
    completionTokens: 0,
    budgetHit: false,
    upstreamCalls: 1,
    upstreamMs: 0,
    timing: { loadMs: 0, promptEvalMs: 0, evalMs: 0 },
    requests: [req],
  };
  const ms = (ns: number | undefined) => Math.round((ns ?? 0) / 1e6);

  const absorb = (chunk: OllamaChatChunk) => {
    const delta: Delta = {};
    if (chunk.message.thinking) {
      result.thinking += chunk.message.thinking;
      delta.reasoning = chunk.message.thinking;
    }
    if (chunk.message.content) {
      const split = splitter.push(chunk.message.content);
      result.content += split.content;
      result.thinking += split.thinking;
      if (split.content) delta.content = split.content;
      if (split.thinking) delta.reasoning = (delta.reasoning ?? '') + split.thinking;
    }
    if (chunk.message.tool_calls?.length) result.nativeToolCalls.push(...chunk.message.tool_calls);
    if (chunk.done) {
      result.doneReason = chunk.done_reason;
      result.promptTokens += chunk.prompt_eval_count ?? 0;
      result.completionTokens += chunk.eval_count ?? 0;
      result.timing = {
        loadMs: ms(chunk.load_duration),
        promptEvalMs: ms(chunk.prompt_eval_duration),
        evalMs: ms(chunk.eval_duration),
      };
    }
    if (onDelta && (delta.content || delta.reasoning)) onDelta(delta);
  };

  if (onDelta) {
    for await (const chunk of client.chatStream(req, signal)) absorb(chunk);
  } else {
    absorb(await client.chat(req, signal));
  }

  const tail = splitter.flush();
  result.content += tail.content;
  result.thinking += tail.thinking;
  if (onDelta && tail.content) onDelta({ content: tail.content });
  if (onDelta && tail.thinking) onDelta({ reasoning: tail.thinking });
  result.upstreamMs = Date.now() - started;
  return result;
}
