/**
 * The elizaOS plugin.
 *
 * `@elizaos/core` is imported for types only, everywhere in this directory. The
 * plugin is a plain object of functions, so nothing from Eliza is needed at
 * runtime — which keeps a 22 MB agent framework out of the dependency tree of
 * the CLI and the MCP server, both of which have nothing to do with it. Eliza
 * is a peer dependency: whoever runs the agent already has it.
 *
 * Model handlers are registered here too, so loading this one plugin gives an
 * agent both the chain tools and Grok as its brain.
 */
import type { Plugin } from '@elizaos/core';
import { chainActions } from './actions.js';
import { postToXAction } from './post-action.js';
import { postProjectUpdateAction } from './update-action.js';
import { providers } from './providers.js';
import { grokModels } from './grok-model.js';
import { loadXConfig } from '../x/client.js';
import { loadGrokConfig } from '../grok/client.js';

export const singularityPlugin: Plugin = {
  name: 'singularity',
  description:
    'Read-only multi-chain blockchain lookups (EVM, Solana, Bitcoin, Cosmos) plus gated X posting, with Grok as the text model.',

  // Above the default model plugins, so an agent that also loads another
  // provider still thinks with Grok. Actions are unaffected by priority.
  priority: 100,

  actions: [...chainActions, postToXAction, postProjectUpdateAction],
  providers,
  models: grokModels,

  /**
   * Startup is the only place a misconfiguration can be reported to a human.
   * Once the agent is running, a missing key surfaces as a failed action in the
   * middle of a conversation, which is where it is least useful.
   *
   * None of these are fatal: an agent with no xAI key can still run on another
   * model plugin, and one with no X credentials is simply a read-only agent.
   */
  async init(_config, runtime) {
    const env = { ...process.env };
    for (const key of ['XAI_API_KEY', 'X_API_KEY', 'X_POSTING_ENABLED'] as const) {
      const fromRuntime = runtime.getSetting(key);
      if (fromRuntime !== null && fromRuntime !== undefined) env[key] = String(fromRuntime);
    }

    if (!loadGrokConfig(env)) {
      console.warn(
        '[singularity] XAI_API_KEY is not set — Grok model handlers will fail. Get a key from console.x.ai.',
      );
    }

    const x = loadXConfig(env);
    if (!x) {
      console.warn('[singularity] X credentials are not set — posting is unavailable.');
    } else if (x.postingEnabled) {
      console.warn(
        '[singularity] X_POSTING_ENABLED=true — posts from this agent are PUBLIC and immediate.',
      );
    }
  },
};

export default singularityPlugin;
