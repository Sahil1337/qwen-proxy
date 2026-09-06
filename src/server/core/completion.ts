import type { Ajv } from 'ajv';
import type { Config } from '../config.js';
import { ProxyError } from './errors.js';
import {
  requestOptions,
  resolveMaxTokens,
  toOllamaMessages,
  renderToolCallBlock,
  type ChatRequest,
  type Tool,
  type ToolChoice,
} from './mapping.js';
import type { FinishReason, ProxyMeta, ToolCall, ToolParse, Usage } from '../../shared/types.js';
import type { OllamaClient, OllamaMessage } from './ollama.js';
import { requestedMode, type RouteDecision } from './router.js';
import { resolveFormat, validateStructuredOutput } from './structured.js';
import { runTurn, turnRequest, type Delta, type Mode, type TurnInput, type TurnResult } from './thinking.js';
import {
  forcedToolFormat,
  fromNativeToolCalls,
  injectTools,
  isForcedChoice,
  parseForcedOutput,
  parseToolCalls,
  slimTools,
  toOpenAIToolCalls,
  validateToolCalls,
  type ParseResult,
} from './tools.js';
import { estimateTokens } from '../util/tokens.js';

export interface CompletionDeps {
  client: OllamaClient;
  config: Config;
  ajv: Ajv;
}

export interface StreamDelta extends Delta {
  toolCalls?: ToolCall[];
}

export interface CompletionResult {
  content: string | null;
  reasoning: string | null;
  toolCalls: ToolCall[];
  finishReason: FinishReason;
  usage: Usage;
  meta: ProxyMeta;
}

const TOOL_RETRY_PROMPT = (errors: string[]) =>
  `Your previous tool call was invalid: ${errors.join('; ')}. Emit a corrected <tool_call>.`;
const STRUCTURED_RETRY_PROMPT = (error: string) =>
  `Your previous response did not match the required JSON schema: ${error}. Respond again with only valid JSON.`;

/** Everything decided about a request before the first upstream call. */
export interface CompletionPlan {
  /** Tools the caller sent (full schemas, used for validation), or undefined when none apply. */
  activeTools: Tool[] | undefined;
  forcedChoice: ToolChoice | undefined;
  modeUsed: Mode;
  /** Streaming must buffer when the output has to be validated first. */
  buffered: boolean;
  /** Input for the first turn: what the model actually sees. */
  turn: TurnInput;
}

export function planCompletion(req: ChatRequest, config: Config, decision: RouteDecision): CompletionPlan {
  const activeTools: Tool[] | undefined = req.tool_choice === 'none' || !req.tools?.length ? undefined : req.tools;
  const forcedChoice = activeTools && req.tool_choice && isForcedChoice(req.tool_choice) ? req.tool_choice : undefined;
  const structuredFormat = resolveFormat(req.response_format);
  const modeUsed: Mode = forcedChoice ? 'fast' : decision.mode;

  // Tools rendered for the model may be slimmed; validation always uses `activeTools`.
  const promptTools =
    activeTools && !forcedChoice ? (config.TOOL_SCHEMA_SLIM ? slimTools(activeTools) : activeTools) : undefined;
  const baseMessages = toOllamaMessages(req.messages);
  const messages =
    promptTools && config.TOOL_INJECTION === 'prompt' ? injectTools(baseMessages, promptTools) : baseMessages;
  const nativeTools = promptTools && config.TOOL_INJECTION === 'native' ? promptTools : undefined;
  // `format` becomes a decoding grammar, not prompt text, so it is never slimmed.
  const format = forcedChoice && activeTools ? forcedToolFormat(activeTools, forcedChoice) : structuredFormat;

  return {
    activeTools,
    forcedChoice,
    modeUsed,
    buffered: activeTools !== undefined || structuredFormat !== undefined,
    turn: {
      messages,
      mode: modeUsed,
      maxTokens: resolveMaxTokens(req, config),
      options: requestOptions(req, config),
      ...(nativeTools ? { tools: nativeTools } : {}),
      ...(format ? { format } : {}),
    },
  };
}

/** The first payload that would go to Ollama for this request (used by /v1/inspect). */
export function firstUpstreamRequest(req: ChatRequest, config: Config, decision: RouteDecision) {
  const plan = planCompletion(req, config, decision);
  return { plan, request: turnRequest(config, plan.turn, Boolean(req.stream) && !plan.buffered) };
}

/**
 * Runs one chat completion end to end: mode selection is already done by the
 * caller (so it can set headers first); this function handles tool calling,
 * structured output, validation retries and usage accounting.
 *
 * `onDelta` enables streaming. Responses that must be validated (tools or
 * response_format) are buffered and delivered as a single delta at the end.
 */
export async function runChatCompletion(
  deps: CompletionDeps,
  req: ChatRequest,
  decision: RouteDecision,
  signal?: AbortSignal,
  onDelta?: (delta: StreamDelta) => void,
): Promise<CompletionResult> {
  const { client, config, ajv } = deps;
  const { activeTools, forcedChoice, modeUsed, buffered, turn: turnInput } = planCompletion(req, config, decision);
  const messages = turnInput.messages;
  const streamDelta = buffered ? undefined : onDelta;

  const stats = {
    retries: 0,
    calls: 0,
    ms: 0,
    prompt: 0,
    completion: 0,
    budgetHit: false,
    loadMs: 0,
    promptEvalMs: 0,
    evalMs: 0,
    requests: [] as unknown[],
  };
  const track = (turn: TurnResult): TurnResult => {
    stats.calls += turn.upstreamCalls;
    stats.ms += turn.upstreamMs;
    stats.prompt += turn.promptTokens;
    stats.completion += turn.completionTokens;
    stats.budgetHit ||= turn.budgetHit;
    stats.loadMs += turn.timing.loadMs;
    stats.promptEvalMs += turn.timing.promptEvalMs;
    stats.evalMs += turn.timing.evalMs;
    stats.requests.push(...turn.requests);
    return turn;
  };

  const turnFor = (msgs: OllamaMessage[]) =>
    runTurn(client, config, { ...turnInput, messages: msgs }, signal, streamDelta).then(track);

  let turn = await turnFor(messages);
  let toolParse: ToolParse = 'none';
  let content: string | null = turn.content.trim() || null;
  let toolCalls: ToolCall[] = [];

  if (activeTools) {
    const extract = (t: TurnResult): ParseResult => {
      if (forcedChoice) return parseForcedOutput(t.content);
      if (t.nativeToolCalls.length) return fromNativeToolCalls(t.nativeToolCalls);
      return parseToolCalls(t.content);
    };
    let parsed = extract(turn);
    let errors = [...parsed.errors, ...validateToolCalls(parsed.calls, activeTools, ajv)];
    if (errors.length) {
      stats.retries++;
      const retryMessages: OllamaMessage[] = [
        ...messages,
        { role: 'assistant', content: assistantTranscript(turn) },
        { role: 'user', content: TOOL_RETRY_PROMPT(errors) },
      ];
      turn = await turnFor(retryMessages);
      parsed = extract(turn);
      errors = [...parsed.errors, ...validateToolCalls(parsed.calls, activeTools, ajv)];
      if (errors.length) {
        throw new ProxyError(
          502,
          'tool_call_invalid',
          `Model produced an invalid tool call after one retry: ${errors.join('; ')}`,
          'upstream_error',
          {
            raw: turn.content,
            errors,
          },
        );
      }
    }
    if (parsed.calls.length) {
      toolParse = forcedChoice ? 'forced' : turn.nativeToolCalls.length ? 'native' : 'fallback';
      toolCalls = toOpenAIToolCalls(parsed.calls);
      content = parsed.content;
    } else {
      content = turn.content.trim() || null;
    }
  }

  if (req.response_format && req.response_format.type !== 'text' && toolCalls.length === 0) {
    let check = validateStructuredOutput(turn.content, req.response_format, ajv);
    if (!check.ok) {
      stats.retries++;
      const retryMessages: OllamaMessage[] = [
        ...messages,
        { role: 'assistant', content: turn.content },
        { role: 'user', content: STRUCTURED_RETRY_PROMPT(check.error) },
      ];
      turn = await turnFor(retryMessages);
      check = validateStructuredOutput(turn.content, req.response_format, ajv);
      if (!check.ok) {
        throw new ProxyError(
          502,
          'structured_output_invalid',
          `Model output did not match response_format after one retry: ${check.error}`,
          'upstream_error',
          {
            raw: turn.content,
            error: check.error,
          },
        );
      }
    }
    content = turn.content.trim();
  }

  const reasoning = turn.thinking.trim() || null;
  const finishReason: FinishReason = toolCalls.length ? 'tool_calls' : turn.doneReason === 'length' ? 'length' : 'stop';
  if (buffered && onDelta) {
    onDelta({
      ...(reasoning ? { reasoning } : {}),
      ...(content ? { content } : {}),
      ...(toolCalls.length ? { toolCalls } : {}),
    });
  }

  return {
    content,
    reasoning,
    toolCalls,
    finishReason,
    usage: {
      prompt_tokens: stats.prompt,
      completion_tokens: stats.completion,
      total_tokens: stats.prompt + stats.completion,
      completion_tokens_details: { reasoning_tokens: reasoning ? estimateTokens(reasoning) : 0 },
    },
    meta: {
      router: decision,
      mode_requested: requestedMode(req) ?? null,
      mode_used: modeUsed,
      tool_parse: toolParse,
      think_budget_hit: stats.budgetHit,
      retries: stats.retries,
      upstream_calls: stats.calls,
      upstream_ms: stats.ms,
      timing: {
        load_ms: stats.loadMs,
        prompt_eval_ms: stats.promptEvalMs,
        eval_ms: stats.evalMs,
        eval_tps: stats.evalMs > 0 ? Math.round((stats.completion / stats.evalMs) * 1000 * 10) / 10 : 0,
      },
      ...(req.debug ? { upstream_requests: stats.requests } : {}),
    },
  };
}

/** What the model "said" in a turn, rendered so it can be echoed back before a correction. */
function assistantTranscript(turn: TurnResult): string {
  if (!turn.nativeToolCalls.length) return turn.content;
  const blocks = turn.nativeToolCalls.map((c) => renderToolCallBlock(c.function.name, c.function.arguments));
  return [turn.content.trim(), ...blocks].filter(Boolean).join('\n');
}
