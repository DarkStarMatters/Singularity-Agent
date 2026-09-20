import { describe, it, expect, vi, afterEach } from 'vitest';
import { createPay, InMemoryIntentStore } from '../src/index.js';
import type { StoredIntent } from '../src/index.js';
import * as agent from 'singularity-agent';

/**
 * The endpoint a wallet actually talks to.
 *
 * `respond` is pure — method, id, body in; status and JSON out — so the whole
 * exchange is testable without standing up a server, which is the reason it was
 * written that way. A payment endpoint that can only be tested by deploying it
 * is one whose failure modes get discovered by customers.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

const ENDPOINT = 'https://pay.example.com/i';

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

function payWith(intent?: StoredIntent) {
  const store = new InMemoryIntentStore();
  const pay = createPay({ store, endpoint: ENDPOINT, icon: 'https://pay.example.com/icon.png' });
  return { store, pay, ready: intent ? store.put(intent) : Promise.resolve() };
}

describe('configuration', () => {
  it('refuses to start without a store, naming what to do', () => {
    expect(() => createPay({ endpoint: ENDPOINT } as never)).toThrow(/needs an intent store/);
  });

  it('refuses to start without a public endpoint', () => {
    expect(() => createPay({ store: new InMemoryIntentStore() } as never)).toThrow(
      /public URL of your endpoint/,
    );
  });

  it('points at the database rather than shipping a default store', () => {
    // The point being defended: a library that quietly owns payment records is
    // a library that loses them on restart.
    try {
      createPay({ endpoint: ENDPOINT } as never);
    } catch (err) {
      expect((err as { hint?: string }).hint).toMatch(/your own database/);
    }
  });
});

describe('the transaction-request exchange', () => {
  it('answers a preflight', async () => {
    const { pay } = payWith();
    const res = await pay.respond('OPTIONS', 'anything');

    expect(res.status).toBe(204);
    expect(res.headers['Access-Control-Allow-Origin']).toBe('*');
  });

  it('tells the wallet what it is about to show', async () => {
    const { pay, ready } = payWith(intentFixture());
    await ready;

    const res = await pay.respond('GET', 'abc123');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ label: 'Order 7', icon: 'https://pay.example.com/icon.png' });
  });

  it('never caches, because a built transaction lives for seconds', async () => {
    const { pay, ready } = payWith(intentFixture());
    await ready;

    const res = await pay.respond('GET', 'abc123');
    expect(res.headers['Cache-Control']).toBe('no-store');
  });

  it('builds for the account the wallet sends, so nobody types an address', async () => {
    const build = vi
      .spyOn(agent, 'buildIntentPayment')
      .mockResolvedValue({ transaction: 'base64==', message: 'Pay 25' });

    const { pay, ready } = payWith(intentFixture());
    await ready;

    const res = await pay.respond('POST', 'abc123', { account: 'Payer1111111111111111111111111111111111111' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ transaction: 'base64==', message: 'Pay 25' });
    expect(build).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'abc123' }),
      'Payer1111111111111111111111111111111111111',
    );
  });

  it('refuses a POST with no account rather than guessing one', async () => {
    const { pay, ready } = payWith(intentFixture());
    await ready;

    for (const body of [undefined, {}, { account: '   ' }]) {
      const res = await pay.respond('POST', 'abc123', body as never);
      expect(res.status).toBe(400);
      expect((res.body as { error: string }).error).toBe('MISSING_ACCOUNT');
    }
  });

  it('405s an unexpected method', async () => {
    const { pay, ready } = payWith(intentFixture());
    await ready;

    const res = await pay.respond('DELETE', 'abc123');
    expect(res.status).toBe(405);
  });
});

describe('what the endpoint refuses', () => {
  it('404s an id that does not resolve', async () => {
    const { pay } = payWith();
    const res = await pay.respond('GET', 'nope');

    expect(res.status).toBe(404);
    expect((res.body as { error: string }).error).toBe('INTENT_NOT_FOUND');
  });

  it('410s an expired request, with a sentence a human can read', async () => {
    const { pay, ready } = payWith(
      intentFixture({ expiresAt: new Date(Date.now() - 1000).toISOString() }),
    );
    await ready;

    const res = await pay.respond('GET', 'abc123');

    expect(res.status).toBe(410);
    expect((res.body as { message: string }).message).toMatch(/expired/i);
  });

  it('410s one that has already been paid, rather than taking the money twice', async () => {
    const { pay, ready } = payWith(intentFixture({ settledAt: new Date().toISOString() }));
    await ready;

    const res = await pay.respond('POST', 'abc123', { account: 'Payer111' });

    expect(res.status).toBe(410);
    expect((res.body as { error: string }).error).toBe('INTENT_ALREADY_PAID');
  });

  it('builds nothing for an intent it refused', async () => {
    const build = vi.spyOn(agent, 'buildIntentPayment');
    const { pay } = payWith();

    await pay.respond('POST', 'missing', { account: 'Payer111' });

    expect(build).not.toHaveBeenCalled();
  });
});

describe('the link a customer receives', () => {
  it('carries an opaque id and no payment detail at all', async () => {
    // Native SOL: no mint, so no issuer to read and nothing to stub. The link
    // shape is the point here, and it does not depend on the asset.
    const { pay } = payWith();
    const created = await pay.createIntent({
      to: 'Merchant11111111111111111111111111111111111',
      amount: '25',
      orderId: '7',
    });

    const inner = decodeURIComponent(created.url.replace(/^solana:/, ''));

    expect(created.url.startsWith('solana:')).toBe(true);
    expect(inner).toBe(`${ENDPOINT}/${created.intent.id}`);

    // Nothing to tamper with: editing a character yields an id that does not
    // resolve, not a payment to somewhere else.
    expect(new URL(inner).search).toBe('');
    expect(inner).not.toContain('25');
    expect(inner).not.toContain('Merchant');
  });

  it('skips the mint read for a native SOL payment, which has no issuer', async () => {
    const assess = vi.spyOn(agent, 'assessMintRisk');

    const { pay } = payWith();
    const created = await pay.createIntent({ to: 'M', amount: '1' });

    expect(assess).not.toHaveBeenCalled();
    expect(created.risk).toBeUndefined();
  });
});

describe('settlement through the SDK', () => {
  it('passes the settlement bar through unchanged', async () => {
    const settle = vi.spyOn(agent, 'settleIntent').mockResolvedValue({
      level: 'probabilistic',
      mismatches: [],
      note: 'confirmed',
      fulfil: false,
      intent: intentFixture(),
    } as never);

    const { pay, ready } = payWith(intentFixture());
    await ready;

    await pay.settle('abc123');
    expect(settle).toHaveBeenLastCalledWith(expect.anything(), 'abc123', {});

    await pay.settle('abc123', { require: 'probabilistic' });
    expect(settle).toHaveBeenLastCalledWith(expect.anything(), 'abc123', {
      require: 'probabilistic',
    });
  });

  it('hands back the settlement verdict without reinterpreting it', async () => {
    // The SDK layer must not soften a refusal. A final transaction that does
    // not match the order is still not a payment, and `fulfil` is the only
    // field that says whether to ship.
    vi.spyOn(agent, 'settleIntent').mockResolvedValue({
      level: 'final',
      signature: 'sig',
      mismatches: ['paid in the wrong mint'],
      note: 'wrong token',
      fulfil: false,
      intent: intentFixture(),
    } as never);

    const { pay, ready } = payWith(intentFixture());
    await ready;

    const result = await pay.settle('abc123');

    expect(result.level).toBe('final');
    expect(result.fulfil).toBe(false);
    expect(result.mismatches).toEqual(['paid in the wrong mint']);
  });
});
