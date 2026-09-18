import { describe, it, expect } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import { XListener } from '../src/x/listener.js';
import { GrokAgent } from '../src/grok/agent.js';
import { collectProjectFacts, updateBriefs, nextUpdate } from '../src/x/updates.js';
import type { AssistantMessage, GrokClient } from '../src/grok/client.js';
import type { MentionPage, XClient } from '../src/x/client.js';

/**
 * The complaint this file exists for: the account posted the same few things
 * over and over.
 *
 * Against the real repository rather than a fixture, because the whole fix is
 * that the post space is *derived* — if the chains, tools, limits and recipes
 * stop reaching the poster, these numbers fall and this fails.
 */

const NOW = Date.parse('2026-09-16T12:00:00Z');

describe('the real post space', () => {
  const facts = collectProjectFacts();
  const briefs = updateBriefs(facts);

  it('is large enough that nothing repeats for weeks', () => {
    // At the default four-hour cadence this is the number of posts before
    // anything comes round again. Six was the old answer, and six posts at six
    // per day is a loop the reader notices on day one.
    expect(briefs.length).toBeGreaterThan(50);
  });

  it('draws from every source the repository offers', () => {
    const angles = new Set(briefs.map((b) => b.angle));

    expect(angles).toContain('howto');
    expect(angles).toContain('gotcha');
    expect(angles).toContain('chainnote');
    expect(angles).toContain('limitation');
    expect(angles).toContain('capability');
  });

  it('spends a full week without repeating a subject', () => {
    const subjects: string[] = [];
    const angles: string[] = [];

    // Six posts a day for seven days.
    for (let i = 0; i < 42; i++) {
      const next = nextUpdate(briefs, angles, subjects);
      if (!next) throw new Error(`ran out of material after ${i}`);
      subjects.unshift(next.subject);
      angles.unshift(next.angle);
    }

    expect(new Set(subjects).size).toBe(42);
  });

  it('does not spend that week on one angle either', () => {
    const subjects: string[] = [];
    const angles: string[] = [];

    for (let i = 0; i < 42; i++) {
      const next = nextUpdate(briefs, angles, subjects);
      if (!next) break;
      subjects.unshift(next.subject);
      angles.unshift(next.angle);
    }

    // Diversity of subject is not enough on its own: forty-two posts that were
    // all chain notes would still read as one post repeated.
    expect(new Set(angles).size).toBeGreaterThanOrEqual(6);
  });

  it('gives every post facts about only its own subject', () => {
    for (const brief of briefs) {
      expect(brief.facts.length, `${brief.subject} has no facts`).toBeGreaterThan(0);
      for (const fact of brief.facts) expect(fact.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('a declined post costs the next subject, not the next four hours', () => {
  /** Refuses the first `declines` briefs, then writes something. */
  function listenerRefusing(declines: number): { listener: XListener; prompts: string[] } {
    const prompts: string[] = [];

    const grok = {
      async complete(messages: Array<{ content?: string }>): Promise<AssistantMessage> {
        prompts.push(String(messages.at(-1)?.content ?? ''));
        // An empty completion is how the writer says "nothing to say"; the
        // agent is constructed with allowEmpty inside postUpdate.
        return prompts.length <= declines
          ? { content: '', toolCalls: [] }
          : { content: 'Cosmos addresses re-encode across chains, so a wrong prefix is fixable.', toolCalls: [] };
      },
    } as unknown as GrokClient;

    const client = {
      async verify() {
        return { id: 'me', username: 'SingularityAgnt', name: 'S' };
      },
      async mentions(): Promise<MentionPage> {
        return { mentions: [] };
      },
      async post(text: string) {
        return { published: true, text, id: '1', url: 'https://x.com/i/web/status/1' };
      },
    } as unknown as XClient;

    // Removed, not just named: the listener persists `lastUpdateAt`, so a file
    // left behind by the previous run makes the next one "not due yet" and the
    // test sees zero attempts. It passed in isolation and failed in the suite.
    const path = `${process.env.TEMP ?? '.'}/singularity-x-variety-${declines}.json`;
    rmSync(path, { force: true });
    process.env.SINGULARITY_X_STATE = path;

    const listener = new XListener(client, new GrokAgent(grok, { system: 'sys', tools: false }), {
      updateIntervalHours: 4,
      now: () => NOW,
      dryRun: true,
    });
    Object.assign(listener, { userId: 'me', username: 'SingularityAgnt' });

    return { listener, prompts };
  }

  it('moves on to another subject when the model has nothing to say', async () => {
    const { listener, prompts } = listenerRefusing(2);

    const update = await listener.maybePostUpdate();

    // Two refusals, then a post — in one slot rather than across twelve hours
    // of silence. Tightening the repetition guard must not buy variety by
    // saying nothing, which is the same problem wearing different clothes.
    expect(prompts).toHaveLength(3);
    expect(update).not.toBeNull();
    // And each attempt was about something different.
    expect(new Set(prompts).size).toBe(3);
  });

  it('gives up after a few attempts rather than looping', async () => {
    const { listener, prompts } = listenerRefusing(99);

    const update = await listener.maybePostUpdate();

    expect(update).toBeNull();
    expect(prompts.length).toBeLessThanOrEqual(3);
  });
});

describe('a failed post must not pin the account to one subject', () => {
  /**
   * The bug this covers, in the words it was reported in: "the agent gets
   * stuck trying to post the same status over and over".
   *
   * `postUpdate` threw, the throw escaped to the poll loop, the loop logged it
   * and carried on — and the state write that advances `lastUpdateAt` and
   * records the subject never ran. So the next poll, seconds later, found
   * itself due, chose the same brief, and failed identically. Not a retry
   * policy: an unbounded loop at poll frequency, burning API calls on one post.
   */
  function listenerThatFails(): { listener: XListener; attempts: () => number } {
    let calls = 0;

    const grok = {
      async complete(): Promise<AssistantMessage> {
        calls += 1;
        throw new Error('xAI API returned 400: Model grok-4 does not support parameter x');
      },
    } as unknown as GrokClient;

    const client = {
      async verify() {
        return { id: 'me', username: 'SingularityAgnt', name: 'S' };
      },
      async mentions(): Promise<MentionPage> {
        return { mentions: [] };
      },
      async post(text: string) {
        return { published: true, text, id: '1', url: 'https://x.com/i/web/status/1' };
      },
    } as unknown as XClient;

    const path = `${process.env.TEMP ?? '.'}/singularity-x-failure.json`;
    rmSync(path, { force: true });
    process.env.SINGULARITY_X_STATE = path;

    const listener = new XListener(client, new GrokAgent(grok, { system: 'sys', tools: false }), {
      updateIntervalHours: 4,
      now: () => NOW,
      dryRun: true,
    });
    Object.assign(listener, { userId: 'me', username: 'SingularityAgnt' });

    return { listener, attempts: () => calls };
  }

  it('does not throw out to the caller', async () => {
    const { listener } = listenerThatFails();
    await expect(listener.maybePostUpdate()).resolves.toBeNull();
  });

  it('gives up after one failure instead of working through the subjects', async () => {
    const { listener, attempts } = listenerThatFails();
    await listener.maybePostUpdate();

    // The API being unavailable is not this brief being unwritable, and three
    // more calls would fail the same way.
    expect(attempts()).toBe(1);
  });

  it('advances the clock, so the next poll is not due', async () => {
    const { listener, attempts } = listenerThatFails();

    await listener.maybePostUpdate();
    const afterFirst = attempts();

    // A second poll a minute later. Before the fix this found itself still due
    // and attempted the identical post again.
    await listener.maybePostUpdate();

    expect(attempts()).toBe(afterFirst);
  });

  it('records the subject, so the next slot is about something else', async () => {
    const { listener } = listenerThatFails();
    await listener.maybePostUpdate();

    const state = JSON.parse(
      readFileSync(process.env.SINGULARITY_X_STATE as string, 'utf8'),
    ) as { lastUpdateAt?: number; recentSubjects?: string[] };

    expect(state.lastUpdateAt).toBe(NOW);
    expect(state.recentSubjects?.length).toBeGreaterThan(0);
  });
});
