/**
 * Bridging Eliza's settings to the env-shaped loaders this repo already has.
 *
 * `loadXConfig` and `loadGrokConfig` take a `ProcessEnv` because the CLI, the
 * MCP server and the Telegram bot all read credentials from the environment.
 * Under Eliza the same values can also arrive from a character's `secrets`
 * block or from the runtime's settings store, so this builds a lookalike that
 * prefers the runtime and falls back to the process environment.
 */
import type { IAgentRuntime } from '@elizaos/core';

/** Every credential the plugin reads. Kept explicit — this is a secret surface. */
export const SETTING_KEYS = [
  'X_API_KEY',
  'X_API_SECRET',
  'X_ACCESS_TOKEN',
  'X_ACCESS_SECRET',
  'X_POSTING_ENABLED',
  'XAI_API_KEY',
  'XAI_MODEL',
  'XAI_SMALL_MODEL',
] as const;

/**
 * `getSetting` returns booleans and numbers for values stored as such, so they
 * are stringified back — the loaders parse strings, and `X_POSTING_ENABLED`
 * stored as a real `true` must still read as `"true"`.
 */
export function settingsEnv(runtime: IAgentRuntime): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const key of SETTING_KEYS) {
    const value = runtime.getSetting(key);
    env[key] = value === null || value === undefined ? process.env[key] : String(value);
  }

  return env;
}
