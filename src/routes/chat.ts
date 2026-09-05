import { Router, type Response } from 'express';
import type { AppContext } from '../app.js';
import { runChatCompletion, type CompletionResult, type StreamDelta } from '../core/completion.js';
import { ProxyError } from '../core/errors.js';
import {
  buildChunk,
  buildCompletion,
  estimatePromptTokens,
  parseChatRequest,
  type ChatRequest,
  type ChunkDelta,
} from '../core/mapping.js';
import { decideMode } from '../core/router.js';
import { SseWriter } from '../core/stream.js';
import { asyncHandler, toProxyError } from '../middleware.js';
import { newCompletionId } from '../util/ids.js';

export function chatRouter(ctx: AppContext): Router {
  const { config, log, queue } = ctx;
  const router = Router();

  router.post(
    '/chat/completions',
    asyncHandler(async (req, res) => {
      const startedAt = Date.now();
      const body = parseChatRequest(req.body);
      const promptEstimate = estimatePromptTokens(body);
      if (promptEstimate > config.MAX_PROMPT_TOKENS) {
        throw new ProxyError(
          400,
          'context_length_exceeded',
          `Prompt is estimated at ${promptEstimate} tokens, above MAX_PROMPT_TOKENS=${config.MAX_PROMPT_TOKENS}. Split the input into smaller chunks.`,
        );
      }

      const abort = new AbortController();
      res.on('close', () => {
        if (!res.writableFinished) abort.abort();
      });

      const id = newCompletionId();
      const created = Math.floor(startedAt / 1000);
      let queueWaitMs = 0;
      let sse: SseWriter | undefined;
      const base = { request_id: req.id, stream: Boolean(body.stream), prompt_estimate: promptEstimate };

      try {
        const result = await queue.run(async () => {
          queueWaitMs = Date.now() - startedAt;
          const decision = await decideMode(body, config, ctx.classify);
          res.setHeader('x-meetiq-mode', decision.mode);
          res.setHeader('x-meetiq-rule', decision.rule);
          if (!body.stream) return jsonCompletion(res, body, id, created, decision, abort.signal);
          sse = new SseWriter(res);
          return streamCompletion(sse, body, id, created, decision, abort.signal);
        }, abort.signal);

        log.info(
          {
            ...base,
            status: 200,
            mode_requested: result.meta.mode_requested,
            mode_used: result.meta.mode_used,
            router_rule: result.meta.router.rule,
            tool_parse: result.meta.tool_parse,
            think_budget_hit: result.meta.think_budget_hit,
            retries: result.meta.retries,
            finish_reason: result.finishReason,
            prompt_tokens: result.usage.prompt_tokens,
            completion_tokens: result.usage.completion_tokens,
            thinking_tokens: result.usage.completion_tokens_details.reasoning_tokens,
            upstream_calls: result.meta.upstream_calls,
            upstream_ms: result.meta.upstream_ms,
            load_ms: result.meta.timing.load_ms,
            prompt_eval_ms: result.meta.timing.prompt_eval_ms,
            eval_ms: result.meta.timing.eval_ms,
            eval_tps: result.meta.timing.eval_tps,
            queue_wait_ms: queueWaitMs,
            total_ms: Date.now() - startedAt,
          },
          'chat.completion',
        );
      } catch (err) {
        const proxyError = toProxyError(err);
        log.warn(
          {
            ...base,
            status: proxyError.status,
            code: proxyError.code,
            message: proxyError.message,
            queue_wait_ms: queueWaitMs,
            total_ms: Date.now() - startedAt,
          },
          'chat.completion failed',
        );
        if (sse) {
          // Streaming already started: deliver the error in-band and terminate the stream.
          sse.data(proxyError.toBody());
          sse.done();
          return;
        }
        throw err;
      }
    }),
  );

  async function jsonCompletion(
    res: Response,
    body: ChatRequest,
    id: string,
    created: number,
    decision: Awaited<ReturnType<typeof decideMode>>,
    signal: AbortSignal,
  ): Promise<CompletionResult> {
    const result = await runChatCompletion(ctx, body, decision, signal);
    res.json(buildCompletion({ id, created, model: config.MODEL, ...result }));
    return result;
  }

  async function streamCompletion(
    sse: SseWriter,
    body: ChatRequest,
    id: string,
    created: number,
    decision: Awaited<ReturnType<typeof decideMode>>,
    signal: AbortSignal,
  ): Promise<CompletionResult> {
    const chunk = (delta: ChunkDelta, extra: Partial<Parameters<typeof buildChunk>[0]> = {}) =>
      sse.data(buildChunk({ id, created, model: config.MODEL, delta, ...extra }));

    chunk({ role: 'assistant' });
    const result = await runChatCompletion(ctx, body, decision, signal, (d: StreamDelta) => chunk(toChunkDelta(d)));
    chunk({}, { finishReason: result.finishReason, usage: result.usage, meta: result.meta });
    sse.done();
    return result;
  }

  return router;
}

function toChunkDelta(d: StreamDelta): ChunkDelta {
  return {
    ...(d.content ? { content: d.content } : {}),
    ...(d.reasoning ? { reasoning_content: d.reasoning } : {}),
    ...(d.toolCalls ? { tool_calls: d.toolCalls.map((c, index) => ({ index, ...c })) } : {}),
  };
}
