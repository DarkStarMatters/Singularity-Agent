import { describe, it, expect } from 'vitest';
import { classifyMention, ReplyBudget } from '../src/x/spam.js';
import { XListener } from '../src/x/listener.js';
import { GrokAgent } from '../src/grok/agent.js';
import type { Mention, MentionPage, XClient } from '../src/x/client.js';
import type { AssistantMessage, ChatMessage, GrokClient } from '../src/grok/client.js';

const NOW = Date.parse('2026-09-15T12:00:00Z');
const OLD_ACCOUNT = { authorCreatedAt: '2019-01-01T00:00:00Z', authorFollowers: 500 };

function mention(text: string, overrides: Partial<Mention> = {}): Mention {
  return {
    id: '100',
    text,
    authorId: 'author-1',
    authorUsername: 'someone',
    conversationId: '100',
    ...OLD_ACCOUNT,
    ...overrides,
  };
}

const verdict = (text: string, overrides: Partial<Mention> = {}) =>
  classifyMention(mention(text, overrides), { now: () => NOW });

describe('spam classification', () => {
  it('answers a genuine chain question', () => {
    expect(verdict('@SingularityAgnt what is gas on base right now?').skip).toBe(false);
  });

  it('answers an on-topic statement even without a question mark', () => {
    expect(verdict('@SingularityAgnt check the balance of vitalik.eth').skip).toBe(false);
  });

  it.each([
    'dm me for recovery',
    'I can recover your lost funds',
    'send me your seed phrase',
    'join the giveaway now',
    'guaranteed profit every day',
    'this 100x gem is about to pump',
    'connect your wallet to claim',
  ])('drops the scam: %s', (text) => {
    const result = verdict(`@SingularityAgnt ${text}`);
    expect(result.skip).toBe(true);
    expect(result.reason).toMatch(/scam phrase/);
  });

  it('drops a mention that is only handles', () => {
    const result = verdict('@SingularityAgnt');
    expect(result.skip).toBe(true);
    expect(result.reason).toMatch(/no message/);
  });

  it('drops a mass tag', () => {
    const result = verdict('@SingularityAgnt @a @b @c @d check this');
    expect(result.skip).toBe(true);
    expect(result.reason).toMatch(/broadcast/);
  });

  it('drops hashtag stuffing', () => {
    const result = verdict('@SingularityAgnt gm #crypto #eth #base #defi');
    expect(result.skip).toBe(true);
    expect(result.reason).toMatch(/hashtags/);
  });

  it('drops a bare link, which reduces to no message at all', () => {
    const result = verdict('@SingularityAgnt https://example.com/mint');
    expect(result.skip).toBe(true);
    expect(result.reason).toMatch(/no message/);
  });

  it('drops a link dressed up with a few words', () => {
    const result = verdict('@SingularityAgnt check this out https://example.com/mint');
    expect(result.skip).toBe(true);
    expect(result.reason).toMatch(/link/);
  });

  it('allows a link attached to a real question', () => {
    expect(
      verdict(
        '@SingularityAgnt is the gas on this base transaction normal? https://basescan.org/tx/0x1',
      ).skip,
    ).toBe(false);
  });

  it('drops emoji spam', () => {
    const result = verdict('@SingularityAgnt 🚀🚀🚀🔥🔥');
    expect(result.skip).toBe(true);
    expect(result.reason).toMatch(/emoji/);
  });

  it('drops all-caps shouting', () => {
    const result = verdict('@SingularityAgnt BUY THIS TOKEN RIGHT NOW FRIENDS');
    expect(result.skip).toBe(true);
  });

  it('drops a throwaway account', () => {
    const result = verdict('@SingularityAgnt what is gas on base?', {
      authorCreatedAt: '2026-09-14T00:00:00Z',
      authorFollowers: 0,
    });

    expect(result.skip).toBe(true);
    expect(result.reason).toMatch(/followers/);
  });

  it('does not penalize a new account that has an audience', () => {
    expect(
      verdict('@SingularityAgnt what is gas on base?', {
        authorCreatedAt: '2026-09-14T00:00:00Z',
        authorFollowers: 4_000,
      }).skip,
    ).toBe(false);
  });

  it('treats missing author metrics as no evidence, not as guilt', () => {
    const bare: Mention = {
      id: '1',
      text: '@SingularityAgnt what is gas on base?',
      authorId: 'a',
    };
    expect(classifyMention(bare, { now: () => NOW }).skip).toBe(false);
  });

  it('stays quiet on chatter it has nothing to say about', () => {
    const result = verdict('@SingularityAgnt gm frens');
    expect(result.skip).toBe(true);
    expect(result.reason).toMatch(/nothing this agent can look up/);
  });

  it('does not accept a question mark as a reason to reply', () => {
    // Measured against the real timeline: most spam asks something, and none
    // of it asks anything answerable.
    const result = verdict('@SingularityAgnt can I get a shoutout?');
    expect(result.skip).toBe(true);
  });

  it.each([
    "@SingularityAgnt Excellent project and great execution. Let's connect",
    '@SingularityAgnt Solid project with a compelling vision',
    '@SingularityAgnt can I get a follow back?',
    '@SingularityAgnt This project deserves more attention',
    '@SingularityAgnt Impressive work here! Lets talk',
    '@SingularityAgnt The future looks very promising',
  ])('drops engagement farming: %s', (text) => {
    // Every one of these is real, taken from the account's own mentions.
    expect(verdict(text).skip).toBe(true);
  });

  it.each([
    '@SingularityAgnt what is gas on base right now?',
    '@SingularityAgnt can you check vitalik.eth holdings',
    '@SingularityAgnt whats the latest solana slot',
    '@SingularityAgnt which chains do you support?',
  ])('still answers the real question: %s', (text) => {
    expect(verdict(text).skip).toBe(false);
  });

  it('answers a follow-up in a thread it has actually spoken in', () => {
    // The bar is lower here: this person was already answered once.
    expect(
      classifyMention(mention('@SingularityAgnt and that one too'), {
        isFollowUp: true,
        now: () => NOW,
      }).skip,
    ).toBe(false);
  });

  it('still screens a thread reply for scams', () => {
    expect(
      classifyMention(mention('@SingularityAgnt dm me for help'), {
        isFollowUp: true,
        now: () => NOW,
      }).skip,
    ).toBe(true);
  });

  it('does not fire on a word that merely contains a scam term', () => {
    expect(verdict('@SingularityAgnt what is the gas on a pumpkin nft mint?').skip).toBe(false);
  });
});

describe('reply budget', () => {
  it('caps replies per hour across everyone', () => {
    const budget = new ReplyBudget(2, 5);

    expect(budget.take('a', NOW).skip).toBe(false);
    expect(budget.take('b', NOW).skip).toBe(false);

    const third = budget.take('c', NOW);
    expect(third.skip).toBe(true);
    expect(third.reason).toMatch(/hourly reply budget/);
  });

  it('caps replies to one account', () => {
    const budget = new ReplyBudget(10, 2);

    budget.take('a', NOW);
    budget.take('a', NOW);

    const third = budget.take('a', NOW);
    expect(third.skip).toBe(true);
    expect(third.reason).toMatch(/already replied/);
    // Someone else is unaffected by that account's flooding.
    expect(budget.take('b', NOW).skip).toBe(false);
  });

  it('frees the budget as the hour rolls forward', () => {
    const budget = new ReplyBudget(1, 1);

    expect(budget.take('a', NOW).skip).toBe(false);
    expect(budget.take('a', NOW + 60_000).skip).toBe(true);
    expect(budget.take('a', NOW + 3_600_001).skip).toBe(false);
  });
});

/** A client that serves one page of mentions and records what was replied. */
function fakeXClient(mentions: Mention[]): {
  client: XClient;
  replies: Array<{ text: string; inReplyTo: string }>;
} {
  const replies: Array<{ text: string; inReplyTo: string }> = [];

  const client = {
    async verify() {
      return { id: 'me', username: 'SingularityAgnt', name: 'Singularity' };
    },
    async mentions(): Promise<MentionPage> {
      return { mentions, newestId: mentions[0]?.id ?? '0' };
    },
    async reply(text: string, inReplyTo: string) {
      replies.push({ text, inReplyTo });
      return { published: true, text, id: 'reply-1', url: 'https://x.com/i/web/status/1', inReplyTo };
    },
  } as unknown as XClient;

  return { client, replies };
}

function countingAgent(): { agent: GrokAgent; calls: string[] } {
  const calls: string[] = [];

  const client = {
    async complete(messages: ChatMessage[]): Promise<AssistantMessage> {
      calls.push(String(messages.at(-1)?.content ?? ''));
      return { content: 'Base gas is about 0.01 gwei.', toolCalls: [] };
    },
  } as unknown as GrokClient;

  return { agent: new GrokAgent(client, { system: 'sys' }), calls };
}

describe('listener filtering end to end', () => {
  const statePath = `${process.env.TEMP ?? '.'}/singularity-x-state-test.json`;

  it('never spends a model call on spam', async () => {
    process.env.SINGULARITY_X_STATE = statePath;

    const spam = [
      mention('@SingularityAgnt 🚀🚀🚀🔥🔥', { id: '5', authorId: 'bot-1' }),
      mention('@SingularityAgnt dm me to recover your lost funds', { id: '4', authorId: 'bot-2' }),
      mention('@SingularityAgnt @a @b @c @d free mint today', { id: '3', authorId: 'bot-3' }),
      mention('@SingularityAgnt gm', { id: '2', authorId: 'bot-4' }),
    ];
    const real = mention('@SingularityAgnt what is gas on base?', { id: '6', authorId: 'human' });

    const { client, replies } = fakeXClient([real, ...spam]);
    const { agent, calls } = countingAgent();

    const listener = new XListener(client, agent, { now: () => NOW });
    // start() would enter the poll loop; drive one pass directly.
    await (listener as unknown as { userId: string }).userId;
    Object.assign(listener, { userId: 'me', username: 'SingularityAgnt' });

    const result = await listener.pollOnce();

    expect(result.skipped).toHaveLength(4);
    expect(result.handled).toHaveLength(1);
    // The one thing that actually costs money happened exactly once.
    expect(calls).toHaveLength(1);
    expect(replies).toEqual([
      { text: 'Base gas is about 0.01 gwei.', inReplyTo: '6' },
    ]);
  });

  it('explains every skip', async () => {
    process.env.SINGULARITY_X_STATE = statePath;

    const { client } = fakeXClient([mention('@SingularityAgnt gm', { id: '2' })]);
    const { agent } = countingAgent();

    const listener = new XListener(client, agent, { now: () => NOW });
    Object.assign(listener, { userId: 'me', username: 'SingularityAgnt' });

    const result = await listener.pollOnce();
    expect(result.skipped[0]?.reason).toBeTruthy();
  });

  it('ignores the account its own replies come from', async () => {
    process.env.SINGULARITY_X_STATE = statePath;

    const { client, replies } = fakeXClient([
      mention('@someone what is gas on base?', { id: '7', authorId: 'me' }),
    ]);
    const { agent } = countingAgent();

    const listener = new XListener(client, agent, { now: () => NOW });
    Object.assign(listener, { userId: 'me', username: 'SingularityAgnt' });

    const result = await listener.pollOnce();

    expect(result.handled).toHaveLength(0);
    expect(replies).toHaveLength(0);
  });
});
