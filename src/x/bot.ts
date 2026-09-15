/**
 * Entry point for the X listener: `npm run x-bot`.
 *
 * Deliberately separate from the Telegram bot's process. The two have very
 * different failure profiles — Telegram long-polls freely, X allows a handful
 * of calls per fifteen minutes — and a rate-limit backoff on one should not
 * stall the other.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from '../telegram/config.js';
import { createAgent } from '../grok/agent.js';
import { GrokClient, loadGrokConfig } from '../grok/client.js';
import { XClient, loadXConfig } from './client.js';
import { XListener } from './listener.js';

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export async function main(): Promise<void> {
  loadEnvFile();

  const xConfig = loadXConfig();
  if (!xConfig) {
    console.error(
      '\nX credentials are not set.\n\nThe listener needs X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN and X_ACCESS_SECRET in .env — all four, from an app with Read and Write permission.\n',
    );
    process.exit(1);
  }

  const grokConfig = loadGrokConfig();
  if (!grokConfig) {
    console.error(
      '\nXAI_API_KEY is not set.\n\nThe listener answers mentions with Grok, so there is nothing for it to do without a key. Get one from console.x.ai.\n',
    );
    process.exit(1);
  }

  const dryRun = process.env.X_DRY_RUN?.trim().toLowerCase() === 'true';

  const maxPerHour = positiveInt(process.env.X_MAX_REPLIES_PER_HOUR, 12);
  const maxPerAuthor = positiveInt(process.env.X_MAX_REPLIES_PER_AUTHOR_PER_HOUR, 3);

  const listener = new XListener(
    new XClient(xConfig),
    createAgent(new GrokClient(grokConfig), 'x'),
    {
      pollSeconds: positiveInt(process.env.X_POLL_SECONDS, 90),
      maxRepliesPerHour: maxPerHour,
      maxRepliesPerAuthorPerHour: maxPerAuthor,
      spam: {
        minAccountAgeDays: positiveInt(process.env.X_MIN_ACCOUNT_AGE_DAYS, 7),
        minFollowers: positiveInt(process.env.X_MIN_FOLLOWERS, 10),
      },
      ...(dryRun ? { dryRun: true } : {}),
    },
  );

  // Stated plainly at startup, because "why is it not replying" and "why did it
  // reply" are both answered by these two lines.
  console.error(
    xConfig.postingEnabled && !dryRun
      ? '[singularity-x] posting is LIVE — replies will be published publicly.'
      : '[singularity-x] draft mode — replies are composed and logged, never sent.',
  );
  console.error(
    `[singularity-x] spending cap: ${maxPerHour} replies/hour, ${maxPerAuthor} per account. Spam is filtered before the model is called.`,
  );

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      console.error('\n[singularity-x] shutting down');
      listener.stop();
      process.exit(0);
    });
  }

  await listener.start();
}

// Only auto-start when executed directly, so tests can import freely.
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
    console.error(`[singularity-x] fatal: ${(err as Error).message}`);
    process.exit(1);
  });
}
