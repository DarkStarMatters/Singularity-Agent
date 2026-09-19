import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createSingularity, assertWritable, isSigner, SIGNER_REQUIRED } from '../src/index.js';
import type { ChainSpec, SignedTx, Signer, UnsignedTx } from '../src/index.js';
import { SdkError } from '../src/errors.js';

/**
 * The custody boundary, tested as a property of the source rather than a
 * sentence in a comment.
 *
 * "This SDK ships no signer" is the kind of guarantee this repository has
 * learned not to leave in prose — the roadmap's whole corollary is that a
 * guarantee living in a comment gets violated by code that type-checks. So the
 * first test reads the published source and fails if a signing primitive
 * appears in it, and the rest check the gates around the seam.
 */

const SRC = resolve(__dirname, '..', 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(join(dir, entry.name))
      : entry.name.endsWith('.ts')
        ? [join(dir, entry.name)]
        : [],
  );
}

/** Strip comments, so the long explanation in `signer.ts` is not evidence. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/**
 * Each pattern is a thing that cannot appear in a package that does not sign.
 * If one ever legitimately needs to be here, that is a decision taken
 * deliberately — by editing this list, in a diff someone reviews — and not by
 * adding an import.
 */
const BANNED: Array<[RegExp, string]> = [
  [/\bprivateKey\b/i, 'a private key'],
  [/\bsecretKey\b/i, 'a secret key'],
  [/\bmnemonic\b/i, 'a mnemonic'],
  [/\bseedPhrase\b/i, 'a seed phrase'],
  [/\bKeypair\b/, 'a keypair type'],
  [/\bfromSecret/i, 'a secret loader'],
  [/privateKeyToAccount/, 'viem key derivation'],
  [/\bsignTransaction\b/, 'a transaction signer'],
  [/\bsendRawTransaction\b/, 'a raw broadcast'],
  [/\bsendTransaction\b/, 'a broadcast'],
  [/process\.env\.[A-Z_]*(KEY|SECRET|SEED|MNEMONIC)/, 'a secret read from the environment'],
];

function scan(body: string): string[] {
  return BANNED.filter(([pattern]) => pattern.test(code(body))).map(([, what]) => what);
}

describe('the SDK holds no keys', () => {
  it('contains no signing or key-handling primitive anywhere in src/', () => {
    const offences: string[] = [];

    for (const file of sourceFiles(SRC)) {
      for (const what of scan(readFileSync(file, 'utf8'))) {
        offences.push(`${file.slice(SRC.length + 1)} contains ${what}`);
      }
    }

    expect(offences, offences.join('\n')).toEqual([]);
  });

  /**
   * The test above passes on a clean tree, which is exactly what it would do if
   * the scanner were broken. This repository shipped an X filter that passed 41
   * tests while dropping three quarters of the messages it was supposed to let
   * through, because every one of them measured what it *blocked*. So: plant
   * each thing the scanner is meant to find, and confirm it finds it.
   */
  it('the scanner actually catches what it claims to', () => {
    const planted: Array<[string, string]> = [
      ['const privateKey = "0xabc";', 'a private key'],
      ['const secretKey = bytes;', 'a secret key'],
      ['const mnemonic = words.join(" ");', 'a mnemonic'],
      ['const seedPhrase = input;', 'a seed phrase'],
      ['const kp = Keypair.fromSeed(seed);', 'a keypair type'],
      ['const account = privateKeyToAccount(key);', 'viem key derivation'],
      ['await wallet.signTransaction(tx);', 'a transaction signer'],
      ['await client.sendRawTransaction(raw);', 'a raw broadcast'],
      ['const key = process.env.WALLET_SECRET;', 'a secret read from the environment'],
    ];

    for (const [snippet, expected] of planted) {
      expect(scan(snippet), `missed: ${snippet}`).toContain(expected);
    }
  });

  it('does not fire on the prose that explains why none of this is here', () => {
    // `signer.ts` names every one of these words while shipping none of them.
    // A scanner that cannot tell a comment from code would fail the suite on
    // the file that documents the boundary, and the fix would be to delete the
    // documentation.
    const signerSource = readFileSync(join(SRC, 'signer.ts'), 'utf8');

    // Comment reflow means the prose is line-wrapped; flatten before matching.
    const prose = signerSource.replace(/\s*\n\s*\*?\s*/g, ' ');
    expect(prose).toMatch(/no keypair loader/i);
    expect(prose).toMatch(/fromPrivateKey/);

    expect(scan(signerSource)).toEqual([]);
  });

  it('declares no cryptography or wallet dependency', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(__dirname, '..', 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string>; peerDependencies?: Record<string, string> };

    const deps = Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies });
    const suspicious = deps.filter((name) =>
      /wallet|keypair|signer|ethers|bip39|bip32|tweetnacl|secp256k1|ed25519|hdkey|keyring/i.test(name),
    );

    expect(suspicious, `unexpected dependency: ${suspicious.join(', ')}`).toEqual([]);
  });
});

describe('write is gated on a signer', () => {
  it('leaves `write` as the stand-in when none was configured', () => {
    const sdk = createSingularity({ chain: 'ethereum' });

    // The compile-time gate is the real one — `sdk.write.transfer(…)` does not
    // typecheck on this client. This is its runtime shadow, for JavaScript.
    expect(sdk.write).toBe(SIGNER_REQUIRED);
    expect((sdk.write as unknown as Record<string, unknown>)['transfer']).toBeUndefined();
  });

  it('assertWritable refuses a read-only client, with the fix in the hint', () => {
    const sdk = createSingularity({ chain: 'ethereum' });

    try {
      assertWritable(sdk);
      expect.unreachable('a read-only client should not assert writable');
    } catch (err) {
      expect(err).toBeInstanceOf(SdkError);
      expect((err as SdkError).code).toBe('NO_SIGNER');
      expect((err as SdkError).hint).toMatch(/ships no signer implementation/);
    }
  });

  it('build works without a signer, because building is a read', () => {
    const sdk = createSingularity({ chain: 'ethereum' });
    expect(typeof sdk.build.transfer).toBe('function');
    expect(typeof sdk.build.burn).toBe('function');
  });

  it('recognises a real signer and not a plausible-looking object', () => {
    expect(isSigner({ families: ['evm'], sign: () => {}, address: () => {} })).toBe(true);
    expect(isSigner({ families: ['evm'], sign: () => {} })).toBe(false);
    expect(isSigner({ sign: () => {}, address: () => {} })).toBe(false);
    expect(isSigner(null)).toBe(false);
    expect(isSigner('signer')).toBe(false);
  });
});

/** A signer that records what it was asked and returns what it is told to. */
function stubSigner(overrides: Partial<Signer> & { signedChain?: string } = {}): Signer & {
  signed: UnsignedTx[];
  sent: SignedTx[];
} {
  const signed: UnsignedTx[] = [];
  const sent: SignedTx[] = [];

  const base: Signer = {
    families: overrides.families ?? ['evm'],
    async address() {
      return '0x0000000000000000000000000000000000000001';
    },
    async sign(tx: UnsignedTx, chain: ChainSpec): Promise<SignedTx> {
      signed.push(tx);
      return {
        chain: overrides.signedChain ?? chain.id,
        family: chain.family,
        raw: '0xdeadbeef',
        encoding: 'hex',
      };
    },
  };

  const signer: Signer = overrides.send
    ? { ...base, send: overrides.send }
    : base;

  return Object.assign(signer, { signed, sent });
}

describe('the pipeline between a built payload and a network', () => {
  it('refuses a chain the signer does not claim, before building anything', async () => {
    const signer = stubSigner({ families: ['evm'] });
    const sdk = createSingularity({ chain: 'solana', signer });

    await expect(
      sdk.write.burn({ mint: 'So11111111111111111111111111111111111111112', amount: '1' }),
    ).rejects.toMatchObject({ code: 'SIGNER_WRONG_FAMILY' });

    // The point of checking first: nothing was built and nothing was signed.
    expect(signer.signed).toHaveLength(0);
  });

  it('names both families in the refusal, so the fix is obvious', async () => {
    const sdk = createSingularity({ chain: 'ethereum', signer: stubSigner({ families: ['svm'] }) });

    await expect(sdk.write.transfer({ to: 'vitalik.eth', amount: '1' })).rejects.toThrow(
      /handles svm, and Ethereum is evm/,
    );
  });

  it('refuses to report success when the signer signed for a different chain', async () => {
    // The worst bug this file can catch: a valid signature over a payload
    // built for somewhere else. It produces a perfectly good transaction.
    const signer = stubSigner({ families: ['evm'], signedChain: 'base' });
    const send = vi.fn();
    const sdk = createSingularity({
      chain: 'ethereum',
      signer: Object.assign(signer, { send }),
    });

    const unsigned: UnsignedTx = {
      chain: 'ethereum',
      family: 'evm',
      payload: {},
      encoding: 'hex',
    } as unknown as UnsignedTx;

    await expect(sdk.write.submit(unsigned, 'ethereum')).rejects.toMatchObject({
      code: 'SIGNER_CHAIN_MISMATCH',
    });

    // And critically: it was not broadcast.
    expect(send).not.toHaveBeenCalled();
  });

  it('returns broadcast:false rather than a receipt that reads like success', async () => {
    const signer = stubSigner({ families: ['evm'] }); // no `send`
    const sdk = createSingularity({ chain: 'ethereum', signer });

    const unsigned = { chain: 'ethereum', family: 'evm' } as unknown as UnsignedTx;
    const receipt = await sdk.write.submit(unsigned, 'ethereum');

    expect(receipt.broadcast).toBe(false);
    expect(receipt.hash).toBeUndefined();
    expect(receipt.signed.raw).toBe('0xdeadbeef');
    // The unsigned payload is kept, so an application can show what was signed.
    expect(receipt.unsigned).toBe(unsigned);
  });

  it('broadcasts through the signer, never through the SDK', async () => {
    const send = vi.fn(async () => '0xabc');
    const signer = stubSigner({ families: ['evm'], send });
    const sdk = createSingularity({ chain: 'ethereum', signer });

    const unsigned = { chain: 'ethereum', family: 'evm' } as unknown as UnsignedTx;
    const receipt = await sdk.write.submit(unsigned, 'ethereum');

    expect(send).toHaveBeenCalledOnce();
    expect(receipt.broadcast).toBe(true);
    expect(receipt.hash).toBe('0xabc');
  });
});
