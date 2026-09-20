/**
 * Telling a chat that money arrived.
 *
 * `/pay` produces a QR and then nothing happens. Somebody scans it, approves in
 * their wallet, and the chat that asked for the payment has no idea — the
 * merchant has to remember to run `/paid <id>`, which is exactly the kind of
 * thing nobody remembers. The CLI solves this with `pay status --watch`, a
 * foreground process somebody is sitting in front of. A bot is already running,
 * so it can watch on everyone's behalf, and that is the difference between a
 * command and a system.
 *
 * The chat comes from the payment itself. `/pay` writes `sngl-pay:<chatId>`
 * into the memo, which the payer signs and the chain records — so the
 * settlement carries its own delivery address, and a restart of this process
 * loses nothing that matters. That is the same reasoning as the burn claim: a
 * memo is what binds an on-chain event to whoever it was for, rather than to
 * whoever quotes it first.
 *
 * ── What this costs ─────────────────────────────────────────────────────────
 *
 * Every open request checked is at least one `getSignaturesForAddress`, and one
 * more `getParsedTransaction` once something has landed. Against a public
 * endpoint that adds up fast, so the number checked per tick is capped and the
 * interval is deliberately unhurried. A payment that settles forty seconds
 * later than it could is not a problem; a bot that gets itself rate-limited
 * into uselessness is.
 */

import { pollLoop, type Subscription } from '../core/watch.js';
import { settleIntent } from '../pay/operations.js';
import { isExpired, type IntentStore, type StoredIntent } from '../pay/intent.js';
import type { FileIntentStore } from '../pay/file-store.js';
import { formatSettlement } from './format.js';
import type { TelegramApi } from './api.js';

/** How often the open requests are checked, when nobody says otherwise. */
const DEFAULT_INTERVAL_SECONDS = 45;

/**
 * How many open requests are checked on one tick.
 *
 * A merchant with three hundred unpaid links would otherwise make three hundred
 * RPC calls every interval, most of them about requests nobody is going to pay.
 * Newest first, because a request somebody is standing in front of right now is
 * the one worth being quick about.
 */
const MAX_PER_TICK = 10;

/** `/pay` writes this into the memo; a settlement reads its way home from it. */
const CHAT_MEMO = /^sngl-pay:(-?\d+)$/;

export function chatFromMemo(memo: string | undefined): number | undefined {
  const match = memo ? CHAT_MEMO.exec(memo.trim()) : null;
  if (!match) return undefined;

  const id = Number(match[1]);
  return Number.isFinite(id) && id !== 0 ? id : undefined;
}

export interface PaymentWatcherOptions {
  intervalSeconds?: number;
  /** Where to announce a payment whose memo names no chat. Usually the control chat. */
  fallbackChatId?: number;
}

/**
 * Watches every open payment request and announces the ones that land.
 *
 * Deliberately built on the store rather than on an in-memory list: a request
 * created before the last restart is still owed an answer, and the whole reason
 * intents are on disk is that losing one means the money arrived and the order
 * did not.
 */
export class PaymentWatcher {
  private subscription: Subscription | undefined;
  private announced = 0;

  constructor(
    private readonly api: TelegramApi,
    private readonly store: IntentStore & Pick<FileIntentStore, 'all'>,
    private readonly options: PaymentWatcherOptions = {},
  ) {}

  /** How many payments this watcher has announced since it started. */
  get announcedCount(): number {
    return this.announced;
  }

  get active(): boolean {
    return this.subscription?.active ?? false;
  }

  start(): void {
    if (this.subscription?.active) return;

    const seconds = this.options.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS;

    this.subscription = pollLoop(
      async () => {
        const settled = await this.sweep();
        // Nothing to report is not a change and not an error — most ticks find
        // nothing, and a handler firing on every one of them would be noise.
        return settled.length > 0 ? settled : undefined;
      },
      // Each announcement is its own event; the identity is which payments were
      // in it, so the same settlement never fires twice.
      (batch) => batch.map((entry) => entry.intent.id).join(','),
      async ({ value }) => {
        for (const { intent, text } of value) {
          const chatId = chatFromMemo(intent.memo) ?? this.options.fallbackChatId;
          if (chatId === undefined) continue;

          await this.api
            .sendMessage({ chatId, text })
            // A chat the bot was removed from must not stop the sweep: the
            // payment is settled either way, and the ledger already knows.
            .catch(() => undefined);

          this.announced += 1;
        }
      },
      {
        intervalMs: seconds * 1000,
        label: 'singularity payments',
        onError: (err) => {
          console.error('[payments] sweep failed:', err instanceof Error ? err.message : err);
        },
      },
    );
  }

  stop(): void {
    this.subscription?.stop();
    this.subscription = undefined;
  }

  /**
   * One pass over the open requests.
   *
   * `settleIntent` does the deciding, including marking fulfilment exactly
   * once — so two watchers, or a watcher and somebody typing `/paid`, cannot
   * both announce the same payment. Whoever loses the race gets `fulfil: false`
   * and stays quiet.
   */
  private async sweep(): Promise<Array<{ intent: StoredIntent; text: string }>> {
    const open = (await this.store.all())
      .filter((intent) => !intent.settledAt && !isExpired(intent))
      .slice(0, MAX_PER_TICK);

    const announcements: Array<{ intent: StoredIntent; text: string }> = [];

    for (const intent of open) {
      try {
        const result = await settleIntent(this.store, intent.id);
        if (!result.fulfil) continue;

        announcements.push({
          intent,
          text: `💰 <b>Payment received</b>\n\n${formatSettlement(result)}`,
        });
      } catch {
        // One unreadable request must not stop the others. The next tick tries
        // again, and an expired one drops out of the list on its own.
        continue;
      }
    }

    return announcements;
  }
}
