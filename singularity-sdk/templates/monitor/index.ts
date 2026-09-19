/**
 * A chain monitor.
 *
 * Watches liveness across several chains and a balance on one, prints changes,
 * and shuts down cleanly on Ctrl-C.
 *
 * Two things here are load-bearing and easy to leave out:
 *
 * **The first delivery is not a change.** `change.previous` is absent on the
 * first tick, because there was nothing to compare against. An alert that does
 * not check it fires for every address it watches the moment the process
 * starts, and people turn the alerts off.
 *
 * **Liveness is not the same as answering.** A chain that stopped producing
 * blocks keeps serving its last one, and every naive health check keeps
 * passing. `watch.liveness` reports a dated head, which is what makes "stale"
 * a status it can return at all.
 */

import { createSingularity, type ChainLiveness, type Subscription } from 'singularity-sdk';

const sdk = createSingularity({ chain: 'ethereum' });

const CHAINS = ['ethereum', 'base', 'solana'];
const WATCHED_ADDRESS = process.argv[2] ?? 'vitalik.eth';

const subscriptions: Subscription[] = [];

// ── chain health ─────────────────────────────────────────────────────────
subscriptions.push(
  sdk.watch.liveness(
    CHAINS,
    ({ value, previous, tick }) => {
      if (!previous) {
        console.log(`\n[start] ${value.map(summarize).join('  ')}`);
        return;
      }

      // Only the chains that actually moved. Reprinting all of them on every
      // change makes a log nobody reads.
      for (const now of value) {
        const before = previous.find((c) => c.chain === now.chain);
        if (before && before.status !== now.status) {
          console.log(`[${tick}] ${now.chain}: ${before.status} → ${now.status}`);
          for (const note of now.notes) console.log(`      ${note}`);
        }
      }
    },
    {
      intervalMs: 30_000,
      onError: (err) => console.error('[liveness]', (err as Error).message),
    },
  ),
);

// ── one balance ──────────────────────────────────────────────────────────
subscriptions.push(
  sdk.watch.balance(
    { address: WATCHED_ADDRESS, includeTokens: false },
    ({ value, previous }) => {
      const now = value.native.amount.formatted;
      const symbol = value.native.token?.symbol ?? '';

      if (!previous) {
        console.log(`[start] ${WATCHED_ADDRESS}: ${now} ${symbol}`);
        return;
      }

      console.log(`[move]  ${WATCHED_ADDRESS}: ${previous.native.amount.formatted} → ${now} ${symbol}`);
    },
    {
      intervalMs: 15_000,
      // Surface a dead endpoint rather than retrying behind a spinner forever.
      stopAfterErrors: 10,
      onError: (err) => console.error('[balance]', (err as Error).message),
    },
  ),
);

function summarize(chain: ChainLiveness): string {
  return `${chain.chain}=${chain.status}`;
}

// ── shutdown ─────────────────────────────────────────────────────────────
// Watches hold unref'd timers, so the process would exit on its own once
// nothing else keeps it alive. This keeps it up and stops cleanly instead, so
// an in-flight tick is not killed mid-request.
const forever = setInterval(() => {}, 1 << 30);

process.on('SIGINT', () => {
  console.log('\nstopping…');
  for (const subscription of subscriptions) subscription.stop();
  clearInterval(forever);
});

console.log(`Watching ${CHAINS.join(', ')} and ${WATCHED_ADDRESS}. Ctrl-C to stop.`);
