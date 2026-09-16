import { describe, it, expect } from 'vitest';
import { classifyMention } from '../src/x/spam.js';
import { allChains } from '../src/core/registry.js';
import type { Mention } from '../src/x/client.js';

/**
 * The corpus that found the bug.
 *
 * The filter was measured only against spam, so it scored well on the half of
 * the job it was tested on while silently dropping three quarters of the
 * genuine questions — the account answered nobody and logged nothing but
 * skips. Both halves live here now, because the only meaningful number is the
 * pair: letting spam through and ignoring real people are the same failure at
 * opposite ends.
 *
 * Every mention carries the agent's own @handle, exactly as X delivers it.
 * That detail is load-bearing: matching topic words against the raw text made
 * the account's own name read as substance and passed everything.
 */

const NOW = Date.parse('2026-09-15T12:00:00Z');
const ESTABLISHED = { authorCreatedAt: '2019-01-01T00:00:00Z', authorFollowers: 500 };

const verdict = (text: string) =>
  classifyMention(
    {
      id: '1',
      text,
      authorId: 'author-1',
      authorUsername: 'someone',
      conversationId: 'c1',
      ...ESTABLISHED,
    } satisfies Mention,
    { now: () => NOW },
  );

/** Questions a real person asks a project account. None may be dropped. */
const GENUINE = [
  // Chain lookups — the case the filter was built for.
  '@SingularityAgnt what chains do you support?',
  '@SingularityAgnt how much USDC is at vitalik.eth?',
  '@SingularityAgnt can you check BNB on bsc?',
  '@SingularityAgnt can it read a contract on zksync?',
  '@SingularityAgnt why did my osmosis query fail?',
  // Chains the hand-written vocabulary had never heard of.
  '@SingularityAgnt does it support avalanche?',
  '@SingularityAgnt does it work with litecoin?',
  // Questions about the project itself — the commonest genuine mention, and
  // the category that was dropped wholesale.
  '@SingularityAgnt how do I install the MCP server?',
  '@SingularityAgnt is this open source?',
  '@SingularityAgnt what is the repo?',
  '@SingularityAgnt can I use this in Claude Code?',
  '@SingularityAgnt what does the CLI look like?',
  '@SingularityAgnt any plans for sui or aptos?',
  '@SingularityAgnt how do you avoid prompt injection from token names?',
  '@SingularityAgnt what is your uptime like on public RPCs?',
  // Questions with no noun the filter could match, and still answerable.
  '@SingularityAgnt what can you do?',
  '@SingularityAgnt how does this work?',
  '@SingularityAgnt who built you?',
  '@SingularityAgnt do you hold private keys?',
  '@SingularityAgnt is it safe to use with my wallet?',
  // A correction. Being told it is wrong is worth more than a compliment.
  '@SingularityAgnt your answer above was wrong, ATOM has 6 decimals not 18',
  // A support request phrased as a statement rather than a question.
  '@SingularityAgnt I need assistance with a balance lookup',
];

/** The genres that actually fill a crypto project's mentions. */
const SPAM = [
  '@SingularityAgnt Great project! Really impressive work here. Let’s connect \u{1F680}\u{1F680}',
  '@SingularityAgnt Amazing community and strong vision. This deserves more attention!',
  '@SingularityAgnt DM me, I can help you recover your lost funds from a drained wallet',
  '@SingularityAgnt Free mint is live! Connect your wallet now, first 100 only \u{1F525}',
  '@SingularityAgnt x100 gem presale \u{1F4B0} guaranteed returns, dm for entry',
  '@SingularityAgnt follow back? \u{1F64F}',
  '@SingularityAgnt \u{1F680}\u{1F680}\u{1F680}\u{1F525}\u{1F525}',
  '@SingularityAgnt @a @b @c @d @e check out this new token launch',
  '@SingularityAgnt HUGE NEWS EVERYONE MUST SEE THIS RIGHT NOW',
  '@SingularityAgnt nice',
  '@SingularityAgnt Solid project, ethereum needs more builders like this. To the moon!',
  '@SingularityAgnt Great execution. Would love to discuss a collaboration opportunity.',
  '@SingularityAgnt Let’s make moves together, I have investment opportunity for you',
  '@SingularityAgnt Contact the expert on whatsapp for trading signals, copy my trades',
  '@SingularityAgnt your project shows promise, lets connect and talk ethereum',
  '@SingularityAgnt do you follow back?',
  '@SingularityAgnt promotion available for your project, dm for rates',
];

describe('genuine questions reach the model', () => {
  it.each(GENUINE)('answers %s', (text) => {
    const result = verdict(text);
    expect(result.skip, `wrongly skipped: ${result.reason}`).toBe(false);
  });
});

describe('spam still does not', () => {
  it.each(SPAM)('drops %s', (text) => {
    expect(verdict(text).skip).toBe(true);
  });
});

describe('the compliment-plus-question case', () => {
  // Engagement openers and real questions overlap: people are polite. The
  // phrase decides only when nothing substantive is attached to it.
  it('answers a real question wearing a farming opener', () => {
    expect(verdict('@SingularityAgnt great project — how do you handle rate limits?').skip).toBe(
      false,
    );
  });

  it('still drops the same opener with no question behind it', () => {
    expect(verdict('@SingularityAgnt great project, impressive work').skip).toBe(true);
  });

  it('does not let a bare question talk its way past a farming phrase', () => {
    // "do you follow back?" is a question about the agent, which is the weaker
    // on-topic signal and must never override the farming rule.
    expect(verdict('@SingularityAgnt do you follow back?').skip).toBe(true);
  });
});

describe('chain vocabulary follows the registry', () => {
  // The hand-maintained list named 12 of 23 chains, so the agent filtered out
  // questions about chains it supports. Deriving it means a chain added in
  // Phase 3 teaches the filter on the same commit — this test is what fails if
  // someone hand-copies the list back.
  // The carrier sentence is deliberately empty of topic words, project words
  // and self-reference, so the chain name is the only thing that can carry it.
  // The control below is what proves that.
  const carrier = (subject: string) => `@SingularityAgnt thoughts on ${subject}?`;

  it('the carrier sentence alone is not enough', () => {
    expect(verdict(carrier('gardening')).skip).toBe(true);
    expect(verdict(carrier('the weather')).skip).toBe(true);
  });

  it.each(allChains().filter((c) => !c.testnet))('recognizes $id by name', (chain) => {
    expect(verdict(carrier(chain.name)).skip).toBe(false);
  });

  it.each(allChains().filter((c) => !c.testnet))('recognizes $id by its id', (chain) => {
    expect(verdict(carrier(chain.id)).skip).toBe(false);
  });

  it.each(allChains().filter((c) => !c.testnet))(
    'recognizes $id by its native symbol',
    (chain) => {
      expect(verdict(carrier(chain.nativeCurrency.symbol)).skip).toBe(false);
    },
  );
});
