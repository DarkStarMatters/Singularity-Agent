/**
 * Grok as Eliza's text model.
 *
 * Registering `TEXT_SMALL` and `TEXT_LARGE` is what makes `runtime.useModel()`
 * — and therefore every reply the agent composes, including its X posts — run
 * on xAI rather than on whatever other model plugin happens to be loaded.
 *
 * Both sizes go to the same account. `XAI_SMALL_MODEL` exists so the cheap,
 * high-frequency calls (should-I-respond checks, summaries) can be pointed at a
 * smaller model without touching the one that writes the posts; unset, both use
 * `XAI_MODEL`.
 */
import type { GenerateTextParams, IAgentRuntime } from '@elizaos/core';
import { GrokClient, loadGrokConfig, type ChatMessage } from '../grok/client.js';
import { SingularityError } from '../core/errors.js';
import { settingsEnv } from './settings.js';

/** Eliza's own defaults, applied when a caller passes nothing. */
const DEFAULT_MAX_TOKENS = { small: 1_024, large: 4_096 } as const;

export function grokClientFor(runtime: IAgentRuntime, size: 'small' | 'large'): GrokClient {
  const env = settingsEnv(runtime);
  const config = loadGrokConfig(env);

  if (!config) {
    throw new SingularityError(
      'GROK_NOT_CONFIGURED',
      'No xAI API key is available, so the Grok model cannot answer.',
      'Set XAI_API_KEY in .env, or put it in the character\'s secrets block. Keys come from console.x.ai and start with "xai-".',
    );
  }

  const small = env.XAI_SMALL_MODEL?.trim();
  return new GrokClient(size === 'small' && small ? { ...config, model: small } : config);
}

/**
 * Eliza hands over one flattened prompt rather than a message array, so it goes
 * across as a single user turn — inventing a system/user split here would cut
 * the character's own system prompt out of the part xAI weights most.
 */
export function toChatMessages(params: GenerateTextParams): ChatMessage[] {
  return [{ role: 'user', content: params.prompt }];
}

export function generateText(
  runtime: IAgentRuntime,
  params: GenerateTextParams,
  size: 'small' | 'large',
): Promise<string> {
  return grokClientFor(runtime, size).chat(toChatMessages(params), {
    ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
    maxTokens: params.maxTokens ?? DEFAULT_MAX_TOKENS[size],
  });
}

export const grokModels = {
  TEXT_SMALL: (runtime: IAgentRuntime, params: GenerateTextParams) =>
    generateText(runtime, params, 'small'),
  TEXT_LARGE: (runtime: IAgentRuntime, params: GenerateTextParams) =>
    generateText(runtime, params, 'large'),
};
