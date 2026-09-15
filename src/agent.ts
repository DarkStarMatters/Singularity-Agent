#!/usr/bin/env node
/**
 * Both halves in one process: `npm run agent`.
 *
 * The Telegram bot and the X listener were separate programs, which was fine
 * while they only shared a persona. Approval changes that — Telegram has to be
 * able to see the X bot's pending posts, publish one, pause it, and ask it what
 * it is doing. Sharing a process makes that a method call instead of an IPC
 * protocol, a queue, or a database.
 *
 * The important consequence is the safety default. With the two wired together,
 * nothing the agent composes reaches X until a person taps a button in
 * Telegram — the approval gate replaces direct publishing rather than sitting
 * alongside it.
 *
 * Either half can be missing. No xAI key means commands but no conversation; no
 * X credentials means a Telegram bot with nothing to control.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SingularityBot } from './telegram/bot.js';
import { ConfigError, loadConfig, loadEnvFile } from './telegram/config.js';
import { TelegramApi } from './telegram/api.js';
import { TelegramApprovals } from './telegram/approvals.js';
import type { XControl } from './telegram/control.js';
import { createAgent } from './grok/agent.js';
import { GrokClient, loadGrokConfig } from './grok/client.js';
import { XClient, loadXConfig } from './x/client.js';
import { XListener } from './x/listener.js';
import { PostGate } from './x/approval.js';
import type { UpdateAngle } from './x/updates.js';

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/**
 * Which chat reviews posts.
 *
 * Whoever can see that chat can publish to the account, so it is not inferred
 * loosely: an explicit `TELEGRAM_CONTROL_CHAT`, else the single allowlisted
 * chat when there is exactly one. Anything else is ambiguous and approval stays
 * off rather than sending drafts somewhere unintended.
 */
export function resolveControlChat(
  env: NodeJS.ProcessEnv,
  allowedChats: Set<number> | null,
): number | null {
  const explicit = Number(env.TELEGRAM_CONTROL_CHAT);
  if (Number.isInteger(explicit) && explicit !== 0) return explicit;

  if (allowedChats?.size === 1) return [...allowedChats][0]!;
  return null;
}

export async function main(): Promise<void> {
  loadEnvFile();

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`\n${err.message}`);
      if (err.hint) console.error(`\n${err.hint}\n`);
      process.exit(1);
    }
    throw err;
  }

  const bot = new SingularityBot(config);

  const xConfig = loadXConfig();
  const grokConfig = loadGrokConfig();
  const controlChat = resolveControlChat(process.env, config.allowedChats);

  let listener: XListener | null = null;

  if (xConfig && grokConfig) {
    const client = new XClient(xConfig);
    const approvalsOff = process.env.X_REQUIRE_APPROVAL?.trim().toLowerCase() === 'false';

    // Approval needs somewhere to ask. Without a control chat there is nobody
    // to ask, so the listener falls back to its own posting switch.
    const gate =
      controlChat !== null && !approvalsOff
        ? new PostGate(client, new TelegramApprovals(new TelegramApi(config.token), controlChat))
        : undefined;

    listener = new XListener(client, createAgent(new GrokClient(grokConfig), 'x'), {
      pollSeconds: positiveInt(process.env.X_POLL_SECONDS, 90),
      maxRepliesPerHour: positiveInt(process.env.X_MAX_REPLIES_PER_HOUR, 12),
      maxRepliesPerAuthorPerHour: positiveInt(process.env.X_MAX_REPLIES_PER_AUTHOR_PER_HOUR, 3),
      spam: {
        minAccountAgeDays: positiveInt(process.env.X_MIN_ACCOUNT_AGE_DAYS, 7),
        minFollowers: positiveInt(process.env.X_MIN_FOLLOWERS, 10),
      },
      updateIntervalHours: Number(process.env.X_UPDATE_INTERVAL_HOURS ?? 4),
      ...(gate ? { gate } : {}),
      ...(process.env.X_DRY_RUN?.trim().toLowerCase() === 'true' ? { dryRun: true } : {}),
    });

    bot.xControl = controlFor(listener, gate);

    console.error(
      gate
        ? `[singularity] approval required — drafts go to chat ${controlChat} for a decision.`
        : '[singularity] no control chat configured; the X bot publishes on its own switch. Set TELEGRAM_CONTROL_CHAT to review posts first.',
    );
  } else {
    console.error(
      '[singularity] X bot not started — ' +
        (!xConfig ? 'X credentials are missing.' : 'XAI_API_KEY is missing.'),
    );
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      console.error('\n[singularity] shutting down');
      bot.stop();
      listener?.stop();
      process.exit(0);
    });
  }

  // The listener runs alongside rather than under the bot: a rate-limit
  // backoff on X must not stall Telegram, which is the surface a person is
  // waiting on.
  if (listener) {
    listener.start().catch((err) => {
      console.error(`[singularity-x] stopped: ${(err as Error).message}`);
    });
  }

  await bot.start();
}

/** Adapts the listener and gate to the narrow surface Telegram may use. */
export function controlFor(listener: XListener, gate: PostGate | undefined): XControl {
  return {
    status: () => listener.status(),
    pause: () => listener.pause(),
    resume: () => listener.resume(),

    async composeNow(angle?: string) {
      const update = await listener.composeUpdateNow(angle as UpdateAngle | undefined);
      return update?.text ?? null;
    },

    pending: () => gate?.pending() ?? [],

    async approve(id, by) {
      if (!gate) return 'Approval is not enabled, so there is nothing queued.';

      const resolved = await gate.approve(id, by);
      if (!resolved) return `No pending post with id ${id} — it may have expired.`;

      return resolved.error
        ? `Publishing failed: ${resolved.error}`
        : `Posted. ${resolved.result?.url ?? ''}`.trim();
    },

    async reject(id, by) {
      if (!gate) return 'Approval is not enabled, so there is nothing queued.';

      const resolved = await gate.reject(id, by);
      return resolved ? 'Discarded.' : `No pending post with id ${id} — it may have expired.`;
    },
  };
}

const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((err) => {
    console.error(`[singularity] fatal: ${(err as Error).message}`);
    process.exit(1);
  });
}
