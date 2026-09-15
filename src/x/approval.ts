/**
 * Holding posts until a human approves them.
 *
 * Everything the agent would say on X — an answer to a mention, a scheduled
 * project update — goes through here first. Nothing reaches the API until
 * someone decides, which turns the `X_POSTING_ENABLED` switch from "publish
 * everything" into "publish what I approved".
 *
 * The gate is deliberately ignorant of Telegram. It knows how to queue a
 * request, notify *something*, and publish on approval; the reviewer transport
 * is injected. That keeps the publishing rules in one place and testable
 * without a chat client, and leaves room for another front end later.
 *
 * Two properties matter more than the rest:
 *
 *   - **Approval publishes at approval time**, not at compose time. The text is
 *     held, not a queued API call, so nothing can fire by accident.
 *   - **Pending requests expire.** A queue that grows forever would have the
 *     agent answering a mention from yesterday, which is worse than not
 *     answering at all.
 */
import type { PostResult, XClient } from './client.js';

export type PendingKind = 'update' | 'reply';

export interface PendingPost {
  id: string;
  kind: PendingKind;
  /** Exactly what would be published. */
  text: string;
  /** For a reply: the post being answered, for the reviewer's context. */
  context?: string;
  /** For a reply: the id to thread under. */
  inReplyTo?: string;
  /** Who is being answered, for display. */
  author?: string;
  createdAt: number;
}

export interface ResolvedPost {
  pending: PendingPost;
  approved: boolean;
  /** Present when approved and the publish succeeded. */
  result?: PostResult;
  /** Present when publishing failed. */
  error?: string;
  /** Who decided, when the transport knows. */
  by?: string;
}

/** How the reviewer is reached, and told the outcome. */
export interface ApprovalTransport {
  /** Show a pending post and offer a decision. */
  request(pending: PendingPost): Promise<void>;
  /** Report what happened after a decision. */
  resolved(resolution: ResolvedPost): Promise<void>;
}

export interface GateOptions {
  /** Pending posts older than this are dropped. Default 6h. */
  expireAfterMs?: number;
  /** Cap on the queue, oldest dropped first. */
  maxPending?: number;
  now?: () => number;
}

export class PostGate {
  private readonly queue = new Map<string, PendingPost>();
  private readonly expireAfterMs: number;
  private readonly maxPending: number;
  private readonly now: () => number;
  private counter = 0;

  constructor(
    private readonly client: XClient,
    private readonly transport: ApprovalTransport,
    options: GateOptions = {},
  ) {
    this.expireAfterMs = options.expireAfterMs ?? 6 * 3_600_000;
    this.maxPending = options.maxPending ?? 25;
    this.now = options.now ?? Date.now;
  }

  /**
   * Queues a post and asks for a decision. Returns the pending record rather
   * than a result, because there is no result yet — and callers must not treat
   * "submitted" as "posted".
   */
  async submit(
    request: Omit<PendingPost, 'id' | 'createdAt'>,
  ): Promise<PendingPost> {
    this.prune();

    // Short ids: they travel in Telegram callback_data, which is capped at 64
    // bytes, and a person may have to type one.
    const id = `p${(++this.counter).toString(36)}${this.now().toString(36).slice(-4)}`;
    const pending: PendingPost = { ...request, id, createdAt: this.now() };

    this.queue.set(id, pending);
    await this.transport.request(pending);

    return pending;
  }

  /** Publishes an approved post. The only path from this module to the API. */
  async approve(id: string, by?: string): Promise<ResolvedPost | null> {
    const pending = this.take(id);
    if (!pending) return null;

    let resolution: ResolvedPost;
    try {
      const result =
        pending.kind === 'reply' && pending.inReplyTo
          ? await this.client.reply(pending.text, pending.inReplyTo)
          : await this.client.post(pending.text);

      resolution = { pending, approved: true, result, ...(by ? { by } : {}) };
    } catch (err) {
      resolution = {
        pending,
        approved: true,
        error: err instanceof Error ? err.message : String(err),
        ...(by ? { by } : {}),
      };
    }

    await this.transport.resolved(resolution);
    return resolution;
  }

  async reject(id: string, by?: string): Promise<ResolvedPost | null> {
    const pending = this.take(id);
    if (!pending) return null;

    const resolution: ResolvedPost = { pending, approved: false, ...(by ? { by } : {}) };
    await this.transport.resolved(resolution);

    return resolution;
  }

  /**
   * Re-issues a card for everything still waiting, and returns how many.
   *
   * An approval card is a message in a chat, and messages scroll away. Without
   * this the only way to act on a draft from an hour ago is to find the
   * original card, which in a busy group is the same as losing it.
   */
  async resend(): Promise<number> {
    const waiting = this.pending();
    for (const pending of waiting) await this.transport.request(pending);

    return waiting.length;
  }

  get(id: string): PendingPost | undefined {
    this.prune();
    return this.queue.get(id);
  }

  pending(): PendingPost[] {
    this.prune();
    return [...this.queue.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  get size(): number {
    this.prune();
    return this.queue.size;
  }

  private take(id: string): PendingPost | undefined {
    this.prune();
    const pending = this.queue.get(id);
    if (pending) this.queue.delete(id);

    return pending;
  }

  /**
   * Drops expired entries, then the oldest if the queue is still over cap.
   * Silent by design: an expired draft is not an event worth a notification
   * hours after the fact.
   */
  private prune(): void {
    const cutoff = this.now() - this.expireAfterMs;

    for (const [id, pending] of this.queue) {
      if (pending.createdAt < cutoff) this.queue.delete(id);
    }
    while (this.queue.size > this.maxPending) {
      const oldest = this.queue.keys().next();
      if (oldest.done) break;
      this.queue.delete(oldest.value);
    }
  }
}
