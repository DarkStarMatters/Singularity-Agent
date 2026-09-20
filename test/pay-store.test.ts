import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FileIntentStore,
  allowedRecipients,
  intentsPath,
  requireAllowedRecipient,
} from '../src/pay/file-store.js';
import { notifyPayment, payCaption, payChatId } from '../src/pay/notify.js';
import type { StoredIntent } from '../src/pay/intent.js';
import type { CreatedIntent } from '../src/pay/operations.js';

/**
 * The parts of Pay that persist things and the parts that send them.
 *
 * Both are where a payment quietly goes wrong: a store that forgets an intent
 * ships an order twice, and a notifier that fails silently means a QR nobody
 * ever saw. Neither failure raises anything on its own, so both are tested for
 * what they do rather than what they return.
 */

let dir: string;
let path: string;
const env = { ...process.env };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sngl-pay-'));
  path = join(dir, 'intents.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.env = { ...env };
  vi.restoreAllMocks();
});

function intentFixture(overrides: Partial<StoredIntent> = {}): StoredIntent {
  return {
    id: 'abc123',
    reference: 'Ref111',
    to: 'Merchant111',
    amount: '25',
    mint: 'Usdc111',
    label: 'Order 7',
    memo: 'order:7',
    orderId: '7',
    chain: 'solana',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 900_000).toISOString(),
    ...overrides,
  };
}

describe('intents on disk', () => {
  it('survives a new store over the same file, which is the whole point', async () => {
    // In-memory loses everything on restart, and for a payment record that is
    // the worst failure available: the money arrived and the order did not.
    await new FileIntentStore(path).put(intentFixture());

    const reopened = new FileIntentStore(path);
    await expect(reopened.get('abc123')).resolves.toMatchObject({ id: 'abc123', amount: '25' });
  });

  it('finds an intent by reference, which is how settlement arrives', async () => {
    const store = new FileIntentStore(path);
    await store.put(intentFixture({ reference: 'Unique999' }));

    await expect(store.byReference('Unique999')).resolves.toMatchObject({ id: 'abc123' });
    await expect(store.byReference('Other')).resolves.toBeNull();
  });

  it('returns null rather than throwing for an unknown id', async () => {
    await expect(new FileIntentStore(path).get('nope')).resolves.toBeNull();
  });

  it('reads an absent file as empty, so a fresh install is not an error', async () => {
    expect(existsSync(path)).toBe(false);
    await expect(new FileIntentStore(path).all()).resolves.toEqual([]);
  });

  it('marks settled exactly once, across separate store objects', async () => {
    // The guarantee somebody ships goods on. Two objects over one file is the
    // realistic shape — a CLI invocation and a bot, not one long-lived object.
    await new FileIntentStore(path).put(intentFixture());

    expect(await new FileIntentStore(path).markSettled('abc123', 'sig')).toBe(true);
    expect(await new FileIntentStore(path).markSettled('abc123', 'sig')).toBe(false);
  });

  it('records the signature it settled with', async () => {
    const store = new FileIntentStore(path);
    await store.put(intentFixture());
    await store.markSettled('abc123', 'sig-xyz');

    const settled = await store.get('abc123');
    expect(settled?.settledSignature).toBe('sig-xyz');
    expect(settled?.settledAt).toBeTruthy();
  });

  it('will not settle an intent it has never seen', async () => {
    expect(await new FileIntentStore(path).markSettled('ghost', 'sig')).toBe(false);
  });

  it('lists newest first', async () => {
    const store = new FileIntentStore(path);
    await store.put(intentFixture({ id: 'old', createdAt: '2020-01-01T00:00:00.000Z' }));
    await store.put(intentFixture({ id: 'new', createdAt: '2030-01-01T00:00:00.000Z' }));

    expect((await store.all()).map((intent) => intent.id)).toEqual(['new', 'old']);
  });

  it('refuses a corrupt file rather than starting over on top of it', async () => {
    // Silently treating unparseable JSON as empty would lose the record of
    // which payments were already fulfilled, which is how an order ships twice.
    writeFileSync(path, '{ not json', 'utf8');

    await expect(new FileIntentStore(path).get('abc123')).rejects.toMatchObject({
      code: 'BAD_INTENT_FILE',
    });
  });

  it('leaves no temporary file behind after a write', async () => {
    // Write-then-rename, so an interrupted write cannot leave a half-file
    // where the payment records used to be.
    await new FileIntentStore(path).put(intentFixture());

    expect(readFileSync(path, 'utf8')).toContain('abc123');
    expect(existsSync(`${path}.${process.pid}.tmp`)).toBe(false);
  });

  it('defaults its location under the singularity config directory', () => {
    delete process.env.SINGULARITY_INTENTS;
    expect(intentsPath()).toMatch(/[\\/]\.singularity[\\/]intents\.json$/);

    process.env.SINGULARITY_INTENTS = '/tmp/elsewhere.json';
    expect(intentsPath()).toBe('/tmp/elsewhere.json');
  });
});

describe('who this deployment will build a payment to', () => {
  it('allows nobody when nothing is configured, and says why', () => {
    // Fail closed. There is no sensible default for "who gets paid", and
    // guessing one is how a stranger gets paid under your name.
    delete process.env.SINGULARITY_PAY_RECIPIENTS;

    expect(allowedRecipients()).toEqual([]);
    expect(() => requireAllowedRecipient('anyone')).toThrow(/no configured payment recipients/);
  });

  it('names the fix in the hint rather than just refusing', () => {
    delete process.env.SINGULARITY_PAY_RECIPIENTS;

    try {
      requireAllowedRecipient('anyone');
    } catch (err) {
      expect((err as { hint?: string }).hint).toMatch(/SINGULARITY_PAY_RECIPIENTS/);
      expect((err as { hint?: string }).hint).toMatch(/somebody else paid/);
    }
  });

  it('accepts a configured recipient and refuses everything else', () => {
    process.env.SINGULARITY_PAY_RECIPIENTS = 'Alice111, Bob222';

    expect(allowedRecipients()).toEqual(['Alice111', 'Bob222']);
    expect(() => requireAllowedRecipient('Alice111')).not.toThrow();
    expect(() => requireAllowedRecipient('Bob222')).not.toThrow();
    expect(() => requireAllowedRecipient('Mallory333')).toThrow(/does not build payment requests/);
  });

  it('lists the configured recipients when it refuses, so the fix is obvious', () => {
    process.env.SINGULARITY_PAY_RECIPIENTS = 'Alice111';

    try {
      requireAllowedRecipient('Mallory333');
    } catch (err) {
      expect((err as { hint?: string }).hint).toContain('Alice111');
    }
  });

  it('ignores blank entries and surrounding whitespace', () => {
    process.env.SINGULARITY_PAY_RECIPIENTS = ' Alice111 ,, Bob222 ,';
    expect(allowedRecipients()).toEqual(['Alice111', 'Bob222']);
  });
});

describe('where a payment QR is sent', () => {
  it('prefers its own variable, then falls back to the control chat', () => {
    process.env.SINGULARITY_PAY_CHAT = '-100111';
    process.env.TELEGRAM_CONTROL_CHAT = '-100222';
    expect(payChatId()).toBe(-100111);

    delete process.env.SINGULARITY_PAY_CHAT;
    expect(payChatId()).toBe(-100222);

    delete process.env.TELEGRAM_CONTROL_CHAT;
    expect(payChatId()).toBeUndefined();
  });

  it('treats a non-numeric or zero chat id as none', () => {
    process.env.SINGULARITY_PAY_CHAT = 'not-a-number';
    expect(payChatId()).toBeUndefined();

    process.env.SINGULARITY_PAY_CHAT = '0';
    expect(payChatId()).toBeUndefined();
  });
});

function createdFixture(risk?: CreatedIntent['risk']): CreatedIntent {
  return {
    intent: intentFixture({ ...(risk ? { risk } : {}) }),
    url: 'solana:https%3A%2F%2Fpay.example.com%2Fi%2Fabc123',
    ...(risk ? { risk } : {}),
  };
}

describe('the caption a QR carries into a chat', () => {
  it('states the amount, the recipient and the id', () => {
    const caption = payCaption(createdFixture());

    expect(caption).toContain('25');
    expect(caption).toContain('Merchant111');
    expect(caption).toContain('abc123');
  });

  it('says Singularity cannot sign, on the message that asks for a signature', () => {
    expect(payCaption(createdFixture())).toMatch(/holds no keys and cannot sign/);
  });

  it('warns about shared custody where the mint allows it', () => {
    // The risk read belongs on the screen of whoever is about to accept the
    // token, not in a log. A merchant showing this to a customer should know
    // the issuer can take it back.
    const caption = payCaption(
      createdFixture({
        mint: 'Usdc111',
        freezeAuthority: 'Freezer111',
        custodyIsYours: false,
        warnings: ['Freezer111 can freeze token accounts for this mint.'],
      } as never),
    );

    expect(caption).toMatch(/Custody is shared/);
    expect(caption).toContain('Freezer111');
  });

  it('stays quiet when custody genuinely belongs to the merchant', () => {
    const caption = payCaption(
      createdFixture({ mint: 'X', custodyIsYours: true, warnings: [] } as never),
    );

    expect(caption).not.toMatch(/Custody is shared/);
  });

  it('fits inside Telegram caption limit', () => {
    // 1024 characters. Going over does not fail loudly — it truncates, and the
    // part that would be lost is the custody warning at the end.
    const caption = payCaption(
      createdFixture({
        mint: 'Usdc111',
        freezeAuthority: 'F',
        permanentDelegate: 'D',
        custodyIsYours: false,
        warnings: ['a'.repeat(200), 'b'.repeat(200)],
      } as never),
    );

    expect(caption.length).toBeLessThanOrEqual(1024);
  });
});

describe('sending the QR', () => {
  it('reports rather than throws when no bot is configured', async () => {
    // A payment request that was created successfully has been created
    // successfully. A Telegram outage must not turn that into a failure.
    delete process.env.TELEGRAM_BOT_TOKEN;

    const result = await notifyPayment(createdFixture());

    expect(result.sent).toBe(false);
    expect(result.reason).toMatch(/TELEGRAM_BOT_TOKEN/);
  });

  it('reports rather than throws when no chat is configured', async () => {
    process.env.TELEGRAM_BOT_TOKEN = '123456:abcdefghijklmnopqrstuvwxyz1234567890';
    delete process.env.SINGULARITY_PAY_CHAT;
    delete process.env.TELEGRAM_CONTROL_CHAT;

    const result = await notifyPayment(createdFixture());

    expect(result.sent).toBe(false);
    // Never silent about why: an unsent QR that says nothing is worse than one
    // that was never attempted.
    expect(result.reason).toMatch(/No chat to send to/);
  });
});
