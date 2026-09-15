/**
 * Context providers.
 *
 * Providers run before the model composes a reply, so this is where the agent
 * learns two things it would otherwise guess at and get wrong: which chains it
 * can actually reach, and whether a post it writes will really be published.
 *
 * Neither provider makes a network call. They run on every message, and
 * `X.verify()` is rate-limited hard enough that calling it per message would
 * exhaust the quota the posting itself needs.
 */
import type { IAgentRuntime, Provider, ProviderResult } from '@elizaos/core';
import { allChains } from '../core/registry.js';
import { loadXConfig } from '../x/client.js';
import { loadGrokConfig } from '../grok/client.js';
import { settingsEnv } from './settings.js';

/**
 * Chain coverage, grouped by family. Listing every id matters: the model has to
 * know that "hyperliquid" is or is not answerable before it promises an answer,
 * and a custom chain from `~/.singularity/config.json` shows up here too.
 */
export const chainContextProvider: Provider = {
  name: 'SINGULARITY_CHAINS',
  description: 'The chains this agent can query, grouped by family.',
  // Ahead of the conversation history: capability framing should be read first.
  position: -10,

  get: async (): Promise<ProviderResult> => {
    const byFamily = new Map<string, string[]>();
    for (const chain of allChains()) {
      const ids = byFamily.get(chain.family) ?? [];
      ids.push(chain.id);
      byFamily.set(chain.family, ids);
    }

    const lines = [...byFamily.entries()].map(([family, ids]) => `${family}: ${ids.join(', ')}`);

    return {
      text: [
        'Chains available for lookups (use these exact ids):',
        ...lines,
        'Balances are returned without fiat pricing, and EVM token lists cover a curated set of major tokens only — never present one as a complete holdings list.',
        'This agent holds no private keys. It can build an unsigned transfer for the user to sign themselves, but it cannot sign or broadcast anything.',
      ].join('\n'),
      values: { chainCount: allChains().length },
      data: { chains: Object.fromEntries(byFamily) },
    };
  },
};

/**
 * Whether a post will actually be published.
 *
 * Without this the agent says "posted!" after a dry run, because from inside
 * the conversation a draft and a publish look identical.
 */
export const postingStatusProvider: Provider = {
  name: 'X_POSTING_STATUS',
  description: 'Whether posts to X will be published or only drafted.',
  position: -5,

  get: async (runtime: IAgentRuntime): Promise<ProviderResult> => {
    const env = settingsEnv(runtime);
    const x = loadXConfig(env);
    const grok = loadGrokConfig(env);

    const text = !x
      ? 'X is not configured. You cannot post, and should say so rather than offering to.'
      : x.postingEnabled
        ? 'X posting is LIVE. Anything you post is public immediately and cannot be fully retracted. Get the user to confirm the exact wording before you publish.'
        : 'X posting is DISABLED (X_POSTING_ENABLED is not "true"). Posts are drafted and shown to the user but never published. Never claim a post went out.';

    return {
      text,
      values: { xConfigured: Boolean(x), xPostingEnabled: x?.postingEnabled ?? false },
      data: { grokConfigured: Boolean(grok), grokModel: grok?.model ?? null },
    };
  },
};

export const providers: Provider[] = [chainContextProvider, postingStatusProvider];
