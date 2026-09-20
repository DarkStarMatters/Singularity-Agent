import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PaymentWatcher, chatFromMemo } from '../src/telegram/payments.js';
import { FileIntentStore } from '../src/pay/file-store.js';
import type { StoredIntent } from '../src/pay/intent.js';
import * as solana from '../src/adapters/solana.js';

/**
 * The bot telling a chat that money arrived.
 *
 * The thing worth testing is not that a message goes out — it is that it goes
 * out *once*, to the right chat, and that nothing else in the bot falls over
 * when a sweep fails. A payment announced twice is a merchant shipping twice,
 * and a sweep that throws takes the watcher down with it.
 */

let dir: string;
let store: FileIntentStore;

const sent: Array<{ chatId: number; text: string }> = [];

const api = {
  sendMessage: vi.fn(async (options: { chatId: number; text: string }) => {
    sent.push(options);
    return { message_id: 1, chat: { id: options.chatId, type: 'group' } };
  }),
} as never;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sngl-watch-'));
  store = new FileIntentStore(join(dir, 'intents.json'));
  sent.length = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function intentFixture(overrides: Partial<StoredIntent> = {}): StoredIntent {
  return {
    id: 'abc123',
    reference: 'Ref111',
    to: 'Merchant111',
    amount: '25',
    label: 'Order 7',
    memo: 'sngl-pay:-1001234567890',
    orderId: '7',
    chain: 'solana',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 900_000).toISOString(),
    ...overrides,
  };
}

/** A chain that reports whatever `level` says, with no mismatches. */
function chainSays(level: 'final' | 'unpaid') {
  vi.spyOn(solana, 'findPayment').mockResolvedValue({
    level,
    ...(level === 'final' ? { signature: 'sig-abc' } : {}),
    mismatches: [],
    note: 'test',
  } as never);
}

describe('finding the chat from the payment itself', () => {
  it('reads the chat id a /pay memo wrote', () => {
    // The settlement carries its own delivery address, so a restart loses
    // nothing: the memo is on chain and the payer signed it.
    expect(chatFromMemo('sngl-pay:-1001234567890')).toBe(-1001234567890);
    expect(chatFromMemo('sngl-pay:12345')).toBe(12345);
  });

  it('ignores a memo that is not one of ours', () => {
    for (const memo of [undefined, '', 'order:7', 'sngl:-100123', 'sngl-pay:abc', 'sngl-pay:0']) {
      expect(chatFromMemo(memo), String(memo)).toBeUndefined();
    }
  });
});

describe('announcing a settled payment', () => {
  it('tells the chat that asked, once', async () => {
    chainSays('final');
    await store.put(intentFixture());

    const watcher = new PaymentWatcher(api, store, { intervalSeconds: 1 });
    watcher.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.chatId).toBe(-1001234567890);
    expect(sent[0]!.text).toMatch(/Payment received/);

    watcher.stop();
  });

  it('never announces the same payment twice, however long it runs', async () => {
    // settleIntent marks fulfilment exactly once, so a watcher polling every
    // second for a minute still only ever says it once. This is the bug that
    // would ship an order repeatedly.
    chainSays('final');
    await store.put(intentFixture());

    const watcher = new PaymentWatcher(api, store, { intervalSeconds: 1 });
    watcher.start();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(sent).toHaveLength(1);
    expect(watcher.announcedCount).toBe(1);

    watcher.stop();
  });

  it('says nothing while a request is unpaid', async () => {
    chainSays('unpaid');
    await store.put(intentFixture());

    const watcher = new PaymentWatcher(api, store, { intervalSeconds: 1 });
    watcher.start();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(sent).toHaveLength(0);
    watcher.stop();
  });

  it('marks the intent settled, so /paid agrees with the announcement', async () => {
    chainSays('final');
    await store.put(intentFixture());

    const watcher = new PaymentWatcher(api, store, { intervalSeconds: 1 });
    watcher.start();
    await vi.advanceTimersByTimeAsync(0);

    const after = await store.get('abc123');
    expect(after?.settledAt).toBeTruthy();
    expect(after?.settledSignature).toBe('sig-abc');

    watcher.stop();
  });
});

describe('what the sweep skips', () => {
  it('ignores an expired request rather than paying RPC to check it', async () => {
    const findPayment = vi.spyOn(solana, 'findPayment');
    await store.put(intentFixture({ expiresAt: new Date(Date.now() - 1).toISOString() }));

    const watcher = new PaymentWatcher(api, store, { intervalSeconds: 1 });
    watcher.start();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(findPayment).not.toHaveBeenCalled();
    watcher.stop();
  });

  it('ignores one already settled', async () => {
    const findPayment = vi.spyOn(solana, 'findPayment');
    await store.put(intentFixture({ settledAt: new Date().toISOString() }));

    const watcher = new PaymentWatcher(api, store, { intervalSeconds: 1 });
    watcher.start();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(findPayment).not.toHaveBeenCalled();
    watcher.stop();
  });

  it('caps how many it checks per tick', async () => {
    // A merchant with three hundred unpaid links would otherwise make three
    // hundred RPC calls every interval, mostly about requests nobody will pay.
    chainSays('unpaid');
    for (let i = 0; i < 25; i += 1) {
      await store.put(intentFixture({ id: `id-${i}`, reference: `ref-${i}` }));
    }

    const watcher = new PaymentWatcher(api, store, { intervalSeconds: 100 });
    watcher.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(vi.mocked(solana.findPayment).mock.calls.length).toBeLessThanOrEqual(10);
    watcher.stop();
  });
});

describe('failures must not take the watcher down', () => {
  it('keeps sweeping after one request cannot be read', async () => {
    let calls = 0;
    vi.spyOn(solana, 'findPayment').mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new Error('rpc exploded');
      return { level: 'final', signature: 'sig', mismatches: [], note: 'ok' } as never;
    });

    await store.put(intentFixture());

    const watcher = new PaymentWatcher(api, store, { intervalSeconds: 1 });
    watcher.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(sent).toHaveLength(1);

    watcher.stop();
  });

  it('survives a chat it can no longer post to', async () => {
    // Removed from the group, or blocked. The payment is settled either way and
    // the ledger already knows; losing the announcement must not lose the sweep.
    chainSays('final');
    api.sendMessage.mockRejectedValueOnce(new Error('chat not found'));
    await store.put(intentFixture());

    const watcher = new PaymentWatcher(api, store, { intervalSeconds: 1 });
    watcher.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(watcher.active).toBe(true);
    watcher.stop();
  });

  it('falls back to the control chat when a memo names none', async () => {
    chainSays('final');
    await store.put(intentFixture({ memo: 'order:7' }));

    const watcher = new PaymentWatcher(api, store, {
      intervalSeconds: 1,
      fallbackChatId: -100999,
    });
    watcher.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(sent[0]?.chatId).toBe(-100999);
    watcher.stop();
  });

  it('stays quiet when there is nowhere to send', async () => {
    chainSays('final');
    await store.put(intentFixture({ memo: 'order:7' }));

    const watcher = new PaymentWatcher(api, store, { intervalSeconds: 1 });
    watcher.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(sent).toHaveLength(0);
    watcher.stop();
  });
});

describe('lifecycle', () => {
  it('starts once, however many times start is called', async () => {
    chainSays('unpaid');
    await store.put(intentFixture());

    const watcher = new PaymentWatcher(api, store, { intervalSeconds: 1 });
    watcher.start();
    watcher.start();
    await vi.advanceTimersByTimeAsync(3_000);

    // One loop, not two racing each other over the same ledger.
    expect(vi.mocked(solana.findPayment).mock.calls.length).toBeLessThanOrEqual(4);
    watcher.stop();
  });

  it('stops cleanly', async () => {
    chainSays('unpaid');
    await store.put(intentFixture());

    const watcher = new PaymentWatcher(api, store, { intervalSeconds: 1 });
    watcher.start();
    await vi.advanceTimersByTimeAsync(0);
    watcher.stop();

    const before = vi.mocked(solana.findPayment).mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);

    expect(vi.mocked(solana.findPayment).mock.calls.length).toBe(before);
    expect(watcher.active).toBe(false);
  });
});
