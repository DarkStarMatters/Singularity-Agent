/**
 * A liveness monitor.
 *
 *   npx tsx singularity-sdk/examples/liveness-monitor.ts
 *
 * Two watches, the two questions they answer, and the distinction between them
 * that is the whole reason `chain_liveness` exists:
 *
 * `watch.tip` asks *is this chain moving*. `watch.liveness` asks *is this
 * endpoint telling me the truth about that*. A chain that stopped producing
 * blocks keeps serving its last one perfectly, and every health check that only
 * asks "did this respond" keeps passing — which is how a monitor reports green
 * through an outage. Liveness reports a *dated* head, which is what makes
 * "stale" a status it can return at all.
 */

import { createSingularity } from '../src/index.js';
import type { ChainLiveness, Subscription } from '../src/index.js';

const sdk = createSingularity();

const CHAINS = process.argv.slice(2);
const TARGETS = CHAINS.length ? CHAINS : ['ethereum', 'base', 'solana'];

const watches: Subscription[] = [];
const started = Date.now();

// ── are these endpoints honest about the head? ───────────────────────────
watches.push(
  sdk.watch.liveness(
    TARGETS,
    ({ value, previous }) => {
      if (!previous) {
        // The first delivery is a reading, not a transition — `previous` is
        // absent precisely so this branch can exist.
        console.log(`\n${stamp()} baseline`);
        for (const chain of value) console.log(`  ${line(chain)}`);
        return;
      }

      for (const now of value) {
        const before = previous.find((c) => c.chain === now.chain);
        if (!before || before.status === now.status) continue;

        console.log(`\n${stamp()} ${now.chain}: ${before.status} → ${now.status}`);
        console.log(`  ${line(now)}`);
      }
    },
    {
      intervalMs: 30_000,
      // Without this, a failure would go to console.error, which is better
      // than nowhere but worse than a line you chose the wording of.
      onError: (err) => console.error(`${stamp()} liveness probe failed: ${(err as Error).message}`),
    },
  ),
);

// ── is the first chain actually moving? ──────────────────────────────────
const primary = TARGETS[0]!;

watches.push(
  sdk.watch.tip(
    primary,
    ({ value, previous }) => {
      if (!previous) {
        console.log(`${stamp()} ${primary} at height ${value.number}`);
        return;
      }

      const advanced = value.number - previous.number;

      // A height that went *backwards* is a reorg, and it is reported rather
      // than smoothed over — the watch passes through what the endpoint said.
      if (advanced < 0) {
        console.log(`${stamp()} ${primary} REORG: ${previous.number} → ${value.number}`);
        return;
      }

      console.log(`${stamp()} ${primary} +${advanced} → ${value.number}`);
    },
    {
      intervalMs: 12_000,
      onError: (err) => console.error(`${stamp()} tip read failed: ${(err as Error).message}`),
      // Ten consecutive failures is a dead endpoint, not a bad minute. Say so
      // rather than backing off forever behind a silent spinner.
      stopAfterErrors: 10,
    },
  ),
);

function line(chain: ChainLiveness): string {
  return [
    chain.chain.padEnd(12),
    chain.status.padEnd(10),
    // How many endpoints answered, out of how many are configured. `live` off
    // a single endpoint is a different proposition to `live` off four, which
    // is why `single` is its own status rather than a footnote on `live`.
    `${chain.answering}/${chain.configured}`,
    chain.height !== undefined ? `height ${chain.height}` : '',
    chain.ageSeconds !== undefined ? `(${chain.ageSeconds}s old)` : '(undatable)',
    chain.spreadSeconds ? `spread ${chain.spreadSeconds}s` : '',
  ]
    .filter(Boolean)
    .join('  ');
}

function stamp(): string {
  const seconds = Math.round((Date.now() - started) / 1000);
  return `[+${String(seconds).padStart(4)}s]`;
}

// Watches use unref'd timers, so they do not hold the process open by
// themselves — deliberate, so a script that starts one and finishes its work
// can exit. A long-running monitor keeps its own handle.
const alive = setInterval(() => {}, 1 << 30);

process.on('SIGINT', async () => {
  console.log('\nstopping…');
  for (const watch of watches) watch.stop();
  await Promise.all(watches.map((w) => w.done));
  clearInterval(alive);
  console.log('stopped.');
});

console.log(`Watching ${TARGETS.join(', ')}. Ctrl-C to stop.`);
