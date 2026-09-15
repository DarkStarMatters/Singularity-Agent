import { describe, it, expect } from 'vitest';
import { PostGate, type ApprovalTransport, type PendingPost, type ResolvedPost } from '../src/x/approval.js';
import { decisionFrom, renderPending, renderResolved } from '../src/telegram/approvals.js';
import { runXCommand, type XControl, type XStatus } from '../src/telegram/control.js';
import { resolveControlChat } from '../src/agent.js';
import type { XClient } from '../src/x/client.js';

const NOW = 1_700_000_000_000;

function harness(options: { failPublish?: boolean } = {}) {
  const published: Array<{ text: string; inReplyTo?: string }> = [];
  const requested: PendingPost[] = [];
  const resolved: ResolvedPost[] = [];

  const client = {
    async post(text: string) {
      if (options.failPublish) throw new Error('X API returned 403: duplicate');
      published.push({ text });
      return { published: true, text, id: '1', url: 'https://x.com/i/web/status/1' };
    },
    async reply(text: string, inReplyTo: string) {
      if (options.failPublish) throw new Error('X API returned 403: duplicate');
      published.push({ text, inReplyTo });
      return { published: true, text, id: '2', url: 'https://x.com/i/web/status/2', inReplyTo };
    },
  } as unknown as XClient;

  const transport: ApprovalTransport = {
    async request(pending) {
      requested.push(pending);
    },
    async resolved(resolution) {
      resolved.push(resolution);
    },
  };

  let clock = NOW;
  const gate = new PostGate(client, transport, { now: () => clock });

  return { gate, client, published, requested, resolved, tick: (ms: number) => (clock += ms) };
}

describe('the approval gate', () => {
  it('publishes nothing on submission', async () => {
    const { gate, published, requested } = harness();
    await gate.submit({ kind: 'update', text: 'Reaches 23 chains.' });

    // The whole point: composing is not posting.
    expect(published).toEqual([]);
    expect(requested).toHaveLength(1);
    expect(gate.size).toBe(1);
  });

  it('publishes on approval, once', async () => {
    const { gate, published } = harness();
    const pending = await gate.submit({ kind: 'update', text: 'Reaches 23 chains.' });

    await gate.approve(pending.id, 'deadsg');
    expect(published).toEqual([{ text: 'Reaches 23 chains.' }]);

    // A second tap must not post it again.
    expect(await gate.approve(pending.id)).toBeNull();
    expect(published).toHaveLength(1);
  });

  it('threads an approved reply under the right post', async () => {
    const { gate, published } = harness();
    const pending = await gate.submit({
      kind: 'reply',
      text: 'Base gas is 0.01 gwei.',
      inReplyTo: '777',
      author: 'someone',
    });

    await gate.approve(pending.id);
    expect(published).toEqual([{ text: 'Base gas is 0.01 gwei.', inReplyTo: '777' }]);
  });

  it('publishes nothing when rejected', async () => {
    const { gate, published, resolved } = harness();
    const pending = await gate.submit({ kind: 'update', text: 'Reaches 23 chains.' });

    await gate.reject(pending.id, 'deadsg');

    expect(published).toEqual([]);
    expect(resolved[0]).toMatchObject({ approved: false, by: 'deadsg' });
    expect(gate.size).toBe(0);
  });

  it('reports a publish failure instead of losing it silently', async () => {
    const { gate, resolved } = harness({ failPublish: true });
    const pending = await gate.submit({ kind: 'update', text: 'Reaches 23 chains.' });

    const outcome = await gate.approve(pending.id);

    expect(outcome?.approved).toBe(true);
    expect(outcome?.error).toMatch(/403/);
    expect(resolved[0]?.error).toBeTruthy();
  });

  it('expires a stale draft rather than posting yesterday’s answer', async () => {
    const { gate, tick, published } = harness();
    const pending = await gate.submit({ kind: 'update', text: 'Reaches 23 chains.' });

    tick(7 * 3_600_000);

    expect(gate.get(pending.id)).toBeUndefined();
    expect(await gate.approve(pending.id)).toBeNull();
    expect(published).toEqual([]);
  });

  it('lists what is waiting, oldest first', async () => {
    const { gate, tick } = harness();
    await gate.submit({ kind: 'update', text: 'first post here' });
    tick(1_000);
    await gate.submit({ kind: 'update', text: 'second post here' });

    expect(gate.pending().map((p) => p.text)).toEqual(['first post here', 'second post here']);
  });

  it('gives each pending post an id short enough for a Telegram button', async () => {
    const { gate } = harness();
    const pending = await gate.submit({ kind: 'update', text: 'Reaches 23 chains.' });

    // callback_data is capped at 64 bytes and carries a prefix too.
    expect(`ok:${pending.id}`.length).toBeLessThan(64);
  });
});

describe('approval cards', () => {
  const pending: PendingPost = {
    id: 'p1abc',
    kind: 'reply',
    text: 'Base gas is 0.01 gwei right now.',
    context: 'what is gas on base?',
    author: 'someone',
    createdAt: NOW,
  };

  it('shows the exact text that would be published', () => {
    const card = renderPending(pending);

    expect(card).toContain('Base gas is 0.01 gwei right now.');
    expect(card).toContain('what is gas on base?');
    expect(card).toContain(`${pending.text.length}/260`);
  });

  it('escapes a hostile draft rather than rendering it as markup', () => {
    const card = renderPending({ ...pending, text: '<b>not bold</b>' });
    expect(card).toContain('&lt;b&gt;not bold&lt;/b&gt;');
  });

  it('shows the outcome and the link once posted', () => {
    const card = renderResolved({
      pending,
      approved: true,
      by: 'deadsg',
      result: { published: true, text: pending.text, url: 'https://x.com/i/web/status/2' },
    });

    expect(card).toContain('Posted');
    expect(card).toContain('deadsg');
    expect(card).toContain('https://x.com/i/web/status/2');
  });

  it('says plainly when publishing failed after approval', () => {
    const card = renderResolved({ pending, approved: true, error: 'rate limited' });

    expect(card).toContain('publishing failed');
    expect(card).toContain('rate limited');
  });

  it('round-trips a decision through callback data', () => {
    expect(decisionFrom('ok:p1abc')).toEqual({ approve: true, id: 'p1abc' });
    expect(decisionFrom('no:p1abc')).toEqual({ approve: false, id: 'p1abc' });
    expect(decisionFrom('something-else')).toBeNull();
  });
});

function stubControl(overrides: Partial<XControl> = {}): { control: XControl; calls: string[] } {
  const calls: string[] = [];

  const status: XStatus = {
    account: '@SingularityAgnt',
    paused: false,
    postingEnabled: true,
    approvalRequired: true,
    repliesThisHour: 2,
    pendingApprovals: 1,
    updateIntervalHours: 4,
    nextUpdateInMinutes: 95,
    lastAngle: 'coverage',
  };

  return {
    calls,
    control: {
      status: () => status,
      pause: () => void calls.push('pause'),
      resume: () => void calls.push('resume'),
      composeNow: async (angle) => {
        calls.push(`compose:${angle ?? 'auto'}`);
        return 'A drafted post.';
      },
      pending: () => [],
      approve: async (id) => `approved ${id}`,
      reject: async (id) => `rejected ${id}`,
      ...overrides,
    },
  };
}

describe('the /x control command', () => {
  it('reports status in terms an operator asks about', async () => {
    const { control } = stubControl();
    const out = await runXCommand(control, ['status']);

    expect(out).toContain('@SingularityAgnt');
    expect(out).toContain('approval required');
    expect(out).toContain('every 4h');
    expect(out).toContain('95 min');
  });

  it('defaults to status with no subcommand', async () => {
    const { control } = stubControl();
    expect(await runXCommand(control, [])).toContain('@SingularityAgnt');
  });

  it('warns loudly when posting is live without approval', async () => {
    const { control } = stubControl({
      status: () => ({
        account: '@a',
        paused: false,
        postingEnabled: true,
        approvalRequired: false,
        repliesThisHour: 0,
        pendingApprovals: 0,
        updateIntervalHours: 0,
        nextUpdateInMinutes: null,
        lastAngle: null,
      }),
    });

    expect(await runXCommand(control, ['status'])).toContain('LIVE');
  });

  it('pauses and resumes', async () => {
    const { control, calls } = stubControl();

    expect(await runXCommand(control, ['pause'])).toContain('Paused');
    expect(await runXCommand(control, ['resume'])).toContain('Resumed');
    expect(calls).toEqual(['pause', 'resume']);
  });

  it('drafts on demand with an angle', async () => {
    const { control, calls } = stubControl();

    await runXCommand(control, ['post', 'safety']);
    expect(calls).toContain('compose:safety');
  });

  it('says so when a draft was declined', async () => {
    const { control } = stubControl({ composeNow: async () => null });
    expect(await runXCommand(control, ['post'])).toMatch(/Nothing worth posting/);
  });

  it('needs an id to approve', async () => {
    const { control } = stubControl();

    expect(await runXCommand(control, ['approve'])).toMatch(/Which one/);
    expect(await runXCommand(control, ['approve', 'p1'])).toBe('approved p1');
    expect(await runXCommand(control, ['reject', 'p1'])).toBe('rejected p1');
  });

  it('explains itself when the X bot is not in this process', async () => {
    expect(await runXCommand(undefined, ['status'])).toMatch(/npm run agent/);
  });

  it('shows usage for an unknown subcommand', async () => {
    const { control } = stubControl();
    expect(await runXCommand(control, ['frobnicate'])).toContain('/x status');
  });
});

describe('choosing the control chat', () => {
  it('prefers an explicit setting', () => {
    expect(resolveControlChat({ TELEGRAM_CONTROL_CHAT: '-100123' }, null)).toBe(-100123);
  });

  it('falls back to a single allowlisted chat', () => {
    expect(resolveControlChat({}, new Set([-100999]))).toBe(-100999);
  });

  it('refuses to guess between several chats', () => {
    // Guessing wrong would send drafts, and the power to publish, to the
    // wrong room.
    expect(resolveControlChat({}, new Set([-1, -2]))).toBeNull();
    expect(resolveControlChat({}, null)).toBeNull();
  });
});
