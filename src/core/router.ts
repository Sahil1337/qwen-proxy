import type { Config } from '../config.js';
import { baseOptions, lastUserText, type ChatRequest, type RequestedMode } from './mapping.js';
import type { OllamaClient } from './ollama.js';
import { stripThink, type Mode } from './thinking.js';
import { estimateTokens } from '../util/tokens.js';

/** Rule identifiers, in evaluation order. See README "Adaptive router". */
export type RouterRule =
  | 'explicit' // 1. caller sent mode / reasoning_effort
  | 'default' // 1b. DEFAULT_MODE is not adaptive
  | 'structured_output' // 2. response_format without tools -> fast
  | 'tools' // 3. tools present -> thinking
  | 'reasoning_cue' // 4. cue word in the last user message -> thinking
  | 'short_prompt' // 5. short last user message -> fast
  | 'classifier'; // 6. one tiny model call

export interface RouteDecision {
  mode: Mode;
  rule: RouterRule;
  detail?: string;
}

export type ClassifierVerdict = 'THINK' | 'FAST' | 'TIMEOUT' | 'ERROR';
export type Classifier = (lastUserMessage: string) => Promise<ClassifierVerdict>;

export const REASONING_CUES = [
  'why',
  'explain',
  'compare',
  'contradict',
  'conflict',
  'root cause',
  'trade-off',
  'tradeoff',
  'prioriti',
  'plan',
  'should we',
  'what changed',
  'timeline',
  'across meetings',
] as const;

const CUE_RE = new RegExp(`\\b(${REASONING_CUES.map((c) => c.replace(/[-]/g, '\\-')).join('|')})`, 'i');

export function findReasoningCue(text: string): string | undefined {
  return CUE_RE.exec(text)?.[1]?.toLowerCase();
}

/** `mode` wins; `reasoning_effort` is an alias ('none' -> fast, anything else -> thinking). */
export function requestedMode(req: ChatRequest): RequestedMode | undefined {
  if (req.mode) return req.mode;
  if (req.reasoning_effort !== undefined) return req.reasoning_effort === 'none' ? 'fast' : 'thinking';
  return undefined;
}

export async function decideMode(req: ChatRequest, config: Config, classify: Classifier): Promise<RouteDecision> {
  const explicit = requestedMode(req);
  if (explicit && explicit !== 'adaptive') return { mode: explicit, rule: 'explicit' };
  if (!explicit && config.DEFAULT_MODE !== 'adaptive') return { mode: config.DEFAULT_MODE, rule: 'default' };

  const hasTools = Boolean(req.tools?.length) && req.tool_choice !== 'none';
  if (req.response_format && req.response_format.type !== 'text' && !hasTools) {
    return { mode: 'fast', rule: 'structured_output' };
  }
  if (hasTools && config.ADAPTIVE_TOOLS_THINK) return { mode: 'thinking', rule: 'tools' };

  const text = lastUserText(req.messages);
  const cue = findReasoningCue(text);
  if (cue) return { mode: 'thinking', rule: 'reasoning_cue', detail: cue };
  if (estimateTokens(text) < config.ADAPTIVE_SHORT_TOKENS) return { mode: 'fast', rule: 'short_prompt' };

  const verdict = await classify(text);
  return { mode: verdict === 'THINK' ? 'thinking' : 'fast', rule: 'classifier', detail: verdict.toLowerCase() };
}

export const CLASSIFIER_SYSTEM_PROMPT =
  "Decide whether answering the user's request needs multi-step reasoning. Reply with exactly one word: FAST or THINK.";

/** Only the head of a long message is sent, so classification stays cheap. */
const CLASSIFIER_MAX_CHARS = 1500;

export function createClassifier(client: OllamaClient, config: Config): Classifier {
  return async (text) => {
    const signal = AbortSignal.timeout(config.CLASSIFIER_TIMEOUT_MS);
    try {
      const res = await client.chat(
        {
          model: config.MODEL,
          stream: false,
          think: false,
          messages: [
            { role: 'system', content: CLASSIFIER_SYSTEM_PROMPT },
            { role: 'user', content: text.slice(0, CLASSIFIER_MAX_CHARS) },
          ],
          options: { ...baseOptions(config), temperature: 0, num_predict: 3 },
        },
        signal,
      );
      return stripThink(res.message.content).trim().toUpperCase() === 'THINK' ? 'THINK' : 'FAST';
    } catch {
      return signal.aborted ? 'TIMEOUT' : 'ERROR';
    }
  };
}
