import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * What a mint account permits.
 *
 * The questions people actually ask about a token — can more be printed, can my
 * account be frozen, can somebody take these out of my wallet, can the name
 * change after I buy — are all answerable from one account read, and are
 * answered almost nowhere. A wallet shows a balance and a ticker; the ticker is
 * a string the deployer chose, and every one of those powers is a field sitting
 * next to it.
 *
 * Both halves are asserted throughout, because this is a gate like any other.
 * A mint that can do something gets it named with the address holding it, and a
 * mint that can do none of it gets a clean answer rather than invented hazards —
 * the second half is where these things usually fail.
 */

const accounts = new Map<string, { data: Buffer } | null>();
const owners = new Map<string, string>();
let metadataFails: string | null = null;

const LEGACY_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

vi.mock('@solana/web3.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@solana/web3.js')>();
  const METADATA_PROGRAM_ID = new actual.PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

  return {
    ...actual,
    Connection: class {
      async getAccountInfo(key: { toBase58(): string }) {
        const account = accounts.get(key.toBase58());
        if (!account) return null;
        return {
          ...account,
          owner: new actual.PublicKey(owners.get(key.toBase58()) ?? TOKEN_2022_PROGRAM),
        };
      }

      async getMultipleAccountsInfo(keys: Array<{ toBase58(): string }>) {
        if (metadataFails) throw new Error(metadataFails);
        return keys.map((key) => {
          const direct = accounts.get(key.toBase58());
          if (direct) return direct;
          // Re-derive each known mint's Metaplex PDA, so the derivation itself
          // is exercised rather than trusted.
          for (const [address, account] of accounts) {
            let pda;
            try {
              pda = actual.PublicKey.findProgramAddressSync(
                [
                  Buffer.from('metadata'),
                  METADATA_PROGRAM_ID.toBuffer(),
                  new actual.PublicKey(address).toBuffer(),
                ],
                METADATA_PROGRAM_ID,
              )[0];
            } catch {
              continue;
            }
            if (pda.toBase58() === key.toBase58()) return metaplexAccounts.get(address) ?? null;
          }
          return null;
        });
      }
    },
  };
});

/** Metaplex metadata accounts, keyed by the mint they belong to. */
const metaplexAccounts = new Map<string, { data: Buffer }>();

const { PublicKey } = await import('@solana/web3.js');
const { auditMint } = await import('../src/adapters/solana.js');
const { getChain } = await import('../src/core/registry.js');

const SOLANA = getChain('solana');
const MINT = 'So11111111111111111111111111111111111111112';
const REAL_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const AUTHORITY = 'BqPUDmTYDq5Rns27kdrHjFfk9BsPv3aM5DCPsduzRECr';

function borshString(text: string): Buffer {
  const bytes = Buffer.from(text, 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32LE(bytes.length, 0);
  return Buffer.concat([length, bytes]);
}

/** A `TokenMetadata` record: update authority, mint, then name, symbol, uri. */
function tokenMetadata(options: {
  mint: string;
  name: string;
  symbol: string;
  uri?: string;
  updateAuthority?: string;
}): Buffer {
  return Buffer.concat([
    options.updateAuthority
      ? new PublicKey(options.updateAuthority).toBuffer()
      : Buffer.alloc(32),
    new PublicKey(options.mint).toBuffer(),
    borshString(options.name),
    borshString(options.symbol),
    borshString(options.uri ?? 'https://example.test/token.json'),
    Buffer.alloc(4),
  ]);
}

/** A Metaplex account, for the legacy mints whose text lives in a PDA. */
function metaplexAccount(name: string, symbol: string) {
  const padded = (text: string, size: number) => {
    const buffer = Buffer.alloc(4 + size);
    buffer.writeUInt32LE(size, 0);
    buffer.write(text, 4, 'utf8');
    return buffer;
  };
  return {
    data: Buffer.concat([
      Buffer.alloc(1 + 32 + 32),
      padded(name, 32),
      padded(symbol, 10),
      padded('https://example.test/legacy.json', 200),
    ]),
  };
}

/**
 * The 82-byte base mint: a mint-authority option, the supply, decimals, the
 * initialized flag, then a freeze-authority option.
 */
function baseMint(options: {
  mintAuthority?: string;
  freezeAuthority?: string;
  decimals?: number;
  supply?: bigint;
}): Buffer {
  const base = Buffer.alloc(82);
  if (options.mintAuthority) {
    base.writeUInt32LE(1, 0);
    new PublicKey(options.mintAuthority).toBuffer().copy(base, 4);
  }
  base.writeBigUInt64LE(options.supply ?? 1_000_000_000_000_000n, 36);
  base.writeUInt8(options.decimals ?? 6, 44);
  base.writeUInt8(1, 45);
  if (options.freezeAuthority) {
    base.writeUInt32LE(1, 46);
    new PublicKey(options.freezeAuthority).toBuffer().copy(base, 50);
  }
  return base;
}

/** A Token-2022 mint: the base record padded to 165, a type byte, then TLV. */
function extendedMint(
  base: Buffer,
  extensions: Array<{ type: number; data: Buffer }>,
): { data: Buffer } {
  const padded = Buffer.alloc(165);
  base.copy(padded, 0);
  const tlv = extensions.map(({ type, data }) => {
    const header = Buffer.alloc(4);
    header.writeUInt16LE(type, 0);
    header.writeUInt16LE(data.length, 2);
    return Buffer.concat([header, data]);
  });
  return { data: Buffer.concat([padded, Buffer.from([1]), ...tlv]) };
}

beforeEach(() => {
  accounts.clear();
  owners.clear();
  metaplexAccounts.clear();
  metadataFails = null;
});

describe('a mint that has given up its powers', () => {
  beforeEach(() => {
    accounts.set(
      MINT,
      extendedMint(baseMint({ supply: 999_999_999_999_999n }), [
        { type: 18, data: Buffer.concat([Buffer.alloc(32), new PublicKey(MINT).toBuffer()]) },
        {
          type: 19,
          data: tokenMetadata({
            mint: MINT,
            name: 'Singularity-Agent',
            symbol: 'SNGLRTY',
            uri: 'https://ipfs.io/ipfs/bafkreic4zvquoxh7jhkzlgxuhvsubnisl3dnwh5qyrmhijd7rbzzz3gtdq',
          }),
        },
      ]),
    );
  });

  it('says what is permanently closed off, rather than only what is wrong', async () => {
    const audit = await auditMint(SOLANA, MINT);

    expect(audit.powers).toEqual([]);
    expect(audit.settled.join(' ')).toMatch(/Supply is fixed/);
    expect(audit.settled.join(' ')).toMatch(/No account can be frozen/);
    expect(audit.settled.join(' ')).toMatch(/name and ticker are immutable/);
  });

  it('reports the program that owns the mint, not a version number', async () => {
    const audit = await auditMint(SOLANA, MINT);

    // They are different programs, and which one owns a mint decides how a
    // transfer of it has to be built.
    expect(audit.program).toBe('token-2022');
    expect(audit.supply.formatted).toBe('999999999.999999');
    expect(audit.supply.symbol).toBe('SNGLRTY');
  });

  it('marks the text and carries the link without fetching it', async () => {
    const audit = await auditMint(SOLANA, MINT);

    expect(audit.metadata?.untrusted).toBe(true);
    // Free text, so it survives past the 48-character ticker cap intact.
    expect(audit.metadata?.uri?.text).toMatch(/bafkreic4zvquoxh7jhkzlgxuhvsubnisl3dnwh5qyrmhijd7rbzzz3gtdq$/);
    expect(audit.metadata?.uri?.untrusted).toBe(true);
    expect(audit.note).toMatch(/not fetched/i);
  });

  it('lists the extensions it found by name', async () => {
    const audit = await auditMint(SOLANA, MINT);

    expect(audit.extensions).toEqual(['metadataPointer', 'tokenMetadata']);
  });
});

describe('a mint that has kept them', () => {
  it('names every power and the address holding it', async () => {
    accounts.set(
      MINT,
      extendedMint(baseMint({ mintAuthority: AUTHORITY, freezeAuthority: AUTHORITY }), [
        { type: 3, data: new PublicKey(AUTHORITY).toBuffer() },
        { type: 12, data: new PublicKey(AUTHORITY).toBuffer() },
      ]),
    );

    const audit = await auditMint(SOLANA, MINT);
    const byKind = new Map(audit.powers.map((power) => [power.kind, power]));

    expect(byKind.get('mint')?.holder).toBe(AUTHORITY);
    expect(byKind.get('freeze')?.holder).toBe(AUTHORITY);
    expect(byKind.get('close-mint')?.holder).toBe(AUTHORITY);
    // The one nobody expects: an address that can move the token out of a
    // wallet that never signed anything.
    expect(byKind.get('permanent-delegate')?.holder).toBe(AUTHORITY);
    expect(audit.settled).toEqual([]);
  });

  it('reports a live metadata authority as a power, not a footnote', async () => {
    accounts.set(
      MINT,
      extendedMint(baseMint({}), [
        {
          type: 19,
          data: tokenMetadata({
            mint: MINT,
            name: 'Honest Today',
            symbol: 'HONEST',
            updateAuthority: AUTHORITY,
          }),
        },
      ]),
    );

    const audit = await auditMint(SOLANA, MINT);
    const power = audit.powers.find((entry) => entry.kind === 'metadata-update');

    // Same address, different name tomorrow. This is the quietest of the lot.
    expect(power?.holder).toBe(AUTHORITY);
    expect(audit.settled.join(' ')).not.toMatch(/immutable/);
  });

  it('tells a configured transfer hook apart from an empty one', async () => {
    const withProgram = Buffer.concat([
      new PublicKey(AUTHORITY).toBuffer(),
      new PublicKey(REAL_USDC).toBuffer(),
    ]);
    accounts.set(MINT, extendedMint(baseMint({}), [{ type: 14, data: withProgram }]));

    const configured = await auditMint(SOLANA, MINT);
    expect(configured.powers.find((p) => p.kind === 'transfer-hook')?.what).toContain(REAL_USDC);

    accounts.set(
      MINT,
      extendedMint(baseMint({}), [
        { type: 14, data: Buffer.concat([new PublicKey(AUTHORITY).toBuffer(), Buffer.alloc(32)]) },
      ]),
    );

    const empty = await auditMint(SOLANA, MINT);
    // PYUSD's actual shape. Saying "every transfer calls a program" here would
    // be false about several large stablecoins — the power is real, what it
    // does today is not the same sentence.
    expect(empty.powers.find((p) => p.kind === 'transfer-hook')?.what).toMatch(/no hook program is set/i);
  });

  it('only flags a default account state that actually freezes', async () => {
    accounts.set(
      MINT,
      extendedMint(baseMint({}), [{ type: 6, data: Buffer.from([1]) }]),
    );
    const initialized = await auditMint(SOLANA, MINT);
    // State 1 is the ordinary initialized state and means nothing at all.
    expect(initialized.powers.find((p) => p.kind === 'default-frozen')).toBeUndefined();
    expect(initialized.extensions).toContain('defaultAccountState');

    accounts.set(MINT, extendedMint(baseMint({}), [{ type: 6, data: Buffer.from([2]) }]));
    const frozen = await auditMint(SOLANA, MINT);
    expect(frozen.powers.find((p) => p.kind === 'default-frozen')).toBeDefined();
  });

  it('keeps an extension it cannot describe, by id', async () => {
    accounts.set(MINT, extendedMint(baseMint({}), [{ type: 200, data: Buffer.alloc(8) }]));

    const audit = await auditMint(SOLANA, MINT);

    // An unrecognized extension is kept for the same reason an unrecognized log
    // keeps its topic: a short list reads as a short list of what is there.
    expect(audit.extensions).toEqual(['extension 200']);
    expect(audit.completeness.note).toMatch(/no description in this tool/i);
  });
});

describe('legacy mints and non-mints', () => {
  it('audits an SPL Token mint, reading its name from the Metaplex account', async () => {
    accounts.set(MINT, { data: baseMint({ mintAuthority: AUTHORITY }) });
    owners.set(MINT, LEGACY_PROGRAM);
    metaplexAccounts.set(MINT, metaplexAccount('Wrapped SOL', 'wSOL'));

    const audit = await auditMint(SOLANA, MINT);

    expect(audit.program).toBe('spl-token');
    expect(audit.metadata?.symbol).toBe('wSOL');
    // No extensions exist under the legacy program, and an empty list here is
    // a fact rather than a gap.
    expect(audit.extensions).toEqual([]);
  });

  it('refuses an account owned by something that is not a token program', async () => {
    accounts.set(MINT, { data: baseMint({}) });
    owners.set(MINT, '11111111111111111111111111111111');

    // An account can look exactly like a mint and be something else; the owning
    // program is the only thing that settles it.
    await expect(auditMint(SOLANA, MINT)).rejects.toThrow(/not a token program/i);
  });

  it('refuses an account too short to be a mint', async () => {
    accounts.set(MINT, { data: Buffer.alloc(20) });

    await expect(auditMint(SOLANA, MINT)).rejects.toThrow(/not an SPL mint/i);
  });
});

describe('what the audit says about itself', () => {
  it('runs the impersonation check on a name the deployer chose', async () => {
    accounts.set(
      MINT,
      extendedMint(baseMint({}), [
        { type: 19, data: tokenMetadata({ mint: MINT, name: 'Definitely Real', symbol: 'USDC' }) },
      ]),
    );

    const audit = await auditMint(SOLANA, MINT);

    expect(audit.impersonation?.kind).toBe('curated-token');
    expect(audit.impersonation?.authentic).toBe(REAL_USDC);
  });

  it('says when the metadata could not be read instead of reporting no name', async () => {
    accounts.set(MINT, extendedMint(baseMint({ mintAuthority: AUTHORITY }), []));
    metadataFails = 'connection reset';

    const audit = await auditMint(SOLANA, MINT);

    // The powers really are complete — they came off the account already read —
    // so the kind stays exhaustive and the gap is named precisely.
    expect(audit.completeness.kind).toBe('exhaustive');
    expect(audit.completeness.note).toMatch(/connection reset/);
    expect(audit.completeness.note).toMatch(/not absent/);
    expect(audit.powers.find((p) => p.kind === 'mint')).toBeDefined();
  });

  it('refuses to turn any of it into a verdict', async () => {
    accounts.set(MINT, extendedMint(baseMint({}), []));

    const audit = await auditMint(SOLANA, MINT);

    // Deliberately absent: a score, a grade, a boolean called safe. Liquidity,
    // holder concentration and the deployer's next move are not in these bytes,
    // and a verdict implying otherwise is the one wrong answer that matters.
    expect(audit).not.toHaveProperty('safe');
    expect(audit).not.toHaveProperty('score');
    expect(audit.note).toMatch(/not a verdict/i);
  });
});
