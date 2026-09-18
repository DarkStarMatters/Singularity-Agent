import { describe, it, expect, beforeEach } from 'vitest';
import {
  RecentVoice,
  contentTokens,
  opening,
  similarity,
  varietyNote,
  OVERLAP_LIMIT,
} from '../src/grok/variety.js';
import { GrokAgent, resetSharedVoice, sharedVoice } from '../src/grok/agent.js';
import type { AssistantMessage, ChatMessage, GrokClient } from '../src/grok/client.js';
import { describeError } from '../src/grok/client.js';

/**
 * The complaint this file exists for: every stranger got the same sentences.
 *
 * Conversation memory is per-thread, which is correct for context and useless
 * for voice — two people asking a similar question a week apart each got a cold
 * start from an identical system prompt, and the model reliably reached for the
 * opening it liked best. Nothing in the loop knew what had already been said
 * out loud.
 *
 * The thing being protected while fixing it is the caveats. A completeness note
 * is a required disclosure that must repeat verbatim every time it applies, so
 * the tests below check that two replies sharing one do not count as repetition
 * — variety that erodes a warning is a worse bug than the one it fixes.
 */

/** A client that replies with whatever is queued, and records what it was sent. */
function scriptedClient(replies: string[]): {
  client: GrokClient;
  prompts: ChatMessage[][];
} {
  const prompts: ChatMessage[][] = [];
  let next = 0;

  const client = {
    async complete(messages: ChatMessage[]): Promise<AssistantMessage> {
      prompts.push(messages.map((m) => ({ ...m })));
      const content = replies[Math.min(next, replies.length - 1)] ?? '';
      next += 1;
      return { content, toolCalls: [] };
    },
  } as unknown as GrokClient;

  return { client, prompts };
}

function agentWith(client: GrokClient, voice: RecentVoice): GrokAgent {
  return new GrokAgent(client, { system: 'system', tools: false, voice });
}

beforeEach(() => resetSharedVoice());

describe('measuring whether two replies are the same reply', () => {
  it('sees a reworded answer as a repeat', () => {
    const a = 'The balance is 4.2 ETH, though EVM token coverage is a curated list of major tokens.';
    const b = 'Balance is 4.2 ETH. EVM token coverage is a curated list of major tokens, though.';

    expect(similarity(a, b)).toBeGreaterThan(OVERLAP_LIMIT);
  });

  it('does not see two different numbers as the same answer', () => {
    // Digits are kept as tokens on purpose. Strip them and every balance reply
    // collapses into one sentence, and the second one gets suppressed.
    const a = 'That address holds 4.2 ETH right now.';
    const b = 'That address holds 918.55 ETH right now.';

    expect(similarity(a, b)).toBeLessThan(1);
    expect(contentTokens(a)).toContain('4.2');
  });

  it('reads the opening rather than the whole sentence', () => {
    // Three content words of shared formula is the signal. "no" counts: a
    // denial is the answer here, not a filler word.
    expect(opening('Short answer: no, it cannot sign anything.')).toBe(
      opening('Short answer: no, it will never hold a key.'),
    );
    expect(opening('Short answer: no, it cannot sign anything.')).toBe('short answer no');
  });
});

describe('the voice memory', () => {
  let voice: RecentVoice;

  beforeEach(() => {
    voice = new RecentVoice(3);
  });

  it('catches a draft that repeats an opening', () => {
    voice.remember('Short answer, no. It holds no keys and cannot sign a transaction for you.');

    const collision = voice.collides(
      'Short answer, no. There is no way for it to broadcast anything on your behalf.',
    );

    expect(collision.repeats).toBe(true);
    expect(collision.kind).toBe('opening');
  });

  it('lets a required caveat repeat without calling it repetition', () => {
    // Both replies carry the same mandatory disclosure and answer different
    // questions. If this trips, the fix would be to vary a warning, which is
    // the one thing that must never vary.
    const caveat =
      'EVM token coverage is a curated list of major tokens, so this is not a complete picture of what the address holds.';

    voice.remember(`It holds 4.2 ETH and 37 USDC. ${caveat}`);

    const collision = voice.collides(
      `Gas on Base is around 0.00000014 ETH for a simple transfer. ${caveat}`,
    );

    expect(collision.repeats).toBe(false);
  });

  it('exempts a short factual denial', () => {
    // "No, it cannot sign" is the right answer to a question asked constantly,
    // and there is no obligation to find a fresh way to say it.
    voice.remember('No. It cannot sign.');
    expect(voice.collides('No. It cannot sign.').repeats).toBe(false);
  });

  it('forgets past its limit rather than growing without bound', () => {
    voice.remember('one about blocks and headers and heights');
    voice.remember('two about balances and tokens and decimals');
    voice.remember('three about fees and gas and rollups');
    voice.remember('four about burns and signatures and memos');

    expect(voice.recent()).toHaveLength(3);
    expect(voice.recent()[0]).toContain('four');
  });
});

describe('what the model is told before it writes', () => {
  it('lists what was already said, and protects the caveats while doing it', () => {
    const note = varietyNote(['a previous reply']).join(' ');

    expect(note).toContain('a previous reply');
    expect(note).toMatch(/caveats|completeness/i);
  });

  it('says nothing at all when there is no history to avoid', () => {
    expect(varietyNote([])).toEqual([]);
  });

  it('reaches the model as part of the system message', async () => {
    const voice = new RecentVoice();
    voice.remember('Gas on Base sits near a hundredth of a cent for a plain transfer.');

    const { client, prompts } = scriptedClient(['Something entirely different about burns.']);
    await agentWith(client, voice).respond('c1', 'what are fees like');

    const system = prompts[0]?.[0]?.content ?? '';
    expect(system).toContain('Gas on Base sits near');
  });
});

describe('the retry, which is the half that is not a request', () => {
  it('asks again when the first draft repeats, and sends the rewrite', async () => {
    const voice = new RecentVoice();
    voice.remember('Short answer, no. It holds no keys and cannot sign a transaction for you.');

    const { client, prompts } = scriptedClient([
      'Short answer, no. It holds no keys and will not sign a transaction for you.',
      'Keys never enter the process. It builds the payload; your own wallet does the signing.',
    ]);

    const reply = await agentWith(client, voice).respond('c1', 'can it sign');

    expect(prompts).toHaveLength(2);
    expect(reply.text).toContain('Keys never enter the process');

    // The rewrite request has to name the problem, or it is just "try again".
    const nudge = String(prompts[1]?.[prompts[1].length - 1]?.content ?? '');
    expect(nudge).toMatch(/repeats you/i);
  });

  it('accepts the second draft even if it still collides', async () => {
    // One retry, not a loop. A second collision usually means the question
    // really was the same question, and answering it the same way is correct.
    const voice = new RecentVoice();
    voice.remember('Short answer, no. It holds no keys and cannot sign a transaction for you.');

    const { client, prompts } = scriptedClient([
      'Short answer, no. It holds no keys and cannot sign a transaction for anyone.',
      'Short answer, no. It holds no keys and cannot sign a transaction for anybody.',
    ]);

    const reply = await agentWith(client, voice).respond('c1', 'can it sign');

    expect(prompts).toHaveLength(2);
    expect(reply.text).toContain('anybody');
  });

  it('remembers only what was actually sent', async () => {
    const voice = new RecentVoice();
    voice.remember('Short answer, no. It holds no keys and cannot sign a transaction for you.');

    const { client } = scriptedClient([
      'Short answer, no. It holds no keys and will not sign a transaction for you.',
      'Keys never enter the process. Your own wallet does the signing, every time.',
    ]);

    await agentWith(client, voice).respond('c1', 'can it sign');

    // The discarded draft was never said to anybody, so it is not part of the
    // voice. Storing it would make the agent avoid phrasing it never used.
    expect(voice.recent().some((line) => line.includes('will not sign'))).toBe(false);
    expect(voice.recent()[0]).toContain('Keys never enter');
  });
});

describe('one account, two surfaces', () => {
  it('shares a voice so a reply is not repeated across them', async () => {
    const voice = sharedVoice();
    const { client } = scriptedClient(['A reply about burns and finalized commitment.']);

    await agentWith(client, voice).respond('telegram:1', 'tell me about burns');

    // The X side asks the same shared memory, so what Telegram just said is
    // already on the list the next prompt is told to avoid.
    expect(sharedVoice().recent()[0]).toContain('finalized commitment');
  });
});

describe('what the API said, rather than what status it used', () => {
  it('reads xAI\u2019s string error, which is how this broke silently', () => {
    // The real 400 that stopped the bot posting. `error` is a bare string here;
    // reading `.message` off it yields undefined, and the caller logs "HTTP
    // 400" \u2014 a bot that had stopped working and a log that would not say why.
    expect(
      describeError(
        {
          code: 'invalid-argument',
          error: 'Model grok-4 does not support parameter presencePenalty.',
        },
        400,
      ),
    ).toBe('Model grok-4 does not support parameter presencePenalty. (invalid-argument)');
  });

  it('still reads the object shape other providers send', () => {
    expect(describeError({ error: { message: 'context length exceeded' } }, 400)).toBe(
      'context length exceeded',
    );
  });

  it('falls back to the status only when there is genuinely nothing else', () => {
    expect(describeError({}, 503)).toBe('HTTP 503');
  });
});
