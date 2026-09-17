import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The one write a read-only tool can stand behind.
 *
 * A burn has no receiving end, so unlike "send it to the treasury" there is no
 * key to trust and no custody to explain — and the effect is verifiable by
 * anyone afterwards, because supply is public. What it is not is reversible,
 * which is why most of what follows is about refusing to build something that
 * cannot land. Discovering a wrong assumption at signing time is too late when
 * the instruction destroys the tokens.
 */

const accounts = new Map<string, { data: Buffer } | null>();
const owners = new Map<string, string>();

const LEGACY_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

vi.mock('@solana/web3.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@solana/web3.js')>();

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

      async getLatestBlockhash() {
        return { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 100 };
      }
    },
  };
});

const { PublicKey, Transaction } = await import('@solana/web3.js');
const { buildBurn } = await import('../src/adapters/solana.js');
const { getChain } = await import('../src/core/registry.js');

const SOLANA = getChain('solana');
const MINT = 'So11111111111111111111111111111111111111112';
const OWNER = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const AUTHORITY = 'BqPUDmTYDq5Rns27kdrHjFfk9BsPv3aM5DCPsduzRECr';

function ata(programId = TOKEN_2022_PROGRAM): string {
  return PublicKey.findProgramAddressSync(
    [
      new PublicKey(OWNER).toBuffer(),
      new PublicKey(programId).toBuffer(),
      new PublicKey(MINT).toBuffer(),
    ],
    new PublicKey(ATA_PROGRAM),
  )[0].toBase58();
}

function baseMint(options: { mintAuthority?: string; decimals?: number } = {}): Buffer {
  const base = Buffer.alloc(82);
  if (options.mintAuthority) {
    base.writeUInt32LE(1, 0);
    new PublicKey(options.mintAuthority).toBuffer().copy(base, 4);
  }
  base.writeBigUInt64LE(1_000_000_000_000_000n, 36);
  base.writeUInt8(options.decimals ?? 6, 44);
  base.writeUInt8(1, 45);
  return base;
}

function extendedMint(
  base: Buffer,
  extensions: Array<{ type: number; data: Buffer }> = [],
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

/** A token account: mint, owner, the balance at 64, the state past the delegate. */
function tokenAccount(options: { amount: bigint; frozen?: boolean }): { data: Buffer } {
  const data = Buffer.alloc(165);
  new PublicKey(MINT).toBuffer().copy(data, 0);
  new PublicKey(OWNER).toBuffer().copy(data, 32);
  data.writeBigUInt64LE(options.amount, 64);
  data.writeUInt8(options.frozen ? 2 : 1, 108);
  return data.length ? { data } : { data };
}

function burn(amount = '1000') {
  return buildBurn(SOLANA, { owner: OWNER, mint: MINT, amount });
}

beforeEach(() => {
  accounts.clear();
  owners.clear();
});

describe('building a burn', () => {
  beforeEach(() => {
    accounts.set(MINT, extendedMint(baseMint()));
    accounts.set(ata(), tokenAccount({ amount: 5_000_000_000n }));
    owners.set(ata(), TOKEN_2022_PROGRAM);
  });

  it('sends BurnChecked to the program that owns the mint', async () => {
    const built = await burn();
    const instruction = Transaction.from(
      Buffer.from(built.payload.transaction as string, 'base64'),
    ).instructions[0]!;

    expect(instruction.programId.toBase58()).toBe(TOKEN_2022_PROGRAM);
    // BurnChecked is 15, then the amount, then the decimals the program checks
    // against the mint — the whole reason to use the checked variant.
    expect(instruction.data.readUInt8(0)).toBe(15);
    expect(instruction.data.readBigUInt64LE(1)).toBe(1_000_000_000n);
    expect(instruction.data.readUInt8(9)).toBe(6);
  });

  it('burns from the holder’s own account, with the holder signing', async () => {
    const built = await burn();
    const instruction = Transaction.from(
      Buffer.from(built.payload.transaction as string, 'base64'),
    ).instructions[0]!;

    expect(instruction.keys[0]?.pubkey.toBase58()).toBe(ata());
    expect(instruction.keys[1]?.pubkey.toBase58()).toBe(MINT);
    expect(instruction.keys[2]?.isSigner).toBe(true);
    expect(built.payload.feePayer).toBe(OWNER);
  });

  it('says what is left afterwards, and that none of it comes back', async () => {
    const built = await burn();
    const warnings = built.warnings.join(' ');

    expect(warnings).toMatch(/irreversible/i);
    expect(warnings).toMatch(/4000 of this mint/);
    expect(built.summary).toContain('So1111…1112');
  });

  it('keeps the mint name out of the summary entirely', async () => {
    // Give the mint a name, then check it does not appear. Nothing read off the
    // chain is interpolated into a summary, and a burn is the last place to
    // start: the summary is the line a wallet shows before an irreversible
    // signature, so a mint called "Confirm to claim your airdrop" would be
    // reading its own instructions to the person about to sign.
    accounts.set(
      MINT,
      extendedMint(baseMint(), [
        {
          type: 19,
          data: Buffer.concat([
            Buffer.alloc(32),
            new PublicKey(MINT).toBuffer(),
            Buffer.from([17, 0, 0, 0]),
            Buffer.from('Singularity-Agent'),
          ]),
        },
      ]),
    );

    const built = await burn();

    expect(built.summary).toContain('So1111…1112');
    expect(built.summary).not.toMatch(/Singularity-Agent/);
  });
});

describe('what it refuses to build', () => {
  it('refuses when the holder has no token account for the mint', async () => {
    accounts.set(MINT, extendedMint(baseMint()));

    await expect(burn()).rejects.toThrow(/holds no token account/i);
  });

  it('refuses a frozen account, and names why', async () => {
    accounts.set(MINT, extendedMint(baseMint()));
    accounts.set(ata(), tokenAccount({ amount: 5_000_000_000n, frozen: true }));

    // A frozen account cannot burn, so this transaction would fail on
    // submission after the user had already approved destroying their tokens.
    await expect(burn()).rejects.toThrow(/frozen/i);
  });

  it('refuses a burn larger than the balance, quoting the balance', async () => {
    accounts.set(MINT, extendedMint(baseMint()));
    accounts.set(ata(), tokenAccount({ amount: 5_000_000n }));

    await expect(burn('1000')).rejects.toThrow(/holds 5 and the burn asks for 1000/);
  });

  it('refuses an amount that rounds away to nothing', async () => {
    accounts.set(MINT, extendedMint(baseMint()));
    accounts.set(ata(), tokenAccount({ amount: 5_000_000_000n }));

    // Anything finer than the mint's decimals is already refused upstream by
    // parseUnits, which is the stricter answer. This is the case that reaches
    // here: a well-formed amount that is simply zero.
    await expect(burn('0')).rejects.toThrow(/destroy nothing/i);
  });
});

describe('whether the burn means anything', () => {
  it('warns when the mint can still print more', async () => {
    accounts.set(MINT, extendedMint(baseMint({ mintAuthority: AUTHORITY })));
    accounts.set(ata(), tokenAccount({ amount: 5_000_000_000n }));

    const built = await burn();

    // The distinction the whole idea rests on. Against a live mint authority a
    // burn reduces one balance and the supply can be put straight back, so
    // "deflationary" is a claim about somebody's restraint, not about the chain.
    expect(built.warnings.join(' ')).toMatch(/without permanently reducing supply/i);
    expect(built.warnings.join(' ')).toContain(AUTHORITY);
  });

  it('says nothing of the sort when the authority is revoked', async () => {
    accounts.set(MINT, extendedMint(baseMint()));
    accounts.set(ata(), tokenAccount({ amount: 5_000_000_000n }));

    const built = await burn();

    // The positive half: a mint that has given up the authority gets a clean
    // payload rather than a warning it has not earned.
    expect(built.warnings.join(' ')).not.toMatch(/reducing supply/i);
  });

  it('warns that a permanent delegate could have done this anyway', async () => {
    accounts.set(
      MINT,
      extendedMint(baseMint(), [{ type: 12, data: new PublicKey(AUTHORITY).toBuffer() }]),
    );
    accounts.set(ata(), tokenAccount({ amount: 5_000_000_000n }));

    const built = await burn();

    expect(built.warnings.join(' ')).toMatch(/permanent delegate/i);
  });

  it('builds a legacy mint against the legacy program', async () => {
    accounts.set(MINT, { data: baseMint() });
    owners.set(MINT, LEGACY_PROGRAM);
    accounts.set(ata(LEGACY_PROGRAM), tokenAccount({ amount: 5_000_000_000n }));
    owners.set(ata(LEGACY_PROGRAM), LEGACY_PROGRAM);

    const built = await burn();
    const instruction = Transaction.from(
      Buffer.from(built.payload.transaction as string, 'base64'),
    ).instructions[0]!;

    expect(instruction.programId.toBase58()).toBe(LEGACY_PROGRAM);
    expect(instruction.keys[0]?.pubkey.toBase58()).toBe(ata(LEGACY_PROGRAM));
  });
});
