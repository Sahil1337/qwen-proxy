import { Router } from 'express';
import type { AppContext } from '../app.js';
import { firstUpstreamRequest } from '../core/completion.js';
import { estimatePromptTokens, lastUserText, parseChatRequest } from '../core/mapping.js';
import { decideMode, requestedMode } from '../core/router.js';
import { asyncHandler } from '../middleware.js';
import { estimateTokens } from '../util/tokens.js';

/**
 * Dry runs. Both take the same body as /v1/chat/completions and never generate:
 *  - POST /v1/route    the adaptive router decision
 *  - POST /v1/inspect  the decision plus the exact first payload that would go to Ollama
 */
export function routeRouter(ctx: AppContext): Router {
  const router = Router();

  router.post(
    '/inspect',
    asyncHandler(async (req, res) => {
      const body = parseChatRequest(req.body);
      const decision = await ctx.queue.run(() => decideMode(body, ctx.config, ctx.classify));
      const { plan, request } = firstUpstreamRequest(body, ctx.config, decision);
      res.setHeader('x-meetiq-mode', decision.mode);
      res.json({
        router: decision,
        mode_used: plan.modeUsed,
        buffered_streaming: plan.buffered,
        tool_path: plan.forcedChoice ? 'forced' : plan.activeTools ? ctx.config.TOOL_INJECTION : 'none',
        estimated_prompt_tokens: estimateTokens(JSON.stringify(request.messages) + JSON.stringify(request.tools ?? '')),
        upstream_request: request,
      });
    }),
  );

  router.post(
    '/route',
    asyncHandler(async (req, res) => {
      const body = parseChatRequest(req.body);
      const decision = await ctx.queue.run(() => decideMode(body, ctx.config, ctx.classify));
      res.setHeader('x-meetiq-mode', decision.mode);
      res.json({
        ...decision,
        mode_requested: requestedMode(body) ?? null,
        default_mode: ctx.config.DEFAULT_MODE,
        estimated_prompt_tokens: estimatePromptTokens(body),
        last_user_tokens: estimateTokens(lastUserText(body.messages)),
      });
    }),
  );
  return router;
}
