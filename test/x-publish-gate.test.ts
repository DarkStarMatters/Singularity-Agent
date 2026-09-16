import { describe, it, expect, vi } from 'vitest';
import type { Mention, MentionPage, XClient } from '../src/x/client.js';
import type { AssistantMessage, GrokClient, ToolCall } from '../src/grok/client.js';

/** Every ERC-20 answers zero, so the scan succeeds and comes back curated. */
vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createPublicClient: () => ({
      getBalance: async () => 0n,
      readContract: async () => 0n,
      getBlockNumber: async () => 21_000_000n,
    }),
  };
});

const { XListener } = await import('../src/x/listener.js');
const { GrokAgent } = await import('../src/grok/agent.js');
const { completeness } = await import('../src/core/envelope.js');

/**
 * The gate, driven through the real listener.
 *
 * The unit tests in `honesty.test.ts` pin the rule. This pins that the rule is
 * actually *reached* on the path a mention takes to becoming a public post —
 * which is the part that silently stops being true when someone refactors
 * `answer()`.
 */

const NOW = Date.parse('2026-09-15T12:00:00Z');
const STATE_PATH = `${process.env.TEMP ?? '.'}/singularity-x-gate-test.json`;

function mention(text: string, id = '10'): Mention {
  return {
    id,
    text,
    authorId: 'human-1',
    authorUsername: 'someone',
    conversationId: id,
    authorCreatedAt: '2019-01-01T00:00:00Z',
    authorFollowers: 500,
  };
}

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
      return { published: true, text, id: 'r1', url: 'https://x.com/i/web/status/1', inReplyTo };
    },
  } as unknown as XClient;

  return { client, replies };
}

/**
 * An agent that calls `balance` and then says whatever it is told to say.
 *
 * The tool call is what matters: it is how the reply acquires evidence, and
 * therefore how the gate acquires anything to check the reply against.
 */
function agentSaying(answer: string, options: { tool?: boolean } = {}): GrokAgent {
  let called = options.tool === false;

  const client = {
    async complete(): Promise<AssistantMessage> {
      if (!called) {
        called = true;
        return {
          content: '',
          toolCalls: [
            {
              id: 'c1',
              type: 'function',
              function: {
                name: 'balance',
                arguments:
                  '{"address":"0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045","chain":"ethereum"}',
              },
            } as ToolCall,
          ],
        };
      }
      return { content: answer, toolCalls: [] };
    },
  } as unknown as GrokClient;

  return new GrokAgent(client, { system: 'sys' });
}

/** Drive one poll without entering the loop `start()` would. */
async function pollWith(
  answer: string,
  text = '@SingularityAgnt what does 0xabc hold on base?',
  options: { tool?: boolean } = {},
) {
  process.env.SINGULARITY_X_STATE = STATE_PATH;

  const { client, replies } = fakeXClient([mention(text)]);
  const listener = new XListener(client, agentSaying(answer, options), { now: () => NOW });
  Object.assign(listener, { userId: 'me', username: 'SingularityAgnt' });

  const result = await listener.pollOnce();
  return { result, replies };
}

describe('the publish gate on the live reply path', () => {
  it('repairs an absence claim before it is posted', async () => {
    // The balance call succeeds and comes back `curated`: an EVM chain cannot
    // be enumerated, so every token answered zero and the honest reading is
    // "none of the nine we looked at", not "none at all".
    const { replies } = await pollWith('That address holds no tokens.');

    expect(replies).toHaveLength(1);
    expect(replies[0]?.text).toContain('That address holds no tokens.');
    expect(replies[0]?.text).toMatch(/not a full enumeration/i);
  });

  it('leaves an ordinary answer exactly as composed', async () => {
    const { replies } = await pollWith('It holds 5 USDC and 0.2 ETH.');

    expect(replies).toHaveLength(1);
    expect(replies[0]?.text).toBe('It holds 5 USDC and 0.2 ETH.');
  });

  it('withholds rather than publishing a claim it cannot repair in 260 characters', async () => {
    const long = `${'x '.repeat(120)}the wallet is empty.`;
    const { result, replies } = await pollWith(long);

    // Nothing went out, and the listener still reports the mention as handled
    // with a reason attached rather than losing it silently.
    expect(replies).toHaveLength(0);
    expect(result.handled).toHaveLength(1);
    expect(result.handled[0]?.reply.published).toBe(false);
    expect(result.handled[0]?.reply.reason).toMatch(/Withheld/);
  });

  it('does not interfere when the reply rests on no enumerable evidence', async () => {
    // A question about the project reaches no scan, so there is nothing for
    // the gate to check and it must stay out of the way.
    const { replies } = await pollWith(
      'Singularity never signs anything and stores nothing.',
      '@SingularityAgnt do you hold private keys?',
      { tool: false },
    );

    expect(replies).toHaveLength(1);
    expect(replies[0]?.text).toBe('Singularity never signs anything and stores nothing.');
  });

  it('does not caveat a custody answer just because a scan happened', async () => {
    // "holds no keys" is this project's most repeated sentence and has nothing
    // to do with a token scan. Caveating it would be noise, and noise is how a
    // gate like this earns itself an exemption and then a deletion.
    const { replies } = await pollWith('Singularity holds no keys and never signs.');

    expect(replies).toHaveLength(1);
    expect(replies[0]?.text).toBe('Singularity holds no keys and never signs.');
  });
});

describe('the rule the gate enforces', () => {
  it('is that only an exhaustive scan licenses an absence claim', () => {
    // Stated here as executable prose: the four kinds, and the one that is
    // allowed to say "there is nothing there".
    const licensed = [
      completeness.exhaustive('all of it'),
      completeness.curated('a subset'),
      completeness.truncated(50, 31, 'capped'),
      completeness.failed('nothing answered'),
    ].map((c) => c.kind === 'exhaustive');

    expect(licensed).toEqual([true, false, false, false]);
  });
});
