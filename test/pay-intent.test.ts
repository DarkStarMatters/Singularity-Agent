import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  InMemoryIntentStore,
  intentLink,
  isExpired,
  newIntentId,
  newReference,
  prepareIntent,
  type StoredIntent,
} from '../src/pay/intent.js';
import { meetsSettlement, SETTLEMENT_ORDER } from '../src/pay/types.js';
import { createIntent, resolveIntent, settleIntent } from '../src/pay/operations.js';
import * as solana from '../src/adapters/solana.js';

/**
 * The parts of Pay that decide whether a merchant ships.
 *
 * Nothing here touches a network. What is being tested is the reasoning: what
 * counts as paid, what counts as *this* payment, and what happens when the same
 * payment is presented twice.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

describe('what travels in a payment link', () => {
  it('puts nothing in the URL but an opaque id', () => {
    const link = intentLink('https://pay.example.com/i', 'deadbeef');
    const inner = decodeURIComponent(link.replace(/^solana:/, ''));

    expect(inner).toBe('https://pay.example.com/i/deadbeef');

    // The whole anti-phishing property, asserted rather than described: a link
    // carries no recipient, no amount, no mint. There is nothing to edit into
    // a payment to somewhere else.
    expect(inner).not.toMatch(/amount|recipient|\bto=|mint/i);
    expect(new URL(inner).search).toBe('');
  });

  it('percent-encodes the inner URL whole', () => {
    // A wallet that splits on the first `?` would otherwise lose the rest.
    expect(intentLink('https://pay.example.com/i', 'abc')).toMatch(/^solana:https%3A%2F%2F/);
  });

  it('tolerates an endpoint with or without a trailing slash', () => {
    expect(intentLink('https://p.example.com/i', 'x')).toBe(intentLink('https://p.example.com/i/', 'x'));
  });

  it('generates ids that are unguessable and carry no information', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newIntentId()));
    expect(ids.size).toBe(200);

    for (const id of ids) {
      // 128 bits of hex. Not a counter, not a hash of the order — the id is the
      // only thing protecting an intent, since it travels in pasted links.
      expect(id).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it('generates a distinct reference per intent', () => {
    const refs = new Set(Array.from({ length: 50 }, () => newReference()));
    expect(refs.size).toBe(50);
  });
});

describe('what a merchant may ask for', () => {
  it('refuses a missing recipient', () => {
    expect(() => prepareIntent({ to: '', amount: '1' })).toThrow(/needs a recipient/);
  });

  it('refuses base units and other non-amounts', () => {
    for (const amount of ['1e9', 'abc', '', '-1', '1.2.3']) {
      expect(() => prepareIntent({ to: 'x', amount }), amount).toThrow(/is not an amount/);
    }
  });

  it('refuses a payment for zero', () => {
    expect(() => prepareIntent({ to: 'x', amount: '0' })).toThrow(/for zero is not a payment/);
    expect(() => prepareIntent({ to: 'x', amount: '0.0' })).toThrow(/for zero is not a payment/);
  });

  it('refuses a lifetime that is absurd in either direction', () => {
    expect(() => prepareIntent({ to: 'x', amount: '1', expiresIn: 0 })).toThrow(/usable lifetime/);
    expect(() => prepareIntent({ to: 'x', amount: '1', expiresIn: -5 })).toThrow(/usable lifetime/);
    expect(() => prepareIntent({ to: 'x', amount: '1', expiresIn: 999_999 })).toThrow(/usable lifetime/);
  });

  it('defaults to a short life, because the blockhash is shorter still', () => {
    const intent = prepareIntent({ to: 'x', amount: '1' });
    const ttl = new Date(intent.expiresAt).getTime() - new Date(intent.createdAt).getTime();
    expect(ttl).toBe(900_000);
  });
});

/** An intent with everything filled in, for the settlement tests. */
function intentFixture(overrides: Partial<StoredIntent> = {}): StoredIntent {
  return {
    id: 'abc123',
    reference: 'Ref111111111111111111111111111111111111111',
    to: 'Merchant11111111111111111111111111111111111',
    amount: '25',
    mint: 'Usdc1111111111111111111111111111111111111111',
    label: 'Order 7',
    memo: 'order:7',
    orderId: '7',
    chain: 'solana',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 900_000).toISOString(),
    ...overrides,
  };
}

describe('presenting an intent', () => {
  it('gives the same answer for never-existed and swept, so ids cannot be probed', async () => {
    const store = new InMemoryIntentStore();
    await expect(resolveIntent(store, 'nope')).rejects.toMatchObject({ code: 'INTENT_NOT_FOUND' });
  });

  it('refuses an expired intent rather than building against it', async () => {
    const store = new InMemoryIntentStore();
    await store.put(intentFixture({ expiresAt: new Date(Date.now() - 1_000).toISOString() }));

    await expect(resolveIntent(store, 'abc123')).rejects.toMatchObject({ code: 'INTENT_EXPIRED' });
  });

  it('refuses one that is already paid, rather than taking the money twice', async () => {
    const store = new InMemoryIntentStore();
    await store.put(intentFixture({ settledAt: new Date().toISOString() }));

    await expect(resolveIntent(store, 'abc123')).rejects.toMatchObject({
      code: 'INTENT_ALREADY_PAID',
    });
  });

  it('serves a live one', async () => {
    const store = new InMemoryIntentStore();
    await store.put(intentFixture());
    await expect(resolveIntent(store, 'abc123')).resolves.toMatchObject({ id: 'abc123' });
  });

  it('knows when an intent has expired', () => {
    expect(isExpired(intentFixture({ expiresAt: new Date(Date.now() - 1).toISOString() }))).toBe(true);
    expect(isExpired(intentFixture())).toBe(false);
  });
});

describe('settlement levels are ordered, not boolean', () => {
  it('ranks them', () => {
    expect(SETTLEMENT_ORDER.unpaid).toBeLessThan(SETTLEMENT_ORDER.pending);
    expect(SETTLEMENT_ORDER.pending).toBeLessThan(SETTLEMENT_ORDER.probabilistic);
    expect(SETTLEMENT_ORDER.probabilistic).toBeLessThan(SETTLEMENT_ORDER.final);
  });

  it('treats "at least this settled" as the question', () => {
    expect(meetsSettlement('final', 'probabilistic')).toBe(true);
    expect(meetsSettlement('probabilistic', 'final')).toBe(false);
    expect(meetsSettlement('unpaid', 'pending')).toBe(false);
    expect(meetsSettlement('final', 'final')).toBe(true);
  });
});

describe('deciding whether the merchant has been paid', () => {
  const settled = {
    level: 'final' as const,
    signature: 'sig123',
    mismatches: [],
    note: 'ok',
  };

  it('fulfils exactly once, however many times it is polled', async () => {
    // The bug this prevents: a merchant polling in a loop ships the same order
    // on every call, because `level === 'final'` stays true forever.
    vi.spyOn(solana, 'findPayment').mockResolvedValue(settled as never);

    const store = new InMemoryIntentStore();
    await store.put(intentFixture());

    const first = await settleIntent(store, 'abc123');
    const second = await settleIntent(store, 'abc123');
    const third = await settleIntent(store, 'abc123');

    expect(first.fulfil).toBe(true);
    expect(second.fulfil).toBe(false);
    expect(third.fulfil).toBe(false);

    // And it still reports the payment as settled — refusing to fulfil twice is
    // not the same as claiming it was not paid.
    expect(second.level).toBe('final');
    expect(second.alreadyFulfilled).toBeTruthy();
  });

  it('refuses to fulfil on any mismatch, however final the transaction', async () => {
    vi.spyOn(solana, 'findPayment').mockResolvedValue({
      level: 'final',
      signature: 'sig123',
      mismatches: ['paid in mint FAKE, but this order asked for Usdc11…'],
      note: 'wrong token',
    } as never);

    const store = new InMemoryIntentStore();
    await store.put(intentFixture());

    const result = await settleIntent(store, 'abc123');

    expect(result.level).toBe('final');
    expect(result.fulfil).toBe(false);
    expect(result.mismatches).toHaveLength(1);
  });

  it('requires finality by default, not mere confirmation', async () => {
    vi.spyOn(solana, 'findPayment').mockResolvedValue({
      level: 'probabilistic',
      signature: 'sig123',
      mismatches: [],
      note: 'confirmed, not finalized',
    } as never);

    const store = new InMemoryIntentStore();
    await store.put(intentFixture());

    expect((await settleIntent(store, 'abc123')).fulfil).toBe(false);
  });

  it('lets a caller lower the bar deliberately, and only deliberately', async () => {
    vi.spyOn(solana, 'findPayment').mockResolvedValue({
      level: 'probabilistic',
      signature: 'sig123',
      mismatches: [],
      note: 'confirmed',
    } as never);

    const store = new InMemoryIntentStore();
    await store.put(intentFixture());

    const result = await settleIntent(store, 'abc123', { require: 'probabilistic' });
    expect(result.fulfil).toBe(true);
  });

  it('does not fulfil an unpaid intent', async () => {
    vi.spyOn(solana, 'findPayment').mockResolvedValue({
      level: 'unpaid',
      mismatches: [],
      note: 'nothing found',
    } as never);

    const store = new InMemoryIntentStore();
    await store.put(intentFixture());

    const result = await settleIntent(store, 'abc123');
    expect(result.fulfil).toBe(false);
    expect(result.level).toBe('unpaid');
  });

  it('raises rather than guessing when there is no intent to check against', async () => {
    const store = new InMemoryIntentStore();
    await expect(settleIntent(store, 'missing')).rejects.toMatchObject({
      code: 'INTENT_NOT_FOUND',
    });
  });
});

describe('the store contract', () => {
  it('marks settled exactly once', async () => {
    const store = new InMemoryIntentStore();
    await store.put(intentFixture());

    expect(await store.markSettled('abc123', 'sig')).toBe(true);
    expect(await store.markSettled('abc123', 'sig')).toBe(false);
  });

  it('finds an intent by its reference, which is how settlement arrives', async () => {
    const store = new InMemoryIntentStore();
    const intent = intentFixture();
    await store.put(intent);

    await expect(store.byReference(intent.reference)).resolves.toMatchObject({ id: 'abc123' });
    await expect(store.byReference('other')).resolves.toBeNull();
  });
});

describe('reading the mint before agreeing to accept it', () => {
  it('reads it at creation, and stores the answer with the intent', async () => {
    // The check nobody else runs. It happens at creation because the answer
    // does not change later and the merchant needs it *before* publishing the
    // link — and it is stored so the record survives the decision.
    const assess = vi.spyOn(solana, 'assessMintRisk').mockResolvedValue({
      mint: 'Usdc111',
      freezeAuthority: 'Freezer111',
      permanentDelegate: 'Clawback111',
      custodyIsYours: false,
      warnings: ['can be frozen', 'can be clawed back'],
    } as never);

    const store = new InMemoryIntentStore();
    const created = await createIntent(store, 'https://pay.example.com/i', {
      to: 'Merchant111',
      amount: '25',
      mint: 'Usdc111',
    });

    expect(assess).toHaveBeenCalledOnce();
    expect(created.risk?.custodyIsYours).toBe(false);
    expect(created.intent.risk?.permanentDelegate).toBe('Clawback111');

    const stored = await store.get(created.intent.id);
    expect(stored?.risk?.freezeAuthority).toBe('Freezer111');
  });

  it('does not refuse a risky mint on its own', async () => {
    // Plenty of legitimate tokens carry a freeze authority. Whether that is
    // acceptable is a commercial decision, not a library's — so this reports
    // and lets the merchant branch on it.
    vi.spyOn(solana, 'assessMintRisk').mockResolvedValue({
      mint: 'X',
      freezeAuthority: 'F',
      custodyIsYours: false,
      warnings: ['can be frozen'],
    } as never);

    const store = new InMemoryIntentStore();
    await expect(
      createIntent(store, 'https://pay.example.com/i', { to: 'M', amount: '1', mint: 'X' }),
    ).resolves.toMatchObject({ risk: { custodyIsYours: false } });
  });

  it('skips the read for native SOL, which has no issuer to distrust', async () => {
    const assess = vi.spyOn(solana, 'assessMintRisk');

    const store = new InMemoryIntentStore();
    const created = await createIntent(store, 'https://pay.example.com/i', {
      to: 'M',
      amount: '1',
    });

    expect(assess).not.toHaveBeenCalled();
    expect(created.risk).toBeUndefined();
  });
});

describe('Pay is Solana-only, and says so', () => {
  it('refuses an EVM chain by name rather than failing obscurely', async () => {
    const store = new InMemoryIntentStore();

    await expect(
      createIntent(store, 'https://pay.example.com/i', {
        to: '0x1',
        amount: '1',
        chain: 'ethereum',
      }),
    ).rejects.toMatchObject({ code: 'PAY_UNSUPPORTED' });
  });
});
