/**
 * The last mesh run each chat made, so `/nft` has something to draw.
 *
 * `/nft #1 "series"` says nothing about a subject or an objective, and that is
 * the right shape for the command: you have just looked at a run, and the
 * thing you want a picture of is *that*. So the run has to be waiting
 * somewhere when the next message arrives.
 *
 * In memory, deliberately, and bounded. The alternative was a file store like
 * the one payments use, and it is not worth it: a mesh result is worth having
 * for as long as the conversation it happened in is still going, and a run
 * that outlived a bot restart would be a picture of state the chat can no
 * longer see. The bound exists because a group with a thousand chats would
 * otherwise hold a thousand results forever — oldest out first, which is the
 * right eviction for something whose value is that it is recent.
 *
 * What this costs is one honest failure mode: restart the bot between `/mesh`
 * and `/nft` and the run is gone. `/nft` says so in those words rather than
 * drawing something else.
 */

import type { MeshResult } from '../mesh/search.js';

/** How many chats' runs are held at once. */
export const DEFAULT_LIMIT = 64;

export interface RememberedRun {
  result: MeshResult;
  /** When it was remembered, ISO 8601. Shown so a stale run is visibly stale. */
  at: string;
}

export class MeshMemory {
  private readonly runs = new Map<number, RememberedRun>();

  constructor(private readonly limit: number = DEFAULT_LIMIT) {}

  /**
   * Keep this chat's newest run.
   *
   * A plan is not remembered. It called nothing, so there is no state to draw,
   * and holding one would mean `/nft` either refusing on something the chat
   * just ran or — far worse — silently drawing the run before it.
   */
  remember(chatId: number, result: MeshResult): void {
    if (result.verdict === 'planned') return;

    // Delete before set, so re-remembering moves the chat to the end of the
    // insertion order and eviction stays least-recently-used rather than
    // first-ever-seen.
    this.runs.delete(chatId);
    this.runs.set(chatId, { result, at: new Date().toISOString() });

    while (this.runs.size > this.limit) {
      const oldest = this.runs.keys().next();
      if (oldest.done) break;
      this.runs.delete(oldest.value);
    }
  }

  recall(chatId: number): RememberedRun | undefined {
    return this.runs.get(chatId);
  }

  forget(chatId: number): void {
    this.runs.delete(chatId);
  }

  get size(): number {
    return this.runs.size;
  }
}

/**
 * The process-wide memory the commands use.
 *
 * A module singleton because `/mesh` and `/nft` are two separate invocations
 * of two separate handlers and the bot has nowhere else to hang per-process
 * state. `MeshMemory` is a class so the tests never have to reach for this
 * one, and so a second bot in one process would not share a chat id space it
 * does not own.
 */
export const meshMemory = new MeshMemory();
