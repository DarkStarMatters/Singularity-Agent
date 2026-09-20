import { describe, it, expect, afterEach } from 'vitest';
import {
  describePaymentRequest,
  parsePaymentRequest,
  paymentLink,
  transferLink,
} from '../src/pay/payment-request.js';

/**
 * The endpoint a wallet actually fetches.
 *
 * This is the half that deploys, and its only real security property is the
 * recipient allowlist — so most of what follows is about what it refuses.
 * `transaction-request.ts` already states the danger for burns: a transaction
 * request is a URL anybody can craft, and the wallet shows its origin. For a
 * payment it is worse, because an unrestricted endpoint lets the attacker name
 * who gets paid.
 */

const env = { ...process.env };

afterEach(() => {
  process.env = { ...env };
});

const TO = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const REF = '5pTy48gtfzaR8NPUVZTbybVUGpQvFT4JsNHzwQE8pump';

function allow(...addresses: string[]): void {
  process.env.SINGULARITY_PAY_RECIPIENTS = addresses.join(',');
}

describe('what the endpoint refuses', () => {
  it('builds nothing at all when no recipients are configured', () => {
    // Fail closed. An unconfigured deployment is not a permissive one.
    delete process.env.SINGULARITY_PAY_RECIPIENTS;

    expect(() => parsePaymentRequest({ t: TO, a: '25' })).toThrow(/no configured recipients/);
  });

  it('names the phishing risk in the hint, not just the rule', () => {
    delete process.env.SINGULARITY_PAY_RECIPIENTS;

    try {
      parsePaymentRequest({ t: TO, a: '25' });
    } catch (err) {
      expect((err as { hint?: string }).hint).toMatch(/phishing primitive/);
    }
  });

  it('refuses a recipient outside the allowlist', () => {
    // The whole reason parameters in a URL are safe here. Without this, anyone
    // could publish a link that pays them, under this deployment's domain.
    allow(TO);

    expect(() => parsePaymentRequest({ t: 'MalloryAddress111', a: '25' })).toThrow(
      /does not build payments to/,
    );
  });

  it('accepts any configured recipient', () => {
    allow('Alice111', TO);

    expect(parsePaymentRequest({ t: TO, a: '25' }).to).toBe(TO);
    expect(parsePaymentRequest({ t: 'Alice111', a: '25' }).to).toBe('Alice111');
  });

  it('needs both a recipient and an amount', () => {
    allow(TO);

    expect(() => parsePaymentRequest({ t: TO })).toThrow(/both a recipient and an amount/);
    expect(() => parsePaymentRequest({ a: '25' })).toThrow(/both a recipient and an amount/);
  });

  it('refuses base units and other non-amounts', () => {
    allow(TO);

    for (const a of ['1e9', 'abc', '-1', '1.2.3', '']) {
      expect(() => parsePaymentRequest({ t: TO, a }), a).toThrow();
    }
  });

  it('refuses a request for zero', () => {
    allow(TO);
    expect(() => parsePaymentRequest({ t: TO, a: '0' })).toThrow(/for zero is not a payment/);
  });

  it('truncates an over-long memo rather than carrying it into a transaction', () => {
    allow(TO);
    const parsed = parsePaymentRequest({ t: TO, a: '25', o: 'x'.repeat(500) });
    expect(parsed.memo!.length).toBe(200);
  });
});

describe('parameter names', () => {
  it('reads the short forms, which is what keeps the QR small', () => {
    allow(TO);
    const parsed = parsePaymentRequest({ t: TO, a: '25', m: MINT, r: REF, o: 'order:7' });

    expect(parsed).toMatchObject({ to: TO, amount: '25', mint: MINT, reference: REF, memo: 'order:7' });
  });

  it('also reads the long forms, for anyone hand-writing a link', () => {
    allow(TO);
    const parsed = parsePaymentRequest({
      to: TO,
      amount: '25',
      mint: MINT,
      reference: REF,
      memo: 'order:7',
    });

    expect(parsed).toMatchObject({ to: TO, amount: '25', mint: MINT, reference: REF });
  });

  it('treats a missing mint as native SOL rather than guessing one', () => {
    allow(TO);
    expect(parsePaymentRequest({ t: TO, a: '25' }).mint).toBeUndefined();
  });
});

describe('the link a wallet opens', () => {
  it('percent-encodes the inner URL whole', () => {
    // A wallet splitting on the first `?` would otherwise lose every parameter
    // after it — the same reason the burn link does this.
    const link = paymentLink('https://pay.example.com/api/pay', { to: TO, amount: '25' });

    expect(link.startsWith('solana:https%3A%2F%2F')).toBe(true);
    expect(link).not.toContain('?');
  });

  it('round-trips through parse', () => {
    allow(TO);
    const link = paymentLink('https://pay.example.com/api/pay', {
      to: TO,
      amount: '25',
      mint: MINT,
      reference: REF,
      memo: 'order:7',
    });

    const inner = new URL(decodeURIComponent(link.replace(/^solana:/, '')));
    const query = Object.fromEntries(inner.searchParams.entries());

    expect(parsePaymentRequest(query)).toMatchObject({
      to: TO,
      amount: '25',
      mint: MINT,
      reference: REF,
      memo: 'order:7',
    });
  });

  it('stays small enough to scan', () => {
    // The constraint that decided the short parameter names. A version-10 code
    // holds 274 bytes at level L, and two base58 addresses plus a reference is
    // already most of that.
    const link = paymentLink('https://singularity-agent.cicada71.net/api/pay', {
      to: TO,
      amount: '25',
      mint: MINT,
      reference: REF,
    });

    expect(new TextEncoder().encode(link).length).toBeLessThan(274);
  });

  it('omits what it was not given, rather than sending empties', () => {
    const link = paymentLink('https://pay.example.com/api/pay', { to: TO, amount: '25' });
    const inner = decodeURIComponent(link.replace(/^solana:/, ''));

    expect(inner).not.toContain('m=');
    expect(inner).not.toContain('r=');
    expect(inner).not.toContain('o=');
  });
});

describe('what the wallet shows beforehand', () => {
  it('names the amount and serves the icon from the endpoint origin', () => {
    // A wallet displays the endpoint's domain as the thing being trusted, so
    // an icon from anywhere else is the one part of that screen which did not
    // come from where it claims to.
    delete process.env.SINGULARITY_PAY_ICON;
    const described = describePaymentRequest({ to: TO, amount: '25' });

    expect(described.label).toBe('Pay 25');
    expect(described.icon).toMatch(/^https:\/\//);
  });

  it('lets a deployment override the icon', () => {
    process.env.SINGULARITY_PAY_ICON = 'https://example.com/me.png';
    expect(describePaymentRequest({ to: TO, amount: '25' }).icon).toBe('https://example.com/me.png');
  });
});

describe('the transfer request a wallet actually accepts', () => {
  /**
   * Payments were built on the wrong half of Solana Pay.
   *
   * A transaction request is a link to an endpoint that builds the transaction,
   * and it exists for what a wallet cannot construct from a URL — a burn. A
   * payment is a transfer, so the wallet can build it, and the transfer-request
   * form is what every wallet implements. Phantom rejected the endpoint form
   * outright; this is what it takes.
   */
  it('puts the recipient straight after the scheme, unencoded', () => {
    const link = transferLink({ to: TO, amount: '0.01' });
    expect(link.startsWith(`solana:${TO}?`)).toBe(true);

    // Base58 has no characters needing escaping, and encoding it would stop a
    // wallet recognising this as a transfer request at all.
    expect(link).not.toContain('%3A%2F%2F');
  });

  it('uses the spec parameter names, not our short internal ones', () => {
    const link = transferLink({ to: TO, amount: '25', mint: MINT, reference: REF });
    const query = new URLSearchParams(link.slice(link.indexOf('?') + 1));

    expect(query.get('amount')).toBe('25');
    expect(query.get('spl-token')).toBe(MINT);
    expect(query.get('reference')).toBe(REF);

    // The endpoint form's abbreviations would be silently ignored by a wallet.
    expect(query.get('t')).toBeNull();
    expect(query.get('m')).toBeNull();
  });

  it('carries the reference, which is what settlement is found by', () => {
    // The spec requires the wallet to attach each reference as a read-only,
    // non-signer key on the transfer instruction — the same account
    // findPayment searches by.
    const link = transferLink({ to: TO, amount: '1', reference: REF });
    expect(link).toContain(`reference=${REF}`);
  });

  it('percent-encodes a label rather than using plus for spaces', () => {
    // URLSearchParams would write `Order+7`, which is right for a form and
    // wrong here — a wallet shows the label to a human.
    const link = transferLink({ to: TO, amount: '1', label: 'Order 7' });
    expect(link).toContain('label=Order%207');
    expect(link).not.toContain('Order+7');
  });

  it('omits what it was not given', () => {
    const link = transferLink({ to: TO, amount: '1' });
    expect(link).toBe(`solana:${TO}?amount=1`);
  });

  it('is shorter than the endpoint form, which is why it scans better', () => {
    const params = { to: TO, amount: '25', mint: MINT, reference: REF };
    const transfer = transferLink(params);
    const endpoint = paymentLink('https://singularity-agent.cicada71.net/api/pay', params);

    expect(new TextEncoder().encode(transfer).length).toBeLessThan(
      new TextEncoder().encode(endpoint).length,
    );
  });

  it('needs no server to be reachable', () => {
    // The property that matters most: this link works when the deployment is
    // down, because the wallet builds the transaction itself.
    expect(transferLink({ to: TO, amount: '1' })).not.toContain('http');
  });
});
