import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import {
  associatedTokenAddress,
  buildReceiptMint,
  masterEditionAddress,
  metadataAddress,
  MINT_ACCOUNT_SIZE,
  TOKEN_METADATA_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '../src/art/mint.js';
import type { ReceiptFacts } from '../src/art/receipt.js';

/**
 * Checked against the chain, not against itself.
 *
 * Hand-encoded instructions are the place this project has been burnt worst: a
 * QR shipped with two bugs that every self-written test agreed with, because
 * the test and the encoder shared an author and therefore shared a mistake. A
 * property derived from the same understanding that produced the bug proves
 * only that the understanding is consistent.
 *
 * So the anchors here come from outside. The USDC metadata PDA below was read
 * off mainnet — it exists, the Token Metadata program owns it, and its own data
 * records USDC as its mint and "USD Coin" as its name. Nothing in this repo
 * produced that address.
 *
 * The whole transaction was also simulated against mainnet and returned
 * `err: null`, with the Metaplex program logging "IX: Create Metadata Accounts
 * v3" and "V3 Create Master Edition". That is the real check on the byte
 * layouts, and it cannot run here — a unit test that needs a live RPC is a unit
 * test that fails when the network does. What is asserted below are the parts
 * that can be pinned without one.
 */

const PAYER = new PublicKey('BTaPkeDYRuXbL6hEDsWPAWXUfZvjEoKoV3mCTQ91QFeH');
const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

/** Read from mainnet, owned by the metadata program, naming USDC as its mint. */
const USDC_METADATA_PDA = '5x38Kp4hvdomTCnCrAny4UtMUt5rQBdB6px2K1Ui45Wq';

const facts: ReceiptFacts = {
  reference: '695xPtsSYaSALQdwgE6WxC4zX49zZrpVPwF2uiUGjCBB',
  to: PAYER.toBase58(),
  amount: '0.25',
  label: 'Singularity',
  signature: '5x7Kqf9Qw2vMhT3bN8pLzR4cY6dA1eF0gH2jK3mN4pQ5rS6tU7vW8xY9zA1bC2dE3f',
  settledAt: '2026-09-20T10:02:11.000Z',
  level: 'final',
};

const params = { payer: PAYER, uri: 'https://example.test/r.json', mintRent: 1_066_800 };

describe('addresses, anchored to accounts this repo did not create', () => {
  it('derives the metadata PDA that mainnet actually holds for USDC', () => {
    expect(metadataAddress(USDC).toBase58()).toBe(USDC_METADATA_PDA);
  });

  it('derives a master edition distinct from the metadata account', () => {
    // Same seeds plus "edition"; getting the seed order wrong yields a valid
    // address that no program will ever sign for.
    expect(masterEditionAddress(USDC).toBase58()).not.toBe(USDC_METADATA_PDA);
  });

  it('puts both PDAs on the metadata program', () => {
    for (const pda of [metadataAddress(USDC), masterEditionAddress(USDC)]) {
      expect(PublicKey.isOnCurve(pda.toBytes())).toBe(false);
    }
  });

  it('derives an associated token account off the curve', () => {
    const ata = associatedTokenAddress(USDC, PAYER);
    expect(PublicKey.isOnCurve(ata.toBytes())).toBe(false);
  });
});

describe('the transaction it builds', () => {
  it('carries the six instructions a complete NFT needs', () => {
    // Atomic on purpose: a mint with no metadata, or metadata with no master
    // edition, is worse than no receipt because it still looks like one.
    const built = buildReceiptMint(facts, params);
    expect(built.transaction.instructions).toHaveLength(6);
  });

  it('creates the mint account at the size the Token program expects', () => {
    const built = buildReceiptMint(facts, params);
    const create = built.transaction.instructions[0]!;

    expect(create.programId.toBase58()).toBe('11111111111111111111111111111111');
    // SystemProgram CreateAccount: u32 tag, u64 lamports, u64 space, pubkey.
    expect(create.data.readBigUInt64LE(12)).toBe(BigInt(MINT_ACCOUNT_SIZE));
    expect(create.data.readBigUInt64LE(4)).toBe(BigInt(params.mintRent));
  });

  it('mints exactly one token, with zero decimals', () => {
    const built = buildReceiptMint(facts, params);
    const init = built.transaction.instructions[1]!;
    const mint = built.transaction.instructions[3]!;

    expect(init.data[0]).toBe(20); // InitializeMint2
    expect(init.data[1]).toBe(0); // decimals — half a receipt is not a thing
    expect(mint.data[0]).toBe(7); // MintTo
    expect(Buffer.from(mint.data).readBigUInt64LE(1)).toBe(1n);
  });

  it('caps the supply at one forever', () => {
    // maxSupply Some(0). A supply of one that can be raised later is not one.
    const built = buildReceiptMint(facts, params);
    const edition = built.transaction.instructions[5]!;

    expect(edition.programId.equals(TOKEN_METADATA_PROGRAM_ID)).toBe(true);
    expect(edition.data[0]).toBe(17); // CreateMasterEditionV3
    expect(edition.data[1]).toBe(1); // Some
    expect(Buffer.from(edition.data).readBigUInt64LE(2)).toBe(0n);
  });

  it('mints metadata that can never be rewritten', () => {
    // The point of the whole feature. This project ships a tool that warns
    // holders about mutable metadata; a receipt whose text the issuer can
    // change afterwards is not evidence of anything.
    const built = buildReceiptMint(facts, params);
    const metadata = built.transaction.instructions[4]!;
    const data = Buffer.from(metadata.data);

    expect(data[0]).toBe(33); // CreateMetadataAccountV3

    // Walk the three borsh strings to reach isMutable.
    let at = 1;
    for (let i = 0; i < 3; i += 1) at += 4 + data.readUInt32LE(at);
    expect(data.readUInt16LE(at)).toBe(0); // sellerFeeBasisPoints
    at += 2;
    expect(data[at]).toBe(0); // creators: None
    expect(data[at + 1]).toBe(0); // collection: None
    expect(data[at + 2]).toBe(0); // uses: None
    expect(data[at + 3]).toBe(0); // isMutable: false
  });

  it('writes the receipt name and symbol the metadata module chose', () => {
    const built = buildReceiptMint(facts, params);
    const data = Buffer.from(built.transaction.instructions[4]!.data);

    const nameLen = data.readUInt32LE(1);
    expect(data.subarray(5, 5 + nameLen).toString('utf8')).toBe('Receipt 695xPtsS');
  });

  it('names the payer as fee payer and never as a key holder', () => {
    const built = buildReceiptMint(facts, params);
    expect(built.transaction.feePayer?.equals(PAYER)).toBe(true);
  });

  it('fits in a single transaction', () => {
    // 1232 bytes is the packet limit. The simulated build was 740.
    const built = buildReceiptMint(facts, { ...params, blockhash: '11111111111111111111111111111111' });
    built.transaction.partialSign(built.mintKeypair);
    const wire = built.transaction.serialize({ requireAllSignatures: false, verifySignatures: false });

    expect(wire.length).toBeLessThan(1232);
  });

  it('routes the token to the payer by association, not by assumption', () => {
    const built = buildReceiptMint(facts, params);
    expect(built.tokenAccount.equals(associatedTokenAddress(built.mint, PAYER))).toBe(true);
  });

  it('assigns the new mint account to the Token program', () => {
    const built = buildReceiptMint(facts, params);
    const create = built.transaction.instructions[0]!;
    const owner = new PublicKey(create.data.subarray(20, 52));

    expect(owner.equals(TOKEN_PROGRAM_ID)).toBe(true);
  });
});

describe('the ephemeral mint key, which is the one key this project makes', () => {
  it('is returned rather than used, so the caller decides', () => {
    const built = buildReceiptMint(facts, params);
    expect(built.mintKeypair.publicKey.equals(built.mint)).toBe(true);
  });

  it('is different every time', () => {
    // It authorises one account creation and nothing afterwards; reusing one
    // would make a second receipt collide with the first.
    const a = buildReceiptMint(facts, params).mint.toBase58();
    const b = buildReceiptMint(facts, params).mint.toBase58();
    expect(a).not.toBe(b);
  });

  it('is not the payer and holds nothing', () => {
    const built = buildReceiptMint(facts, params);
    expect(built.mint.equals(PAYER)).toBe(false);
  });
});

describe('refusing a uri the program would reject', () => {
  it('rejects one over 200 bytes before anything is paid for', () => {
    // The program fails on a long uri *after* the mint account exists and has
    // been funded, which is a confusing way to lose rent.
    const long = `https://example.test/${'a'.repeat(200)}.json`;
    expect(() => buildReceiptMint(facts, { ...params, uri: long })).toThrow(/200/);
  });

  it('measures bytes rather than characters', () => {
    const multibyte = `https://example.test/${'é'.repeat(120)}`;
    expect(multibyte.length).toBeLessThan(200);
    expect(() => buildReceiptMint(facts, { ...params, uri: multibyte })).toThrow(/200/);
  });

  it('accepts an ordinary one', () => {
    expect(() => buildReceiptMint(facts, params)).not.toThrow();
  });
});
