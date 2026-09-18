/**
 * The X listener: poll mentions and replies, answer them in thread.
 *
 * Three constraints shape this loop, and all three are about not doing damage
 * in public:
 *
 *   1. **The mentions endpoint is expensive.** On X's Basic tier it allows
 *      roughly one call every 90 seconds. So this polls on an interval rather
 *      than streaming, and a 429 is obeyed rather than retried.
 *   2. **A reply is permanent.** The same `X_POSTING_ENABLED` gate as `post()`
 *      applies, so by default the listener reads mentions, composes answers,
 *      and logs them without sending anything. That is a genuinely useful mode:
 *      it is how you find out what the agent *would* say.
 *   3. **The cursor must persist.** See `state.ts` — a restart that forgets it
 *      re-answers the backlog.
 *
 * On first run with no cursor the listener does not answer the existing
 * timeline at all. It records the newest id and starts from there, so switching
 * it on does not fire a burst of replies at week-old posts.
 */
import { GrokAgent } from '../grok/agent.js';
import { XClient, type Mention, type PostResult } from './client.js';
import { classifyMention, ReplyBudget, type SpamOptions, type SpamVerdict } from './spam.js';
import type { PostGate } from './approval.js';
import { cursorFor, loadState, saveState, type XState } from './state.js';
import { evidenceFrom, reviewReply } from './honesty.js';
import {
  collectProjectFacts,
  isDue,
  nextUpdate,
  postUpdate,
  updateBriefs,
  UPDATE_ANGLES,
  type ComposedUpdate,
  type UpdateAngle,
} from './updates.js';

export interface ListenerOptions {
  /** Seconds between polls. Below the tier's limit this just earns 429s. */
  pollSeconds?: number;
  /** Force drafting even with posting enabled. */
  dryRun?: boolean;
  /** Mentions fetched per poll. */
  maxResults?: number;
  /** Replies allowed per hour, across everyone. */
  maxRepliesPerHour?: number;
  /** Replies allowed per hour to any one account. */
  maxRepliesPerAuthorPerHour?: number;
  /** Thresholds for the spam filter. */
  spam?: SpamOptions;
  /** Hours between unprompted project updates. 0 disables them entirely. */
  updateIntervalHours?: number;
  /**
   * When set, nothing is published directly: composed posts go here for a
   * human decision first. The listener's own posting switch still applies
   * afterwards — approval is a second gate, never a bypass of the first.
   */
  gate?: PostGate;
  /** Pause answering mentions without stopping the process. */
  paused?: boolean;
  /** Test seam. */
  now?: () => number;
}

export interface HandledMention {
  mention: Mention;
  reply: PostResult;
}

export interface SkippedMention {
  mention: Mention;
  reason: string;
}

export interface PollResult {
  handled: HandledMention[];
  skipped: SkippedMention[];
}

/** X counts characters, and a reply that overruns is rejected outright. */
export const REPLY_LIMIT = 260;

export class XListener {
  private readonly pollSeconds: number;
  private readonly budget: ReplyBudget;
  private state: XState;
  private running = false;
  private userId = '';
  private username = '';

  /** Runtime pause, toggled from the control surface. */
  private paused = false;

  /** Set once at construction; see ListenerOptions.gate. */
  private readonly gate: PostGate | undefined;

  constructor(
    private readonly client: XClient,
    private readonly agent: GrokAgent,
    private readonly options: ListenerOptions = {},
  ) {
    this.gate = options.gate;
    this.paused = options.paused ?? false;
    this.pollSeconds = Math.max(options.pollSeconds ?? 90, 15);
    this.budget = new ReplyBudget(
      options.maxRepliesPerHour ?? 12,
      options.maxRepliesPerAuthorPerHour ?? 3,
    );
    this.state = loadState();
  }

  async start(): Promise<void> {
    const me = await this.client.verify();
    this.userId = me.id;
    this.username = me.username;
    this.running = true;

    console.error(`[singularity-x] listening as @${this.username} (${this.userId})`);

    if (!cursorFor(this.state, this.userId)) {
      await this.establishCursor();
    }

    await this.loop();
  }

  stop(): void {
    this.running = false;
  }

  // ---- Control surface, driven from Telegram -----------------------------

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  /**
   * A snapshot for the operator.
   *
   * Everything here answers a question someone actually asks of a bot that
   * posts on their behalf: is it running, will anything go out, what has it
   * spent, and when does it next speak unprompted.
   */
  status(): {
    account: string;
    paused: boolean;
    postingEnabled: boolean;
    approvalRequired: boolean;
    repliesThisHour: number;
    pendingApprovals: number;
    updateIntervalHours: number;
    nextUpdateInMinutes: number | null;
    lastAngle: string | null;
  } {
    const intervalHours = this.options.updateIntervalHours ?? 0;
    const now = this.options.now?.() ?? Date.now();

    const nextUpdateInMinutes =
      intervalHours <= 0
        ? null
        : this.state.lastUpdateAt
          ? Math.max(
              0,
              Math.round((this.state.lastUpdateAt + intervalHours * 3_600_000 - now) / 60_000),
            )
          : 0;

    return {
      account: this.username ? `@${this.username}` : '(not connected)',
      paused: this.paused,
      postingEnabled: !this.options.dryRun,
      approvalRequired: Boolean(this.gate),
      repliesThisHour: this.budget.spentThisHour,
      pendingApprovals: this.gate?.size ?? 0,
      updateIntervalHours: intervalHours,
      nextUpdateInMinutes,
      lastAngle: this.state.recentAngles?.[0] ?? null,
    };
  }

  /**
   * Composes an update immediately, ignoring the schedule.
   *
   * Used by `/x post` so an operator can see what the agent would say without
   * waiting hours for the timer.
   */
  async composeUpdateNow(angle?: UpdateAngle): Promise<ComposedUpdate | null> {
    const facts = collectProjectFacts();
    const recent = (this.state.recentAngles ?? []).filter((a): a is UpdateAngle =>
      (UPDATE_ANGLES as readonly string[]).includes(a),
    );

    const briefs = updateBriefs(facts);
    // An operator naming an angle wants that angle; they still get the least
    // recently used subject within it rather than whatever comes first.
    const pool = angle ? briefs.filter((brief) => brief.angle === angle) : briefs;
    const chosen = nextUpdate(pool.length ? pool : briefs, recent, this.state.recentSubjects ?? []);
    if (!chosen) return null;

    const update = await postUpdate(this.client, this.agent, facts, chosen, {
      ...(this.options.dryRun || this.gate ? { dryRun: true } : {}),
      recentPosts: this.state.recentPosts ?? [],
    });

    if (update && this.gate) await this.gate.submit({ kind: 'update', text: update.text });
    return update;
  }

  /**
   * First run: note where the timeline is now and answer nothing before it.
   * Replying to a backlog of old mentions is the single most obvious way this
   * could embarrass someone.
   */
  private async establishCursor(): Promise<void> {
    const page = await this.client.mentions(this.userId, undefined, 5);

    if (page.newestId) {
      this.state = { userId: this.userId, sinceId: page.newestId };
      saveState(this.state);
      console.error(
        `[singularity-x] starting from mention ${page.newestId}; ${page.mentions.length} earlier mention(s) left unanswered.`,
      );
    } else {
      this.state = { userId: this.userId };
      console.error('[singularity-x] no mentions yet; starting clean.');
    }
  }

  /**
   * Posts an unprompted project update if one is due.
   *
   * Run from the poll loop rather than on its own timer: one clock is easier to
   * reason about, and "due" is checked against a persisted timestamp, so a
   * restart cannot turn a six-hourly post into a post on every boot.
   */
  async maybePostUpdate(): Promise<ComposedUpdate | null> {
    const intervalHours = this.options.updateIntervalHours ?? 0;
    if (intervalHours <= 0) return null;

    const now = this.options.now?.() ?? Date.now();
    const recent = (this.state.recentAngles ?? []).filter((angle): angle is UpdateAngle =>
      (UPDATE_ANGLES as readonly string[]).includes(angle),
    );

    if (!isDue({ intervalHours, recentAngles: recent, ...(this.state.lastUpdateAt ? { lastPostedAt: this.state.lastUpdateAt } : {}) }, now)) {
      return null;
    }

    const facts = collectProjectFacts();
    const briefs = updateBriefs(facts);
    const recentPosts = this.state.recentPosts ?? [];

    let recentSubjects = this.state.recentSubjects ?? [];
    let brief = nextUpdate(briefs, recent, recentSubjects);
    let update: ComposedUpdate | null = null;

    // A brief the model declines — nothing to say, or too close to something
    // already posted — should cost the next subject, not the next four hours.
    // Otherwise tightening the repetition guard buys variety at the price of
    // silence, which is the same problem wearing different clothes.
    // A thrown attempt must still reach the state write below. It used to
    // escape to the poll loop, which logged it and moved on — leaving
    // `lastUpdateAt` unadvanced and the subject unrecorded, so the next poll
    // seconds later chose the same brief and failed the same way, forever. The
    // xAI 400s made that visible, but any transient failure pinned the account
    // to one post and retried it at poll frequency instead of hourly.
    let failure: Error | null = null;

    for (let attempt = 0; attempt < 3 && brief; attempt++) {
      try {
        update = await postUpdate(this.client, this.agent, facts, brief, {
          // With a gate in place nothing is published here: the composed text is
          // captured as a draft and handed to the reviewer below.
          ...(this.options.dryRun || this.gate ? { dryRun: true } : {}),
          now: () => now,
          recentPosts,
        });
      } catch (err) {
        // Stop attempting rather than trying the next subject: a failure here
        // is the model or the API being unavailable, not this brief being
        // unwritable, and three more calls will fail the same way.
        failure = err as Error;
        break;
      }

      if (update) break;

      // Burn the subject so the next attempt — and the next poll — move on.
      console.error(`[singularity-x] nothing to say about ${brief.subject}; trying another.`);
      recentSubjects = [brief.subject, ...recentSubjects.filter((s) => s !== brief!.subject)];
      brief = nextUpdate(briefs, recent, recentSubjects);
    }

    if (!brief) {
      console.error('[singularity-x] no update material available; skipped.');
      return null;
    }
    const angle = brief.angle;

    if (update && this.gate) {
      await this.gate.submit({ kind: 'update', text: update.text });
      console.error(`[singularity-x] awaiting approval: ${angle} update`);
    }

    // The clock advances even when the model declined to write anything, or a
    // dry run would compose a fresh post on every single poll.
    this.state = {
      ...this.state,
      lastUpdateAt: now,
      recentAngles: [angle, ...recent.filter((a) => a !== angle)].slice(0, UPDATE_ANGLES.length - 1),
      // The subject is recorded even when the model wrote nothing, so a brief
      // it could not make a post out of is not retried on every poll. Kept far
      // longer than the angle list: the whole point is that a chain or a limit
      // does not come round again until everything else has had a turn.
      recentSubjects: [brief.subject, ...recentSubjects.filter((s) => s !== brief.subject)].slice(
        0,
        200,
      ),
      // Kept whether or not it was published: a draft the model has already
      // written is still something it should not write again.
      ...(update ? { recentPosts: [update.text, ...recentPosts].slice(0, 12) } : {}),
    };
    saveState(this.state);

    if (failure) {
      // The subject is burned along with the clock. A brief that could not be
      // posted is not one to retry immediately, and if the failure is really
      // the API being down then every subject fails equally — better to move
      // through them slowly than to hammer one.
      console.error(
        `[singularity-x] update failed on ${brief.subject}, backing off to the next slot: ${failure.message}`,
      );
      return null;
    }

    if (update) {
      console.error(
        update.result.published
          ? `[singularity-x] posted a ${angle} update -> ${update.result.url}`
          : `[singularity-x] DRAFT ${angle} update: ${update.text}`,
      );
    } else {
      console.error(
        `[singularity-x] nothing new to say about ${brief.subject} — either the facts did not support it or it repeated an earlier post; skipped.`,
      );
    }

    return update;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      let waitSeconds = this.pollSeconds;

      try {
        await this.pollOnce();
        await this.maybePostUpdate().catch((err) => {
          // A failed update must not stop the listener answering mentions.
          console.error(`[singularity-x] update failed: ${(err as Error).message}`);
          return null;
        });
      } catch (err) {
        const message = (err as Error).message;
        // A 429 here means the tier's window is exhausted; backing off by a
        // full window is the only thing that helps.
        waitSeconds = /429/.test(message) ? Math.max(this.pollSeconds, 15 * 60) : this.pollSeconds;
        console.error(`[singularity-x] poll failed: ${message} — next attempt in ${waitSeconds}s`);
      }

      await sleep(waitSeconds * 1_000, () => this.running);
    }
  }

  /** One poll. Exposed so a caller can drive a single pass in a test or a cron. */
  async pollOnce(): Promise<PollResult> {
    if (this.options.paused || this.paused) return { handled: [], skipped: [] };

    const since = cursorFor(this.state, this.userId);
    const page = await this.client.mentions(this.userId, since, this.options.maxResults ?? 20);

    // X returns newest-first; answering in chronological order means a thread
    // reads correctly and the memory sees the turns in the order they happened.
    const pending = page.mentions
      .filter((mention) => mention.authorId !== this.userId)
      .reverse();

    const handled: HandledMention[] = [];
    const skipped: SkippedMention[] = [];

    for (const mention of pending) {
      const verdict = this.screen(mention);
      if (verdict.skip) {
        skipped.push({ mention, reason: verdict.reason ?? 'filtered' });
        continue;
      }

      try {
        handled.push({ mention, reply: await this.answer(mention) });
      } catch (err) {
        // One bad mention must not stop the rest, or a single malformed post
        // wedges the listener permanently.
        console.error(`[singularity-x] failed on mention ${mention.id}: ${(err as Error).message}`);
      }
    }

    if (skipped.length) {
      console.error(`[singularity-x] skipped ${skipped.length} mention(s):`);
      for (const { mention, reason } of skipped) {
        const who = mention.authorUsername ? `@${mention.authorUsername}` : mention.authorId;
        console.error(`  ${mention.id} from ${who} — ${reason}`);
      }
    }

    // Advanced only after the batch, and to X's own newest id rather than the
    // last one handled: a mention that threw is not worth retrying forever.
    if (page.newestId) {
      this.state = { userId: this.userId, sinceId: page.newestId };
      saveState(this.state);
    }

    return { handled, skipped };
  }

  /**
   * Everything that must be decided before a model is involved.
   *
   * Order matters: content is judged first so the log explains *why* a mention
   * was junk, and only something that survives that consumes budget. Charging
   * spam against the hourly cap would let a flood of it lock out the real
   * questions arriving in the same window.
   */
  private screen(mention: Mention): SpamVerdict {
    // A follow-up is a thread this agent has actually spoken in — not merely a
    // reply, which every engagement bot's post also is.
    const isFollowUp = this.agent.hasHistory(`x:${mention.conversationId ?? mention.id}`);

    const verdict = classifyMention(mention, {
      ...this.options.spam,
      ...(isFollowUp ? { isFollowUp: true } : {}),
    });
    if (verdict.skip) return verdict;

    return this.budget.take(mention.authorId, this.options.now?.() ?? Date.now());
  }

  private async answer(mention: Mention): Promise<PostResult> {
    const text = stripHandles(mention.text, this.username);

    // The whole thread is one conversation, so the agent keeps context across
    // a back-and-forth rather than treating each reply as a cold start.
    const conversationId = mention.conversationId ?? mention.id;
    const reply = await this.agent.respond(
      `x:${conversationId}`,
      text || 'Someone mentioned you with no other text. Introduce yourself in one line.',
      mention.authorUsername ?? mention.authorId,
    );

    // The last check before this becomes permanent and public: a reply may not
    // assert that something is absent when the scan behind it only looked at a
    // subset. The model is told the caveat and usually honours it; this is what
    // makes "usually" into "always".
    const review = reviewReply(fitReply(reply.text), evidenceFrom(reply.toolRuns), REPLY_LIMIT);
    const who = mention.authorUsername ? `@${mention.authorUsername}` : mention.authorId;

    if (!review.publish) {
      console.error(`[singularity-x] withheld a reply to ${who} (${mention.id}): ${review.reason}`);
      return {
        published: false,
        text: fitReply(reply.text),
        reason: `Withheld: ${review.reason}`,
        inReplyTo: mention.id,
      };
    }

    const body = review.text;
    if (review.caveated) {
      console.error(
        `[singularity-x] added a completeness caveat to the reply to ${who} (${mention.id}).`,
      );
    }

    if (this.gate) {
      await this.gate.submit({
        kind: 'reply',
        text: body,
        inReplyTo: mention.id,
        context: mention.text,
        ...(mention.authorUsername ? { author: mention.authorUsername } : {}),
      });

      console.error(`[singularity-x] awaiting approval: reply to ${who} (${mention.id})`);
      return { published: false, text: body, reason: 'Waiting for approval.', inReplyTo: mention.id };
    }

    const result = await this.client.reply(body, mention.id, {
      ...(this.options.dryRun ? { dryRun: true } : {}),
    });

    console.error(
      result.published
        ? `[singularity-x] replied to ${who} (${mention.id}) -> ${result.url}`
        : `[singularity-x] DRAFT for ${who} (${mention.id}): ${result.text}`,
    );

    return result;
  }
}

/**
 * Removes the @handles X prepends to a reply, so the model sees the question
 * rather than the addressing. Only leading handles go: a handle inside the
 * sentence is part of what was said.
 */
export function stripHandles(text: string, selfUsername: string): string {
  const withoutLeading = text.replace(/^(?:@[A-Za-z0-9_]{1,15}\s+)+/, '');
  return withoutLeading
    .replace(new RegExp(`@${selfUsername}\\b`, 'gi'), '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Last line of defence on length. The model is told the limit, but a reply that
 * overruns is rejected by X outright, and a truncated answer beats no answer.
 * Cut on a sentence boundary where there is one close enough to the end.
 */
export function fitReply(text: string, limit = REPLY_LIMIT): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= limit) return clean;

  const cut = clean.slice(0, limit - 1);
  const sentenceEnd = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));

  if (sentenceEnd > limit * 0.6) return cut.slice(0, sentenceEnd + 1);

  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** Sleeps in slices so a stop() during a 15-minute backoff is not ignored. */
async function sleep(ms: number, stillRunning: () => boolean): Promise<void> {
  const slice = 1_000;
  for (let waited = 0; waited < ms; waited += slice) {
    if (!stillRunning()) return;
    await new Promise((resolve) => setTimeout(resolve, Math.min(slice, ms - waited)));
  }
}
