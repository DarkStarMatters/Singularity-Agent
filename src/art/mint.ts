/**
 * The unsigned transaction that turns a settled payment into a receipt NFT.
 *
 * Everything here builds instructions and nothing here signs — with one
 * exception that is stated rather than hidden, because it is the only place in
 * this project where a key is generated at all.
 *
 * ## The mint keypair
 *
 * Creating a new SPL mint means creating a new account, and Solana requires a
 * new account's own key to sign its creation. There is no way around it without
 * a custom on-chain program: the address must be a keypair, so somebody must
 * hold that keypair for the length of one transaction.
 *
 * This is not custody, and the difference is worth being precise about rather
 * than waving at. The ephemeral key controls no funds, is never funded, holds
 * no authority after the transaction lands — `CreateMasterEditionV3` takes the
 * mint authority away and the edition PDA keeps it — and is discarded. The
 * payer's wallet remains the fee payer, the token recipient, and the only
 * signer that authorises anything of value. What the ephemeral key authorises
 * is the existence of an account the payer is already paying for.
 *
 * It still means this module generates a keypair, which the rest of the project
 * does not do, so {@link buildReceiptMint} returns it rather than using it. The
 * caller signs and drops it. Nothing is written to disk.
 *
 * ## Immutable, deliberately
 *
 * `isMutable` is false and cannot be set true from here. This project ships a
 * tool that warns holders when an NFT's metadata can be rewritten by its
 * issuer; minting receipts that could be rewritten afterwards would make the
 * warning advice nobody followed. A receipt whose text can change is not
 * evidence of anything.
 *
 * The same reasoning sets `maxSupply` to zero. A master edition that can print
 * copies is not proof of a single payment.
 */

import {
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  Keypair,
  SYSVAR_RENT_PUBKEY,
} from '@solana/web3.js';
import type { ReceiptFacts } from './receipt.js';
import { receiptName } from './receipt.js';

export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
);
export const TOKEN_METADATA_PROGRAM_ID = new PublicKey(
  'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
);

/** Bytes in an SPL mint account. Fixed by the Token program's layout. */
export const MINT_ACCOUNT_SIZE = 82;

/** Borsh: a string as a four-byte little-endian length then its UTF-8 bytes. */
function borshString(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32LE(bytes.length);
  return Buffer.concat([length, bytes]);
}

/** Borsh: `None` for any Option. */
const NONE = Buffer.from([0]);

/**
 * The metadata account's address.
 *
 * A PDA, so it is derived rather than chosen and cannot be squatted: only the
 * metadata program can sign for it, and only one can exist per mint.
 */
export function metadataAddress(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    TOKEN_METADATA_PROGRAM_ID,
  )[0];
}

/** The master edition PDA, which is what makes a token non-fungible. */
export function masterEditionAddress(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from('metadata'),
      TOKEN_METADATA_PROGRAM_ID.toBuffer(),
      mint.toBuffer(),
      Buffer.from('edition'),
    ],
    TOKEN_METADATA_PROGRAM_ID,
  )[0];
}

/** The holder's associated token account for this mint. */
export function associatedTokenAddress(mint: PublicKey, owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

/**
 * `InitializeMint2`, instruction 20.
 *
 * Zero decimals and a supply that will be capped at one. Decimals are what
 * separate a token from a collectible: a mint with two decimals can be split,
 * and half a receipt is not a thing.
 */
function initializeMint2(mint: PublicKey, authority: PublicKey): TransactionInstruction {
  const data = Buffer.alloc(67);
  data.writeUInt8(20, 0);
  data.writeUInt8(0, 1); // decimals
  authority.toBuffer().copy(data, 2);
  data.writeUInt8(1, 34); // freeze authority present
  authority.toBuffer().copy(data, 35);

  return new TransactionInstruction({
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    programId: TOKEN_PROGRAM_ID,
    data,
  });
}

/**
 * `CreateIdempotent`, instruction 1 of the associated token program.
 *
 * Idempotent rather than `Create`, because the payer may already hold a token
 * account for this mint in the case where the transaction is retried. The
 * plain version fails on an account that exists, which turns a harmless retry
 * into a failed mint.
 */
function createAssociatedTokenAccount(
  payer: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: associatedTokenAddress(mint, owner), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    data: Buffer.from([1]),
  });
}

/** `MintTo`, instruction 7. Exactly one token, forever. */
function mintTo(
  mint: PublicKey,
  destination: PublicKey,
  authority: PublicKey,
): TransactionInstruction {
  const data = Buffer.alloc(9);
  data.writeUInt8(7, 0);
  data.writeBigUInt64LE(1n, 1);

  return new TransactionInstruction({
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    programId: TOKEN_PROGRAM_ID,
    data,
  });
}

/**
 * `CreateMetadataAccountV3`, discriminator 33.
 *
 * The on-chain fields are tightly bounded — 32 bytes of name, 10 of symbol, 200
 * of uri — and the program rejects anything longer rather than truncating, so
 * {@link buildReceiptMint} checks before it builds. `sellerFeeBasisPoints` is
 * zero: a receipt is not a trade and taking a royalty on proof of payment would
 * be strange.
 */
function createMetadataAccountV3(
  mint: PublicKey,
  authority: PublicKey,
  payer: PublicKey,
  name: string,
  symbol: string,
  uri: string,
): TransactionInstruction {
  const sellerFee = Buffer.alloc(2);
  sellerFee.writeUInt16LE(0);

  const data = Buffer.concat([
    Buffer.from([33]),
    borshString(name),
    borshString(symbol),
    borshString(uri),
    sellerFee,
    NONE, // creators
    NONE, // collection
    NONE, // uses
    Buffer.from([0]), // isMutable: false, and not configurable from here
    NONE, // collectionDetails
  ]);

  return new TransactionInstruction({
    keys: [
      { pubkey: metadataAddress(mint), isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false }, // update authority
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    programId: TOKEN_METADATA_PROGRAM_ID,
    data,
  });
}

/**
 * `CreateMasterEditionV3`, discriminator 17, with `maxSupply` of zero.
 *
 * Two things happen here, and the second is the important one. The token
 * becomes a master edition, which is what a wallet reads as "this is an NFT".
 * And the mint authority moves to the edition PDA, which no one holds a key
 * for — so no further tokens of this mint can ever be created, by anybody,
 * including whoever ran this code. A supply of one that could be raised later
 * is not a supply of one.
 */
function createMasterEditionV3(
  mint: PublicKey,
  authority: PublicKey,
  payer: PublicKey,
): TransactionInstruction {
  const maxSupply = Buffer.alloc(9);
  maxSupply.writeUInt8(1, 0); // Some
  maxSupply.writeBigUInt64LE(0n, 1);

  return new TransactionInstruction({
    keys: [
      { pubkey: masterEditionAddress(mint), isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false }, // update authority
      { pubkey: authority, isSigner: true, isWritable: false }, // mint authority
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: metadataAddress(mint), isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    programId: TOKEN_METADATA_PROGRAM_ID,
    data: Buffer.concat([Buffer.from([17]), maxSupply]),
  });
}

export interface ReceiptMintParams {
  /** The wallet that will sign, pay the rent, and hold the receipt. */
  payer: PublicKey;
  /** Where the metadata JSON is served. Must fit the 200-byte on-chain field. */
  uri: string;
  /** Lamports for a rent-exempt 82-byte mint, read from the chain by the caller. */
  mintRent: number;
  /** A recent blockhash. Absent leaves the transaction unfinished, for tests. */
  blockhash?: string;
  symbol?: string;
}

export interface ReceiptMint {
  /** Unsigned but for the ephemeral mint key, which the caller applies. */
  transaction: Transaction;
  /** The new mint's address. Derivable from nothing — it is a fresh keypair. */
  mint: PublicKey;
  /**
   * The throwaway key that must sign for its own account creation.
   *
   * Sign with it, send, and discard. It holds nothing and, once the master
   * edition exists, authorises nothing. See this file's header for why it has
   * to exist at all.
   */
  mintKeypair: Keypair;
  /** Where the token lands. */
  tokenAccount: PublicKey;
}

/**
 * Build the whole mint, unsigned.
 *
 * Five instructions in one transaction, which matters: a receipt that is half
 * minted — a mint account with no metadata, or metadata with no master edition
 * — is worse than no receipt, because it looks like one. Atomicity is the
 * point of putting them together rather than sending them in sequence.
 *
 * The caller supplies `mintRent` rather than this function reading it, so the
 * builder stays pure and testable. `getMinimumBalanceForRentExemption(82)` is
 * the call.
 */
export function buildReceiptMint(facts: ReceiptFacts, params: ReceiptMintParams): ReceiptMint {
  const name = receiptName(facts);
  const symbol = (params.symbol ?? 'SNGLR').slice(0, 10);

  // The program rejects an over-long field rather than truncating it, and it
  // does so after the mint account has been created and paid for.
  if (Buffer.byteLength(params.uri, 'utf8') > 200) {
    throw new Error(
      `The metadata uri is ${Buffer.byteLength(params.uri, 'utf8')} bytes and the on-chain field holds 200. ` +
        'Serve the JSON from a shorter URL — the image is re-derivable from the reference, so it does not belong in the uri.',
    );
  }

  const mintKeypair = Keypair.generate();
  const mint = mintKeypair.publicKey;
  const tokenAccount = associatedTokenAddress(mint, params.payer);

  const transaction = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: params.payer,
      newAccountPubkey: mint,
      lamports: params.mintRent,
      space: MINT_ACCOUNT_SIZE,
      programId: TOKEN_PROGRAM_ID,
    }),
    initializeMint2(mint, params.payer),
    createAssociatedTokenAccount(params.payer, params.payer, mint),
    mintTo(mint, tokenAccount, params.payer),
    createMetadataAccountV3(mint, params.payer, params.payer, name, symbol, params.uri),
    createMasterEditionV3(mint, params.payer, params.payer),
  );

  transaction.feePayer = params.payer;
  if (params.blockhash) transaction.recentBlockhash = params.blockhash;

  return { transaction, mint, mintKeypair, tokenAccount };
}
