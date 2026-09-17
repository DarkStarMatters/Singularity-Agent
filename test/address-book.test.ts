import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A pinned alias has exactly one job: never answer with an address other than
 * its pin. So the negative half of this file asserts that every path either
 * matches or raises — there is no branch anywhere that reports the new address
 * with a warning attached, because a result carrying the new address *is* the
 * failure.
 *
 * The positive half is longer, on purpose. By Contributing §3 a gate is worth
 * what it does to the traffic it should pass, and this one sits in front of
 * every `balance`, `portfolio` and `build_transfer` call in the repo. A pin
 * that reports a mismatch because one side is EIP-55 checksummed would be
 * turned off inside a day, and turning it off is the only outcome worse than
 * not having it.
 */

/** Swapped per test; every mocked viem call routes through here. */
let ensHandler: (name: string) => string | null = () => null;

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createPublicClient: () => ({
      getEnsAddress: ({ name }: { name: string }) => Promise.resolve().then(() => ensHandler(name)),
      getEnsName: () => Promise.resolve(null),
      getBalance: () => Promise.resolve(0n),
      readContract: () => Promise.resolve(0n),
      getBlockNumber: () => Promise.resolve(1n),
    }),
  };
});

const { lookupAlias, sameAddress } = await import('../src/core/address-book.js');
const { decodeBech32Raw, convertBech32Prefix } = await import('../src/core/address-codec.js');
const { resetRegistry, getChain } = await import('../src/core/registry.js');
const { resolve, getPortfolio } = await import('../src/tools/operations.js');
const { SingularityError } = await import('../src/core/errors.js');

const VITALIK = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const VITALIK_LOWER = VITALIK.toLowerCase();
const STRANGER = '0x000000000000000000000000000000000000dEaD';
const ATOM = 'cosmos1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5lzv7xu';
const SOL = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';

let dir: string | undefined;

/** Write a config file and point the registry at it. */
function withBook(addressBook: Record<string, unknown>): void {
  dir ??= mkdtempSync(join(tmpdir(), 'singularity-book-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({ addressBook }), 'utf8');
  process.env.SINGULARITY_CONFIG = path;
  resetRegistry();
}

beforeEach(() => {
  ensHandler = () => null;
});

afterEach(() => {
  delete process.env.SINGULARITY_CONFIG;
  resetRegistry();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** Capture the error a call throws, typed. */
function failure(run: () => unknown): InstanceType<typeof SingularityError> {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(SingularityError);
    return err as InstanceType<typeof SingularityError>;
  }
  throw new Error('expected the call to throw, but it returned');
}

async function asyncFailure(
  run: () => Promise<unknown>,
): Promise<InstanceType<typeof SingularityError>> {
  try {
    await run();
  } catch (err) {
    expect(err).toBeInstanceOf(SingularityError);
    return err as InstanceType<typeof SingularityError>;
  }
  throw new Error('expected the call to reject, but it resolved');
}

describe('the book still does what it always did', () => {
  it('expands a plain string entry', () => {
    withBook({ treasury: VITALIK });
    expect(lookupAlias('treasury').target).toBe(VITALIK);
  });

  it('matches an alias written in a different case', () => {
    withBook({ treasury: VITALIK });
    expect(lookupAlias('Treasury').target).toBe(VITALIK);
  });

  it('passes an input that is not in the book straight through', () => {
    withBook({ treasury: VITALIK });
    expect(lookupAlias(VITALIK).target).toBe(VITALIK);
    expect(lookupAlias('vitalik.eth').target).toBe('vitalik.eth');
  });

  it('works with no book configured at all', () => {
    resetRegistry();
    expect(lookupAlias('vitalik.eth').target).toBe('vitalik.eth');
  });

  it('does not answer an inherited Object property as an alias', () => {
    // `book['constructor']` on a plain object is a function, and the old
    // lookup returned whatever `??` accepted. An alias nobody wrote must
    // expand to nothing.
    withBook({ treasury: VITALIK });
    expect(lookupAlias('constructor').target).toBe('constructor');
    expect(lookupAlias('toString').target).toBe('toString');
  });

  it('leaves an unpinned alias free to follow its name wherever it points', () => {
    withBook({ treasury: 'treasury.eth' });
    const lookup = lookupAlias('treasury');
    expect(lookup.settle(STRANGER)).toBe(STRANGER);
    expect(lookup.settle(null)).toBeNull();
  });
});

describe('a pin that should pass', () => {
  it('accepts the address it names', () => {
    withBook({ treasury: { target: 'treasury.eth', pin: VITALIK } });
    expect(lookupAlias('treasury').settle(VITALIK)).toBe(VITALIK);
  });

  it('accepts the same address in a different EIP-55 casing', () => {
    // The commonest shape of a false alarm: a pin copied from an explorer,
    // checksummed, against a lowercase resolution off an RPC.
    withBook({ treasury: { target: 'treasury.eth', pin: VITALIK } });
    expect(lookupAlias('treasury').settle(VITALIK_LOWER)).toBe(VITALIK_LOWER);

    withBook({ treasury: { target: 'treasury.eth', pin: VITALIK_LOWER } });
    expect(lookupAlias('treasury').settle(VITALIK)).toBe(VITALIK);
  });

  it('accepts a bech32 address written in the uppercase form', () => {
    // bech32 forbids mixed case exactly so that both casings mean one address.
    // Both sides are asserted to decode, so a pass here is the fold working
    // rather than two strings that happened to be equal.
    expect(decodeBech32Raw(ATOM)).not.toBeNull();
    expect(decodeBech32Raw(ATOM.toUpperCase())).not.toBeNull();

    withBook({ validator: { target: 'validator.eth', pin: ATOM } });
    expect(lookupAlias('validator').settle(ATOM.toUpperCase())).toBe(ATOM.toUpperCase());
  });

  it('tolerates whitespace around a pin', () => {
    withBook({ treasury: { target: 'treasury.eth', pin: `  ${VITALIK}  ` } });
    expect(lookupAlias('treasury').settle(VITALIK)).toBe(VITALIK);
  });

  it('accepts a pinned entry whose target is already that address', () => {
    // Redundant rather than wrong: it pins the config file itself, which is the
    // half of the threat that has nothing to do with name resolution.
    withBook({ treasury: { target: VITALIK, pin: VITALIK_LOWER } });
    expect(lookupAlias('treasury').settle(VITALIK)).toBe(VITALIK);
  });

  it('leaves an entry object with no pin unpinned', () => {
    withBook({ treasury: { target: 'treasury.eth' } });
    const lookup = lookupAlias('treasury');
    expect(lookup.pin).toBeUndefined();
    expect(lookup.settle(STRANGER)).toBe(STRANGER);
  });
});

describe('a pin that should fire', () => {
  it('raises when the name resolves somewhere else', () => {
    withBook({ treasury: { target: 'treasury.eth', pin: VITALIK } });
    const err = failure(() => lookupAlias('treasury').settle(STRANGER));
    expect(err.code).toBe('ALIAS_PIN_MISMATCH');
    expect(err.message).toContain(VITALIK);
    expect(err.message).toContain(STRANGER);
  });

  it('raises rather than falling back to the pin when nothing resolves', () => {
    withBook({ treasury: { target: 'treasury.eth', pin: VITALIK } });
    const err = failure(() => lookupAlias('treasury').settle(null));
    expect(err.code).toBe('ALIAS_PIN_UNVERIFIED');
    expect(err.hint).toContain(VITALIK);
  });

  it('does not fold base58 case, because two mints differing in case are two mints', () => {
    withBook({ vault: { target: 'vault.sol', pin: SOL } });
    const err = failure(() => lookupAlias('vault').settle(SOL.toLowerCase()));
    expect(err.code).toBe('ALIAS_PIN_MISMATCH');
  });

  it('keeps the bech32 prefix significant', () => {
    // cosmos1… and osmo1… are one key rendered for two chains. A pin naming
    // one has not verified the other.
    const osmo = convertBech32Prefix(ATOM, 'osmo')!;
    // Asserted, so the test cannot pass because the fixture failed to decode:
    // an undecodable string mismatches everything for the wrong reason.
    expect(decodeBech32Raw(osmo)).not.toBeNull();

    withBook({ validator: { target: 'validator.eth', pin: ATOM } });
    const err = failure(() => lookupAlias('validator').settle(osmo));
    expect(err.code).toBe('ALIAS_PIN_MISMATCH');
  });
});

describe('a book entry that cannot mean anything', () => {
  it('rejects a literal target that contradicts its own pin', () => {
    withBook({ treasury: { target: VITALIK, pin: STRANGER } });
    const err = failure(() => lookupAlias('treasury'));
    expect(err.code).toBe('BAD_CONFIG');
    expect(err.message).toContain('treasury');
  });

  it('rejects an entry object with no target', () => {
    withBook({ treasury: { pin: VITALIK } });
    expect(failure(() => lookupAlias('treasury')).code).toBe('BAD_CONFIG');
  });

  it('rejects a pin that is itself a name', () => {
    withBook({ treasury: { target: 'treasury.eth', pin: 'treasury.eth' } });
    const err = failure(() => lookupAlias('treasury'));
    expect(err.code).toBe('BAD_CONFIG');
    expect(err.hint).toContain('Pinning one name to another pins nothing');
  });

  it('rejects an empty pin instead of reading it as unpinned', () => {
    withBook({ treasury: { target: 'treasury.eth', pin: '   ' } });
    expect(failure(() => lookupAlias('treasury')).code).toBe('BAD_CONFIG');
  });

  it('rejects a value that is neither a string nor an entry', () => {
    withBook({ treasury: [VITALIK] });
    expect(failure(() => lookupAlias('treasury')).code).toBe('BAD_CONFIG');
  });

  it('checks only the entry being used, so an unrelated typo blocks nothing', () => {
    // A broken alias the command never mentions must not stop the command.
    withBook({ good: VITALIK, broken: { pin: STRANGER } });
    expect(lookupAlias('good').target).toBe(VITALIK);
  });
});

describe('sameAddress', () => {
  it('folds EVM hex and nothing else', () => {
    expect(sameAddress(VITALIK, VITALIK_LOWER)).toBe(true);
    expect(sameAddress(VITALIK, STRANGER)).toBe(false);
    expect(sameAddress(SOL, SOL.toLowerCase())).toBe(false);
  });

  it('refuses to guess about a format it does not recognize', () => {
    expect(sameAddress('not-an-address', 'NOT-AN-ADDRESS')).toBe(false);
    expect(sameAddress('not-an-address', 'not-an-address')).toBe(true);
  });
});

describe('the pin reaches the calls that act on an address', () => {
  it('stops `resolve` handing back a hijacked name', async () => {
    withBook({ treasury: { target: 'treasury.eth', pin: VITALIK } });
    ensHandler = () => STRANGER;
    const err = await asyncFailure(() => resolve('treasury'));
    expect(err.code).toBe('ALIAS_PIN_MISMATCH');
  });

  it('stops `portfolio` scanning a hijacked name', async () => {
    withBook({ treasury: { target: 'treasury.eth', pin: VITALIK } });
    ensHandler = () => STRANGER;
    const err = await asyncFailure(() => getPortfolio({ address: 'treasury', chains: ['ethereum'] }));
    expect(err.code).toBe('ALIAS_PIN_MISMATCH');
  });

  it('stops a repointed config file, with no name involved at all', async () => {
    withBook({ treasury: { target: STRANGER, pin: STRANGER } });
    expect((await resolve('treasury')).address).toBe(STRANGER);

    // The same alias, same pin, edited to point elsewhere.
    withBook({ treasury: { target: VITALIK, pin: STRANGER } });
    expect((await asyncFailure(() => resolve('treasury'))).code).toBe('BAD_CONFIG');
  });

  it('reports a pinned name that resolves to nothing, rather than throwing, in `resolve`', async () => {
    // `resolve` identifies; it never hands an address to anything. Saying
    // "pinned, resolved to nothing" is a better answer than an exception — and
    // it is still not a silent update.
    withBook({ treasury: { target: 'treasury.eth', pin: VITALIK } });
    ensHandler = () => null;
    const result = await resolve('treasury');
    expect(result.address).toBeUndefined();
    expect(result.note).toContain(VITALIK);
    expect(result.note).toContain('unchecked');
  });

  it('raises on the same alias in `portfolio`, which does act on the address', async () => {
    withBook({ treasury: { target: 'treasury.eth', pin: VITALIK } });
    ensHandler = () => null;
    const err = await asyncFailure(() => getPortfolio({ address: 'treasury', chains: ['ethereum'] }));
    expect(err.code).toBe('ALIAS_PIN_UNVERIFIED');
  });
});

describe('an expanded alias is visible in the answer', () => {
  it('names the alias and its pin when it verified', async () => {
    withBook({ treasury: { target: 'treasury.eth', pin: VITALIK } });
    ensHandler = () => VITALIK;
    const result = await resolve('treasury');
    expect(result.alias).toBe('treasury');
    expect(result.address).toBe(VITALIK);
    expect(result.note).toContain('matched its pin');
  });

  it('says an unpinned alias is followed wherever it points', async () => {
    withBook({ treasury: 'treasury.eth' });
    ensHandler = () => STRANGER;
    const result = await resolve('treasury');
    expect(result.alias).toBe('treasury');
    expect(result.address).toBe(STRANGER);
    expect(result.note).toContain('unpinned');
  });

  it('names the right risk for an unpinned literal address', async () => {
    // A name and a raw address are unpinned in different ways. "Followed
    // wherever it points" is true of the first and misleading about the second,
    // whose only exposure is the file it sits in.
    withBook({ treasury: VITALIK });
    const result = await resolve('treasury');
    expect(result.note).toContain('nothing here checks that against the address you saved');
    expect(result.note).not.toContain('wherever that name points');
  });

  it('says nothing about aliases when none was used', async () => {
    withBook({ treasury: VITALIK });
    const result = await resolve(VITALIK);
    expect(result.alias).toBeUndefined();
    expect(result.note).not.toContain('Address-book');
  });

  it('keeps the alias note alongside a reverse ENS name', async () => {
    withBook({ treasury: VITALIK });
    const result = await resolve('treasury', 'ethereum');
    expect(result.note).toContain('Address-book alias "treasury"');
  });
});

describe('chain lookup is unaffected', () => {
  it('still resolves chains with a book configured', () => {
    withBook({ treasury: VITALIK });
    expect(getChain('base').id).toBe('base');
  });
});
