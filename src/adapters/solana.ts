import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import bs58 from 'bs58';
import type { ChainAdapter, ContractReadParams, TransferParams } from '../core/adapter.js';
import { type BudgetBounds, applyBudget, budgetNote, itemBudget } from '../core/budget.js';
import type {
  BalanceEntry,
  BurnEvent,
  BurnReceipt,
  ChainSpec,
  FeeEstimate,
  HistoryEntry,
  MintAudit,
  MintPower,
  NormalizedBlock,
  NormalizedTx,
  UnsignedTx,
} from '../core/types.js';
import {
  HistoricalStateUnsupportedError,
  InvalidAddressError,
  RpcError,
  SingularityError,
} from '../core/errors.js';
import {
  completeness,
  sanitizeOnchainText,
  untrustedText,
  type UntrustedText,
} from '../core/envelope.js';
import {
  amount,
  explorerUrl,
  formatUnits,
  nativeAmount,
  parseUnits,
  shortAddress,
  toIso,
} from '../core/format.js';
import { knownTokens, tokenBySymbol } from '../core/tokens.js';
import { checkImpersonation } from '../core/impersonation.js';
import { finality } from '../core/finality.js';
import type {
  MintRisk,
  PaymentClaim,
  PaymentDemand,
  PaymentDemandReport,
  PaymentSettlement,
  SettlementLevel,
} from '../pay/types.js';
import {
  classifyDemand,
  demandNote,
  demandVerdict,
  type DemandChain,
  type DemandFacts,
} from '../pay/demand.js';
import type { Concentration, ExitRisk, TokenExitReport } from '../trade/types.js';
import { classifyExitRisks, exitVerdict, sortBySeverity } from '../trade/classify.js';

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

/**
 * Metaplex Token Metadata — where an SPL mint's name and symbol actually live.
 *
 * A mint account itself stores decimals and authorities and no text at all,
 * which is why an uncurated mint used to come back as `EPjF…Dt1v` and nothing
 * else. The name is in a separate PDA owned by this program, and reading it is
 * what roadmap 1.4 is. Decoded by hand rather than by pulling in the Metaplex
 * SDK, in the same spirit as the hand-rolled TransferChecked below: the layout
 * is three Borsh strings at a fixed offset and the dependency is enormous.
 */
const METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

/**
 * Token-2022 puts the text back in the mint account.
 *
 * A mint under the newer program is the same 82-byte base record, then an
 * account-type byte, then type-length-value entries. Two of them matter here:
 * `TokenMetadata` holds the name and symbol inline, and `MetadataPointer`
 * names the account holding them when they are kept somewhere else. Roadmap 1.4
 * shipped reading the Metaplex PDA and left this case falling back to the short
 * mint — honest, and no longer good enough, because every pump.fun mint since
 * the program switch lands here, including this project's own.
 */
/**
 * Where a mint's extensions actually begin.
 *
 * Not at the end of the 82-byte base mint, which is the obvious guess and is
 * wrong: a mint that carries extensions is first padded out to the 165 bytes of
 * a *token account*, precisely so that a mint and an account can never be told
 * apart by length alone, and only then comes the account-type byte and the TLV.
 * Guessing 83 finds a run of zero bytes, reads as "no extensions here", and
 * leaves every Token-2022 mint unnamed — which is exactly what the tests
 * asserted was fixed, because the fixture was built from the same wrong guess.
 * It took running the CLI against a real mint to see it.
 */
const EXTENSION_TLV_START = 165 + 1;
const EXT_TRANSFER_FEE_CONFIG = 1;
const EXT_MINT_CLOSE_AUTHORITY = 3;
const EXT_CONFIDENTIAL_TRANSFER = 4;
const EXT_INTEREST_BEARING = 10;
const EXT_DEFAULT_ACCOUNT_STATE = 6;
const EXT_NON_TRANSFERABLE = 9;
const EXT_PERMANENT_DELEGATE = 12;
const EXT_TRANSFER_HOOK = 14;
const EXT_METADATA_POINTER = 18;
const EXT_TOKEN_METADATA = 19;
/** The base mint record, before any padding or extensions. */
const MINT_BASE_SIZE = 82;
/** Offset of `decimals` in it: a 36-byte authority option, then an 8-byte supply. */
const MINT_DECIMALS_OFFSET = 44;
/** An all-zero pubkey is Token-2022's "unset", not an account to go and read. */
const UNSET_PUBKEY = PublicKey.default.toBase58();

/** `getMultipleAccountsInfo` refuses more than this many keys in one call. */
const ACCOUNT_BATCH = 100;

/**
 * How new a transaction this client will accept.
 *
 * Not a preference — a node refuses outright to return a transaction newer than
 * the number given, so `0` meant every version-1 transaction came back as an
 * RPC error instead of an answer. That was 137 of 1,384 transactions in a
 * sampled mainnet block: a tenth of the chain, unreadable, with an error message
 * that named the fix.
 *
 * Deliberately above any version that exists. This parameter governs how the
 * node *encodes* its reply, and everything here reads the node's parsed form —
 * `accountKeys`, `instructions`, `meta` — which the node normalizes across
 * versions, resolving address lookup tables on the way. Refusing a whole class
 * of transactions to avoid reading a shape that has not changed is the worse
 * trade. If anything here ever decodes raw message bytes itself, this has to
 * become the highest version actually understood, and this comment is the
 * warning attached to that.
 */
const MAX_TX_VERSION = 255;

/** Base signature fee, in lamports. Priority fees stack on top of this. */
const BASE_SIGNATURE_FEE = 5_000n;
/** SPL Token program instruction discriminator for TransferChecked. */
const IX_TRANSFER_CHECKED = 12;
/** ...and for BurnChecked, which carries the decimals the same way. */
const IX_BURN_CHECKED = 15;
/**
 * The SPL Memo program.
 *
 * A memo is the only part of a transaction the signer writes in their own
 * words, which makes it the only thing that can attach a *claim* to a burn
 * without anybody holding anything. A signature is public the moment it lands
 * and proves nothing about who quotes it; a memo is signed along with the rest
 * of the transaction, so nobody can put their name on somebody else's burn
 * without making a burn of their own.
 */
const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
/** Long enough for any claim worth making, short enough to stay a memo. */
const MAX_MEMO_LENGTH = 256;
/** Token account layout: the balance at 64, the frozen flag past the delegate. */
const TOKEN_ACCOUNT_AMOUNT_OFFSET = 64;
const TOKEN_ACCOUNT_STATE_OFFSET = 108;
const TOKEN_ACCOUNT_FROZEN = 2;
/**
 * How many mints an unfiltered scan will return.
 *
 * Solana lets anyone airdrop a token account onto any wallet, so an active
 * address accumulates thousands of dust mints; returning all of them buries the
 * real holdings and can overflow a model's tool-result budget outright — which
 * is not hypothetical, it is the 1.27 MB response in the whitepaper.
 *
 * `fallback` is the number that shipped, so a caller that states no budget sees
 * exactly what it saw before. `ceiling` is higher because metadata is read
 * through `getMultipleAccountsInfo` in batches, so asking for four times as
 * many mints costs a few more round trips rather than 150 more requests. It
 * stays finite regardless: `full` means this source's maximum, never
 * everything.
 */
const TOKEN_SCAN_BOUNDS: BudgetBounds = { fallback: 50, ceiling: 200 };

/**
 * Entries one history page returns.
 *
 * `fallback` is the default that shipped, so a caller stating no budget sees
 * what it saw before. `ceiling` is what this source will page in a single call.
 * A caller with room asks for `full` and gets the ceiling; a caller without
 * asks for `small` and stops paying for entries it has no space to read.
 */
const HISTORY_BOUNDS: BudgetBounds = { fallback: 25, ceiling: 100 };

const connections = new Map<string, Connection>();

function connectionAt(endpoint: string): Connection {
  const cached = connections.get(endpoint);
  if (cached) return cached;
  const connection = new Connection(endpoint, { commitment: 'confirmed' });
  connections.set(endpoint, connection);
  return connection;
}

/**
 * Run an operation against each configured endpoint until one succeeds.
 *
 * Public Solana RPCs throttle by IP and go away without warning, so failover is
 * the normal path. Domain errors (a missing account, a bad mint) are rethrown
 * immediately — retrying those on another endpoint would just be slower and
 * give the same answer.
 */
async function withConnection<T>(
  chain: ChainSpec,
  operation: string,
  fn: (connection: Connection) => Promise<T>,
): Promise<T> {
  if (!chain.rpc.length) throw new RpcError(chain.id, 'no RPC endpoint configured');

  const failures: string[] = [];

  for (const endpoint of chain.rpc) {
    try {
      return await fn(connectionAt(endpoint));
    } catch (err) {
      if (err instanceof SingularityError) throw err;
      failures.push(`${hostOf(endpoint)} -> ${(err as Error).message}`);
    }
  }

  throw new RpcError(
    chain.id,
    `${operation}: all ${chain.rpc.length} endpoint(s) failed [${failures.join('; ')}]`,
  );
}

/**
 * A skipped or pruned slot is a fact about the chain, not a sick endpoint, so it
 * must not trigger RPC failover. -32007 and -32009 are Solana's skipped-slot
 * codes; a null result surfaces as web3.js's own "not found" throw.
 */
function isMissingSlot(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === -32007 || code === -32009) return true;
  return /not found|was skipped/i.test((err as Error | null)?.message ?? '');
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * A transaction signature is 64 bytes of base58, and checking that here is the
 * difference between one sentence and a wall of transport noise.
 *
 * Handed something that is not a signature — a mint address in the wrong
 * argument slot, a truncated paste — every endpoint in turn answers
 * "Invalid param: Invalid", and the caller gets all of them stacked up,
 * including the ones that failed for unrelated reasons. None of that says the
 * one useful thing: that string is not a signature. The shape is knowable
 * without asking a node, so it is known before one is asked.
 */
function requireSignature(signature: string): string {
  const value = signature.trim();
  let bytes: Uint8Array | undefined;

  try {
    bytes = bs58.decode(value);
  } catch {
    bytes = undefined;
  }

  if (!bytes || bytes.length !== 64) {
    // The likeliest wrong string is the one this tool handed over a minute ago.
    // Base58 has no `+`, `/` or `=`, so anything carrying them is base64 — and
    // the only base64 in this workflow is the unsigned payload from a build.
    // Telling someone "that is not a signature" when they have pasted the exact
    // thing they were given is technically true and useless.
    const looksBase64 = /[+/=]/.test(value) && value.length > 100;

    throw new SingularityError(
      'INVALID_SIGNATURE',
      looksBase64
        ? 'That is the unsigned payload, not a signature.'
        : `"${shortAddress(value, 10, 6)}" is not a Solana transaction signature.`,
      looksBase64
        ? 'A payload is a proposal: it is what you sign. A signature is what the network gives back once you have signed and sent it, and it is roughly 88 characters of base58 with no "+", "/" or "=". Sign the payload in your own wallet first, then bring back the signature it produces.'
        : 'A signature is 64 bytes of base58, usually 87 or 88 characters. An address is 32 bytes and will not work here — check the argument order.',
    );
  }

  return value;
}

function requirePubkey(address: string, label = 'address'): PublicKey {
  try {
    return new PublicKey(address);
  } catch {
    throw new InvalidAddressError(
      address,
      'Solana',
      `Expected a base58-encoded 32-byte ${label} (typically 32-44 characters).`,
    );
  }
}

/**
 * The associated token account for a mint — and the token program is part of
 * the seeds, so the same wallet and mint under Token-2022 give a *different*
 * address. Passing the wrong one derives an account that does not exist.
 */
function deriveAta(owner: PublicKey, mint: PublicKey, programId: PublicKey): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), programId.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return ata;
}

export const solanaAdapter: ChainAdapter = {
  family: 'svm',

  isValidAddress(_chain, address) {
    try {
      new PublicKey(address);
      return true;
    } catch {
      return false;
    }
  },

  addressExpectation() {
    return 'Expected a base58-encoded 32-byte public key (typically 32-44 characters).';
  },

  async getNativeBalance(chain, address, options) {
    rejectHistorical(chain, options?.atBlock);
    const owner = requirePubkey(address);
    const lamports = await withConnection(chain, 'getBalance', (connection) =>
      connection.getBalance(owner),
    );

    return {
      chain: chain.id,
      address: owner.toBase58(),
      token: { ...chain.nativeCurrency, native: true },
      amount: nativeAmount(BigInt(lamports), chain),
    };
  },

  async getTokenBalances(chain, address, tokens, options) {
    rejectHistorical(chain, options?.atBlock);
    const owner = requirePubkey(address);

    return withConnection(chain, 'getParsedTokenAccountsByOwner', async (connection) => {
      // Unlike EVM, Solana can actually enumerate holdings — token accounts are
      // owned by the wallet, so this really is the full SPL list.
      const [legacy, token2022] = await Promise.all([
        connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }),
        connection
          .getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID })
          // Deliberately not caught into an empty list. An endpoint that will
          // not enumerate Token-2022 — an old validator, or a public node
          // rate-limiting this one call — used to cost the wallet every
          // Token-2022 holding it has, under a completeness note still
          // promising "every SPL and Token-2022 mint held". That is the
          // dropped-failure-comes-back-as-`[]` bug this repo keeps closing,
          // and half of Solana's newer supply is Token-2022. Letting it throw
          // costs nothing: `withConnection` fails over to the next endpoint,
          // and if none of them can answer the caller gets an error rather
          // than a short list that reads as a complete one.
          .catch((err: unknown) => {
            throw new Error(`Token-2022 accounts could not be listed: ${(err as Error).message}`);
          }),
      ]);

      const filter = tokens?.length
        ? new Set(
            tokens.map((t) => {
              const known = tokenBySymbol(chain.id, t);
              return (known?.address ?? t).toLowerCase();
            }),
          )
        : null;

      // A wallet can hold several token accounts for one mint — an exchange
      // routinely does. They are one holding, so sum them; listing them
      // separately invites double-counting.
      const byMint = new Map<string, { decimals: number; total: bigint; accounts: number }>();

      for (const { account } of [...legacy.value, ...token2022.value]) {
        const info = (account.data as { parsed: { info: SplAccountInfo } }).parsed.info;
        const mint = info.mint;
        if (filter && !filter.has(mint.toLowerCase())) continue;

        const raw = BigInt(info.tokenAmount.amount);
        if (raw === 0n) continue;

        const existing = byMint.get(mint);
        if (existing) {
          existing.total += raw;
          existing.accounts += 1;
        } else {
          byMint.set(mint, { decimals: info.tokenAmount.decimals, total: raw, accounts: 1 });
        }
      }

      // Rows first, entries later. The sort and the cap below need only the
      // balance and whether the mint is curated, and building entries before
      // truncating would mean reading metadata for mints about to be thrown
      // away — on a dusted wallet, hundreds of accounts for fifty results.
      const all = [...byMint].map(([mint, { decimals, total, accounts }]) => ({
        mint,
        decimals,
        total,
        accounts,
        known: knownMintSymbol(chain.id, mint),
        magnitude: Number(total) / 10 ** decimals,
      }));

      // An explicit `tokens` list is the caller asking for specific mints — give
      // back every one of them, in the order they were requested.
      if (filter) {
        const named = await withMetadata(connection, chain, owner, all);
        return {
          entries: named.entries,
          completeness: completeness.exhaustive(
            `Every token account the address holds for the ${filter.size} mint(s) you named, summed per mint.` +
              named.caveat,
          ),
        };
      }

      // Curated tokens first; within each group, larger balances first. Note that
      // magnitude is not value — there is no pricing here, so a trillion units of
      // dust outranks a thousand USDC. It is a stable, explicable order, not a
      // ranking by worth.
      all.sort((a, b) => Number(Boolean(b.known)) - Number(Boolean(a.known)) || b.magnitude - a.magnitude);

      // The budget is applied to the mint rows, before metadata is read for
      // them, so asking for less genuinely costs less rather than fetching
      // everything and throwing most of it away. `applyBudget` hands back the
      // list and the claim about it together, which is why the slice below
      // cannot quietly keep calling itself exhaustive.
      const shaped = applyBudget(
        all,
        itemBudget(options?.budget, TOKEN_SCAN_BOUNDS),
        completeness.exhaustive(
          'Complete: on Solana token accounts are owned by the wallet, so this really is every SPL and Token-2022 mint held, summed across accounts.',
        ),
        (shown, omitted) =>
          `${budgetNote(shown, omitted, 'mints held')} Curated tokens come first, then raw ` +
          'balance — and because there is no pricing here that order is magnitude, not value. ' +
          'Pass `tokens` with mint addresses to check specific holdings.',
      );

      const named = await withMetadata(connection, chain, owner, shaped.entries);
      return {
        entries: named.entries,
        completeness: {
          ...shaped.completeness,
          note: shaped.completeness.note + named.caveat,
        },
      };
    });
  },

  /**
   * Signatures that reference this account, newest first.
   *
   * `getSignaturesForAddress` is a standard RPC method, so this needs no
   * indexer and no key — which is worth saying because the plan for this
   * feature assumed otherwise for every family.
   *
   * What it returns is the honest limit of the thing: a list of transactions
   * that *mention* the account. It does not say a transfer happened, or which
   * way anything moved, and working that out means fetching each transaction
   * and walking its balance deltas — one round trip per entry. So `direction`
   * is `unknown` here and stays that way rather than being guessed from a
   * position in an account list. `transaction` answers properly for any one of
   * them.
   *
   * Public endpoints also prune. An empty list is "nothing this endpoint still
   * holds", not "this account has never been used", and the note says so.
   */
  async getHistory(chain, rawAddress, options) {
    const owner = requirePubkey(rawAddress, 'address');
    const limit = itemBudget(options?.budget, HISTORY_BOUNDS, options?.limit);

    return withConnection(chain, 'getSignaturesForAddress', async (connection) => {
      const signatures = await connection.getSignaturesForAddress(owner, {
        limit,
        ...(options?.cursor ? { before: options.cursor } : {}),
      });

      const entries: HistoryEntry[] = signatures.map((entry) => ({
        hash: entry.signature,
        status: entry.err ? ('failed' as const) : ('success' as const),
        direction: 'unknown' as const,
        summary: entry.err
          ? 'Failed transaction referencing this account.'
          : 'Transaction referencing this account.',
        ...(entry.blockTime ? { timestamp: new Date(entry.blockTime * 1000).toISOString() } : {}),
        ...(entry.slot ? { blockNumber: entry.slot } : {}),
        ...(explorerUrl(chain, 'tx', entry.signature)
          ? { explorerUrl: explorerUrl(chain, 'tx', entry.signature) as string }
          : {}),
      }));

      const last = entries.at(-1)?.hash;

      return {
        chain: chain.id,
        address: owner.toBase58(),
        entries,
        // Truncated whenever a full page came back, because the next page is
        // the only way to learn whether there was one.
        completeness:
          entries.length === limit
            ? completeness.paged(
                entries.length,
                `The ${entries.length} most recent signatures referencing this account. More exist; pass the cursor to continue. A signature means the account was referenced, not that value moved — direction and amount need \`transaction\` per entry. Public endpoints prune history, so this is what this endpoint still holds rather than everything that ever happened.`,
              )
            : completeness.exhaustive(
                `Every signature this endpoint still holds for the account${entries.length ? '' : ', which is none'}. A signature means the account was referenced, not that value moved. Solana public endpoints prune aggressively, so an empty or short list is not evidence the account was never used.`,
              ),
        ...(entries.length === limit && last ? { cursor: last } : {}),
      };
    });
  },

  async getTransaction(chain, rawHash) {
    const hash = requireSignature(rawHash);

    return withConnection(chain, 'getParsedTransaction', async (connection) => {
      const tx = await connection.getParsedTransaction(hash, {
        maxSupportedTransactionVersion: MAX_TX_VERSION,
      });

      if (!tx) {
        throw new SingularityError(
          'TX_NOT_FOUND',
          `Signature ${shortAddress(hash, 10, 8)} was not found on ${chain.name}.`,
          'Solana public RPCs prune history aggressively — an older signature may need an archival endpoint.',
        );
      }

      const fee = BigInt(tx.meta?.fee ?? 0);
      const accounts = tx.transaction.message.accountKeys;
      const feePayer = accounts[0]?.pubkey.toBase58();
      const preBalances = tx.meta?.preBalances ?? [];
      const postBalances = tx.meta?.postBalances ?? [];

      // Net lamport movement for the fee payer, minus the fee they paid.
      const delta =
        preBalances[0] !== undefined && postBalances[0] !== undefined
          ? BigInt(postBalances[0]) - BigInt(preBalances[0]) + fee
          : 0n;

      const programs = [
        ...new Set(
          tx.transaction.message.instructions.map((ix) => ('programId' in ix ? ix.programId.toBase58() : '')),
        ),
      ].filter(Boolean);

      const failed = tx.meta?.err != null;

      // Anything a program chose to say. `msg!()` costs a program nothing and
      // accepts any string, so these lines are the single largest piece of
      // attacker-authored text this tool returns — and until now they rode out
      // in `raw` unmarked and uncapped, where a model reading the result had
      // no way to tell a program's log from the tool's own words.
      const logs = (tx.meta?.logMessages ?? [])
        .slice(0, 20)
        .map((line) => untrustedText(line, 'a log line emitted by an executing program'))
        .filter((line): line is UntrustedText => line !== undefined);

      return {
        chain: chain.id,
        hash,
        status: failed ? 'failed' : 'success',
        blockNumber: tx.slot,
        timestamp: toIso(tx.blockTime ?? undefined),
        from: feePayer,
        value: nativeAmount(delta < 0n ? -delta : delta, chain),
        fee: nativeAmount(fee, chain),
        summary: failed
          ? `Failed transaction from ${shortAddress(feePayer ?? '?')} on ${chain.name}: ${sanitizeOnchainText(JSON.stringify(tx.meta?.err), 'the RPC gave no reason')}`
          : `${shortAddress(feePayer ?? '?')} ran ${tx.transaction.message.instructions.length} instruction(s) across ${programs.length} program(s) on ${chain.name}.`,
        decoded: {
          // Program ids are base58 pubkeys: 32 bytes, no text, nothing a
          // program author gets to choose the reading of. Safe in prose.
          note: `Programs invoked: ${programs.join(', ') || 'none'}`,
        },
        ...(logs.length ? { logs } : {}),
        explorerUrl: explorerUrl(chain, 'tx', hash),
        raw: {
          slot: tx.slot,
          computeUnitsConsumed: tx.meta?.computeUnitsConsumed,
          instructionCount: tx.transaction.message.instructions.length,
          // `logMessages` moved to `logs` above, marked. Leaving the raw copy
          // here would be the mark bypassed by whoever reads `raw` first.
          logCount: tx.meta?.logMessages?.length ?? 0,
        },
      } satisfies NormalizedTx;
    });
  },

  async getBlock(chain, ref) {
    return withConnection(chain, 'getBlock', async (connection) => {
      const slot = ref === 'latest' || ref === '' ? await connection.getSlot() : Number(ref);
      if (!Number.isFinite(slot)) {
        throw new SingularityError(
          'BAD_BLOCK_REF',
          `"${ref}" is not a slot number.`,
          'Solana blocks are addressed by slot number, not by hash.',
        );
      }

      // web3.js only ships response validators for `transactionDetails` of
      // 'accounts' and 'none'; 'signatures' falls through to the full-block
      // struct, which rejects every response for a missing `transactions`
      // array. `getBlockSignatures` sends the same request with the validator
      // that matches it.
      let block: SignatureOnlyBlock;
      try {
        block = await connection.getBlockSignatures(slot);
      } catch (err) {
        if (!isMissingSlot(err)) throw err; // let withConnection try the next endpoint
        throw new SingularityError(
          'BLOCK_NOT_FOUND',
          `Slot ${slot} has no block on ${chain.name}.`,
          'Skipped slots are normal on Solana — try an adjacent slot.',
        );
      }

      return {
        chain: chain.id,
        number: slot,
        hash: block.blockhash,
        timestamp: toIso(block.blockTime ?? undefined),
        txCount: block.signatures?.length ?? 0,
        parentHash: block.previousBlockhash,
        explorerUrl: explorerUrl(chain, 'block', String(slot)),
        raw: { parentSlot: block.parentSlot },
      } satisfies NormalizedBlock;
    });
  },

  async healthCheck(chain) {
    // getSlot is permitted everywhere; getBlock is commonly disabled on public
    // endpoints, so probing with it would call a healthy node dead.
    await withConnection(chain, 'getSlot', (connection) => connection.getSlot());
  },

  /**
   * The finalized (rooted) slot.
   *
   * This adapter reads at `confirmed` everywhere else, which is a supermajority
   * vote and the right latency trade — but it is not a root, and a confirmed
   * slot can still be abandoned. Nothing in a returned balance said so, which
   * is the gap this closes rather than a behaviour change: reads stay at
   * `confirmed` and now admit what that means.
   */
  async finalizedHeight(chain) {
    return withConnection(chain, 'getSlot', async (connection) => {
      const slot = await connection.getSlot('finalized').catch(() => null);
      return typeof slot === 'number' ? slot : null;
    });
  },

  async chainTip(chain) {
    return withConnection(chain, 'getSlot', async (connection) => {
      const slot = await connection.getSlot();

      // getBlockTime is a separate call because the one method that returns both
      // is getBlock, which public endpoints disable. It answers null for a
      // skipped slot and is itself restricted on some providers — either way the
      // height stands on its own and the tip is reported undated rather than
      // guessed at. An undated tip reads as `undatable`, not as fresh.
      const blockTime = await connection.getBlockTime(slot).catch(() => null);

      return {
        height: slot,
        ...(blockTime ? { timestamp: new Date(blockTime * 1000).toISOString() } : {}),
      };
    });
  },

  async estimateFees(chain) {
    return withConnection(chain, 'getRecentPrioritizationFees', async (connection) => {
      const recent = await connection.getRecentPrioritizationFees().catch(() => []);
      const fees = recent.map((f) => f.prioritizationFee).filter((f) => f > 0);
      const median = fees.length ? fees.sort((a, b) => a - b)[Math.floor(fees.length / 2)]! : 0;

      return {
        chain: chain.id,
        simpleTransfer: nativeAmount(BASE_SIGNATURE_FEE, chain),
        details: {
          baseFeePerSignature: `${BASE_SIGNATURE_FEE} lamports`,
          medianPriorityFee: `${median} micro-lamports per compute unit`,
          solPerLamport: `1 SOL = ${LAMPORTS_PER_SOL} lamports`,
        },
        note: 'Solana fees are per-signature and near-constant. Priority fees only matter under congestion.',
      } satisfies FeeEstimate;
    });
  },

  async buildTransfer(chain, params) {
    if (!params.from) {
      throw new SingularityError(
        'MISSING_FROM',
        'Solana transactions need a `from` address.',
        'The fee payer must be known before the transaction can be built — pass the sending wallet.',
      );
    }

    const from = requirePubkey(params.from, 'sender address');
    const to = requirePubkey(params.to, 'recipient address');

    return withConnection(chain, 'buildTransfer', async (connection) => {
      const transaction = new Transaction();
      let summary: string;
      const warnings = ['This transaction is unsigned. Review every field before signing.'];
      if (chain.testnet) {
        warnings.push(`${chain.name} is a test network — these tokens have no value.`);
      }

      if (params.token) {
        const known = tokenBySymbol(chain.id, params.token);
        const mint = requirePubkey(known?.address ?? params.token, 'mint address');

        // Always read the mint, even for a curated token: the decimals are in
        // the map but the owning program is not, and it decides both the
        // instruction's program id and the addresses the accounts derive to.
        const facts = await readMintFacts(connection, mint, chain);
        const decimals = facts.decimals;
        const value = parseUnits(params.amount, decimals);
        warnings.push(...transferExtensionWarnings(facts, mint, chain));

        const source = deriveAta(from, mint, facts.programId);
        const destination = deriveAta(to, mint, facts.programId);

        const destinationExists = await connection.getAccountInfo(destination).catch(() => null);
        if (!destinationExists) {
          warnings.push(
            `The recipient has no token account for this mint. The transaction must also create one (associated token account ${destination.toBase58()}), which costs ~0.002 SOL of rent.`,
          );
        }

        transaction.add(
          transferCheckedInstruction({
            source,
            mint,
            destination,
            owner: from,
            value,
            decimals,
            programId: facts.programId,
          }),
        );
        summary = `Send ${params.amount} ${known?.symbol ?? 'tokens'} (mint ${shortAddress(mint.toBase58())}) from ${shortAddress(from.toBase58())} to ${shortAddress(to.toBase58())} on ${chain.name}.`;
      } else {
        const lamports = parseUnits(params.amount, chain.nativeCurrency.decimals);
        transaction.add(
          SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports: Number(lamports) }),
        );
        summary = `Send ${params.amount} SOL from ${shortAddress(from.toBase58())} to ${shortAddress(to.toBase58())} on ${chain.name}.`;
      }

      transaction.feePayer = from;
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
      transaction.recentBlockhash = blockhash;

      const serialized = transaction
        .serialize({ requireAllSignatures: false, verifySignatures: false })
        .toString('base64');

      return {
        chain: chain.id,
        family: 'svm',
        summary,
        payload: {
          transaction: serialized,
          encoding: 'base64',
          feePayer: from.toBase58(),
          recentBlockhash: blockhash,
          lastValidBlockHeight,
        },
        signingHint:
          'Base64 wire-format transaction. Deserialize with Transaction.from(Buffer.from(tx, "base64")), sign, then sendRawTransaction. The blockhash expires in ~60 seconds — rebuild if it lapses.',
        warnings,
      } satisfies UnsignedTx;
    });
  },

  async readContract(chain, params: ContractReadParams) {
    rejectHistorical(chain, params.atBlock);
    // Solana has no "call a view function"; the equivalent is reading account data.
    const address = requirePubkey(params.address, 'account address');
    return withConnection(chain, 'getParsedAccountInfo', async (connection) => {
      const info = await connection.getParsedAccountInfo(address);
      if (!info.value) {
        throw new SingularityError(
          'ACCOUNT_NOT_FOUND',
          `Account ${shortAddress(address.toBase58())} does not exist on ${chain.name}.`,
        );
      }
      const data = info.value.data;
      return {
        address: address.toBase58(),
        owner: info.value.owner.toBase58(),
        lamports: info.value.lamports,
        executable: info.value.executable,
        rentEpoch: info.value.rentEpoch,
        data: 'parsed' in data ? data.parsed : { encoding: 'base64', length: data.length },
      };
    });
  },
};

/**
 * Solana JSON-RPC has no historical form of an account read.
 *
 * `getBalance` and `getAccountInfo` take a commitment and a `minContextSlot` —
 * a floor on how *new* the answer may be, not a slot to read at. There is no
 * parameter that would make them answer as of a past slot, so the request is
 * refused rather than served with current state under a historical label.
 * Serving it for real needs an archival indexer, which is roadmap 1.2.
 */
function rejectHistorical(chain: ChainSpec, atBlock?: number): void {
  if (atBlock === undefined) return;
  throw new HistoricalStateUnsupportedError(
    chain.name,
    'Solana RPC addresses account state by commitment, not by slot — `minContextSlot` bounds how new an answer may be, and cannot ask for an old one. Reading a past slot needs an archival indexer (Helius, Triton), which this tool does not bundle.',
  );
}

interface SplAccountInfo {
  mint: string;
  owner: string;
  tokenAmount: { amount: string; decimals: number; uiAmountString: string };
}

/** Shape of getBlock when asked for signatures rather than full transactions. */
interface SignatureOnlyBlock {
  blockhash: string;
  previousBlockhash: string;
  parentSlot: number;
  blockTime: number | null;
  signatures?: string[];
}

/** Manual TransferChecked — avoids pulling in the whole spl-token package. */
function transferCheckedInstruction(args: {
  source: PublicKey;
  mint: PublicKey;
  destination: PublicKey;
  owner: PublicKey;
  value: bigint;
  decimals: number;
  programId: PublicKey;
}): TransactionInstruction {
  const data = Buffer.alloc(10);
  data.writeUInt8(IX_TRANSFER_CHECKED, 0);
  data.writeBigUInt64LE(args.value, 1);
  data.writeUInt8(args.decimals, 9);

  return new TransactionInstruction({
    // Not TOKEN_PROGRAM_ID. TransferChecked has the same discriminator under
    // both programs, so sending a Token-2022 transfer to the legacy program
    // builds a transaction that looks right and cannot execute: the program
    // does not own the accounts it is handed.
    programId: args.programId,
    keys: [
      { pubkey: args.source, isSigner: false, isWritable: true },
      { pubkey: args.mint, isSigner: false, isWritable: false },
      { pubkey: args.destination, isSigner: false, isWritable: true },
      { pubkey: args.owner, isSigner: true, isWritable: false },
    ],
    data,
  });
}

/** What a transfer has to know about a mint before it can be built correctly. */
interface MintFacts {
  decimals: number;
  /** The program that owns the mint — legacy SPL Token, or Token-2022. */
  programId: PublicKey;
  /** Token-2022 extensions, empty under the legacy program. */
  extensions: Map<number, Buffer>;
  /** Live mint authority, if any. Absent means supply is fixed forever. */
  mintAuthority?: string;
  /** Live freeze authority, if any. Absent means no account can be frozen. */
  freezeAuthority?: string;
}

/**
 * Read the mint: its decimals, the program that owns it, and its extensions.
 *
 * The owning program is the part that used to be assumed. Every Solana token
 * was an SPL Token mint once, and that assumption is now wrong for a large and
 * growing share of new supply — including mints this project's own agent is
 * asked about daily.
 */
async function readMintFacts(
  connection: Connection,
  mint: PublicKey,
  chain: ChainSpec,
): Promise<MintFacts> {
  const info = await connection.getAccountInfo(mint);
  const notAMint = new SingularityError(
    'NOT_A_MINT',
    `${shortAddress(mint.toBase58())} is not an SPL mint on ${chain.name}.`,
    'Pass the mint address, not a token account address.',
  );

  if (!info?.data || info.data.length < MINT_BASE_SIZE) throw notAMint;
  const programId = info.owner;
  const isToken2022 = programId.equals(TOKEN_2022_PROGRAM_ID);
  if (!isToken2022 && !programId.equals(TOKEN_PROGRAM_ID)) throw notAMint;

  const view = Buffer.from(info.data);

  return {
    decimals: view.readUInt8(MINT_DECIMALS_OFFSET),
    programId,
    extensions: isToken2022 ? tlvExtensions(info.data) : new Map(),
    mintAuthority: readOptionalAuthority(view, 0),
    freezeAuthority: readOptionalAuthority(view, 46),
  };
}

/**
 * What a mint's extensions mean for a transfer of it.
 *
 * Two of these make a built transaction wrong rather than merely surprising, so
 * they are refused: a hook needs accounts this builder cannot resolve, and a
 * non-transferable mint cannot be sent at all. The rest are facts the signer
 * needs before they sign, and the reason they belong *here* is that none of
 * them are visible in a wallet's confirmation screen.
 */
function transferExtensionWarnings(facts: MintFacts, mint: PublicKey, chain: ChainSpec): string[] {
  const { extensions } = facts;
  const short = shortAddress(mint.toBase58());

  if (extensions.has(EXT_NON_TRANSFERABLE)) {
    throw new SingularityError(
      'NON_TRANSFERABLE_TOKEN',
      `Mint ${short} is marked non-transferable on ${chain.name}, so no transfer of it can succeed.`,
      'A soulbound token can only be burned by its holder, never moved.',
    );
  }

  // The extension carries an authority and a program, and the program is
  // routinely unset — PYUSD ships exactly that shape. An unset program means no
  // hook runs and an ordinary transfer is correct, so refusing on the presence
  // of the extension alone would refuse transfers of a major stablecoin that
  // work fine. Contributing §3: a gate is worth what it does to the traffic it
  // should pass, and this one was measured only against what it should block.
  const hook = extensions.get(EXT_TRANSFER_HOOK);
  const hookProgram = hook ? readAuthority(hook, 32) : undefined;
  if (hookProgram) {
    throw new SingularityError(
      'TRANSFER_HOOK_UNSUPPORTED',
      `Mint ${short} has a transfer hook: every transfer calls program ${hookProgram}, which requires extra accounts this tool cannot resolve.`,
      'Building the transfer without them would produce a transaction that fails on submission. Use a wallet or SDK that resolves hook accounts.',
    );
  }

  const warnings: string[] = [];

  if (hook) {
    warnings.push(
      `Mint ${short} has a transfer hook extension with no program set, so transfers behave normally today. Whoever holds the hook authority can set one at any time, and transfers built the ordinary way will start failing when they do.`,
    );
  }

  if (extensions.has(EXT_TRANSFER_FEE_CONFIG)) {
    warnings.push(
      `Mint ${short} charges a transfer fee, so the recipient receives less than the amount sent. This build does not compute the fee — check it before signing.`,
    );
  }

  if (extensions.has(EXT_PERMANENT_DELEGATE)) {
    warnings.push(
      `Mint ${short} has a permanent delegate: an address chosen by whoever controls the mint can move or burn these tokens out of any wallet, including the recipient's, at any time after this transfer.`,
    );
  }

  if (extensions.has(EXT_DEFAULT_ACCOUNT_STATE)) {
    warnings.push(
      `Mint ${short} sets a default state on new token accounts, which can mean the recipient's account arrives frozen and unable to send.`,
    );
  }

  return warnings;
}

/** mint -> metadata, memoized per chain, so token lists render real symbols. */
const mintIndexCache = new Map<string, Map<string, { symbol: string; name: string }>>();

/** One summed holding, before anything has been read about what it is called. */
interface MintRow {
  mint: string;
  decimals: number;
  total: bigint;
  accounts: number;
  known: { symbol: string; name: string } | undefined;
  magnitude: number;
}

/**
 * Turn rows into balance entries, naming the uncurated mints along the way.
 *
 * This is the whole of roadmap 1.4 on Solana. Before it, an uncurated mint came
 * back as `EPjF…Dt1v` and the comment in its place said the impersonation check
 * would arrive in the same change that started reading deployer-chosen strings.
 * This is that change, so the check is here: the moment a mint has a symbol
 * somebody chose, it can be a symbol somebody else already uses.
 *
 * Every string read here is marked and defanged, for the reason the whole of
 * Phase 2 exists — `runToolCall` feeds these into a model that composes public
 * replies, and a mint called "Ignore previous instructions" costs about as much
 * to deploy as a coffee.
 */
async function withMetadata(
  connection: Connection,
  chain: ChainSpec,
  owner: PublicKey,
  rows: MintRow[],
): Promise<{ entries: BalanceEntry[]; caveat: string }> {
  const unknown = rows.filter((row) => !row.known).map((row) => row.mint);
  const { found, failure } = await readMintMetadata(connection, unknown);

  const entries = rows.map((row) => {
    const { mint, decimals, total, accounts, known } = row;
    const short = `${mint.slice(0, 4)}…${mint.slice(-4)}`;
    const metadata = known ? undefined : found.get(mint);

    // The mint address stands in when nothing could be read. It is not a name
    // and does not pretend to be one, which is the right answer for a mint that
    // genuinely has no metadata account.
    const symbol = known?.symbol ?? sanitizeOnchainText(metadata?.symbol, short);
    const name = known?.name ?? (sanitizeOnchainText(metadata?.name, '') || undefined);

    // Only where a deployer actually chose the string. A curated mint carries
    // this tool's own text, and a mint with no metadata chose nothing at all.
    const impersonation = metadata
      ? checkImpersonation(chain, { symbol, name, address: mint })
      : undefined;

    return {
      chain: chain.id,
      address: owner.toBase58(),
      token: {
        address: mint,
        symbol,
        name,
        decimals,
        native: false,
        ...(known ? {} : { untrusted: true as const }),
        ...(impersonation ? { impersonation } : {}),
      },
      // "tokens" only when there is genuinely no symbol to use — the short
      // mint is an address, and an amount reading "1000 EPjF…Dt1v" is worse
      // than one that admits it does not know the unit.
      amount: amount(total, decimals, known || metadata ? symbol : 'tokens'),
      ...(accounts > 1 ? { tokenAccounts: accounts } : {}),
    } satisfies BalanceEntry;
  });

  // Said out loud, because a failed metadata read and a set of mints that
  // genuinely have no names produce identical output — and in the failed case
  // the impersonation check did not run, so "nothing found" is not a finding.
  const caveat = failure
    ? ` Mint names could not be read (${sanitizeOnchainText(failure, 'the RPC gave no reason')}), so` +
      ' uncurated mints show as their address and no impersonation check ran against them.'
    : '';

  return { entries, caveat };
}

/** What a mint's metadata account says it is called. Every string is the deployer's. */
interface MintMetadata {
  name: string;
  symbol: string;
  uri?: string;
  /**
   * Who may rewrite all three. Absent means nobody can — which is a fact worth
   * having, because a mint whose text is still editable can be called one thing
   * when you buy it and another thing afterwards, at the same address.
   *
   * Only populated for a Token-2022 record, where an all-zero authority means
   * immutable and says so unambiguously. Metaplex spells mutability out in a
   * separate flag past variable-length creator data, so it is left unclaimed
   * rather than guessed at.
   */
  updateAuthority?: string;
}

/** The metadata account for a mint is a PDA — derivable, so no lookup is needed. */
function metadataPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    METADATA_PROGRAM_ID,
  )[0];
}

/**
 * Pull `name` and `symbol` out of a Metaplex metadata account.
 *
 * Layout: a one-byte key, a 32-byte update authority, the 32-byte mint, then
 * three Borsh strings — name, symbol, uri — each a u32 length followed by that
 * many bytes. Metaplex allocates fixed room and null-pads the remainder, so the
 * declared length is the *allocated* length and the trailing NULs come off.
 *
 * Returns null rather than throwing on anything unexpected. This runs against
 * whatever bytes an arbitrary account holds, and a wallet holding one mint with
 * a malformed metadata account must not lose the other forty-nine balances.
 */
function decodeMintMetadata(data: Uint8Array): MintMetadata | null {
  const view = Buffer.from(data);
  let offset = 1 + 32 + 32;

  const readString = (): string | null => {
    if (offset + 4 > view.length) return null;
    const length = view.readUInt32LE(offset);
    offset += 4;
    // A sane bound before slicing: these fields are allocated 32 and 10 bytes.
    if (length > 512 || offset + length > view.length) return null;
    const text = view.subarray(offset, offset + length).toString('utf8');
    offset += length;
    return text.replace(/ +$/, '');
  };

  const name = readString();
  const symbol = readString();
  if (name === null || symbol === null) return null;
  const uri = readString() ?? undefined;
  // No update authority is read here, on purpose. Metaplex spells mutability
  // out in an `isMutable` flag sitting past variable-length creator data, and
  // the authority field alone does not settle whether the text can be changed.
  // Leaving it unclaimed is better than a confident wrong answer — and the
  // audit says it is unclaimed rather than staying quiet about it.
  return { name, symbol, uri };
}

/**
 * Walk a mint account's TLV extensions.
 *
 * Runs against whatever bytes an account holds, so every bound is checked and
 * anything unexpected ends the walk rather than throwing: a wallet holding one
 * malformed mint must not lose its other forty-nine balances. A legacy SPL mint
 * is 82 bytes with no padding and no TLV after it, so the walk starts past the
 * end of it and finds nothing, which is the right answer for it.
 */
function tlvExtensions(data: Uint8Array): Map<number, Buffer> {
  const found = new Map<number, Buffer>();
  const view = Buffer.from(data);
  let offset = EXTENSION_TLV_START;

  while (offset + 4 <= view.length) {
    const type = view.readUInt16LE(offset);
    const length = view.readUInt16LE(offset + 2);
    offset += 4;
    if (type === 0 || offset + length > view.length) break;
    // First entry of a type wins. A duplicate is malformed either way, and
    // taking the later one would let trailing bytes overwrite a real field.
    if (!found.has(type)) found.set(type, view.subarray(offset, offset + length));
    offset += length;
  }

  return found;
}

/**
 * Decode a `TokenMetadata` record: an update authority, the mint it describes,
 * then three Borsh strings — name, symbol, uri.
 *
 * Unlike Metaplex these lengths are exact rather than allocated, so nothing is
 * null-padded. The check worth having is the second field. A `MetadataPointer`
 * is set by whoever controls the mint and may name **any** account on the chain,
 * so without it, pointing a worthless mint at USDC's metadata record would make
 * that mint read as USD Coin in every balance this tool prints — impersonation
 * at no deployment cost, against the one field a reader treats as identity. A
 * record naming a different mint is not this mint's name, so it is dropped
 * rather than shown with a caveat; the mint falls back to its address, which is
 * what this tool shows when it does not know a name.
 */
function decodeTokenMetadataExtension(data: Uint8Array, mint: string): MintMetadata | null {
  const view = Buffer.from(data);
  if (view.length < 64) return null;

  let declared: string;
  try {
    declared = new PublicKey(view.subarray(32, 64)).toBase58();
  } catch {
    return null;
  }
  if (declared !== mint) return null;

  let offset = 64;
  const readString = (): string | null => {
    if (offset + 4 > view.length) return null;
    const length = view.readUInt32LE(offset);
    offset += 4;
    // Same bound as the Metaplex decoder: these are a name and a ticker.
    if (length > 512 || offset + length > view.length) return null;
    const text = view.subarray(offset, offset + length).toString('utf8');
    offset += length;
    return text.replace(/\u0000+$/, '').replace(/ +$/, '');
  };

  const name = readString();
  const symbol = readString();
  if (name === null || symbol === null) return null;
  const uri = readString() ?? undefined;

  // The first 32 bytes are an `OptionalNonZeroPubkey`: all zeroes means nobody
  // can rewrite the name, the ticker or the link, ever. Unlike Metaplex, that
  // is unambiguous from these bytes alone, which is why it is claimed here and
  // not there.
  let updateAuthority: string | undefined;
  try {
    const authority = new PublicKey(view.subarray(0, 32)).toBase58();
    if (authority !== UNSET_PUBKEY) updateAuthority = authority;
  } catch {
    // An unreadable authority is not a claim that there is none.
    updateAuthority = undefined;
  }

  return { name, symbol, uri, updateAuthority };
}

/** Where a `MetadataPointer` says the text lives: an authority, then the address. */
function metadataPointerTarget(data: Uint8Array): string | null {
  if (data.length < 64) return null;
  try {
    const target = new PublicKey(Buffer.from(data).subarray(32, 64)).toBase58();
    return target === UNSET_PUBKEY ? null : target;
  } catch {
    return null;
  }
}

/**
 * Read metadata for a set of mints, in as few round trips as possible.
 *
 * Three passes, cheapest first, each one covering only the mints the pass before
 * it could not name: the Metaplex PDA, then the mint account itself for a
 * Token-2022 mint carrying its text inline, then a pointed-to account for one
 * that keeps it elsewhere. A wallet of ordinary SPL tokens still costs exactly
 * one round trip, which is what the ordering is for.
 *
 * The failure path is the interesting one. If this throws and the caller
 * swallows it, every mint silently falls back to its short address — which
 * reads exactly like "these tokens have no names" and, worse, means the
 * impersonation check never ran while the result looks like it found nothing.
 * That is the shape of every bug in this repo's history, so a failure is
 * returned as a value and the caller is obliged to say so.
 */
async function readMintMetadata(
  connection: Connection,
  mints: string[],
): Promise<{ found: Map<string, MintMetadata>; failure?: string }> {
  const found = new Map<string, MintMetadata>();
  if (!mints.length) return { found };

  const batched = async <T>(keys: T[], read: (batch: T[]) => Promise<void>): Promise<void> => {
    for (let start = 0; start < keys.length; start += ACCOUNT_BATCH) {
      await read(keys.slice(start, start + ACCOUNT_BATCH));
    }
  };

  try {
    await batched(mints, async (batch) => {
      const accounts = await connection.getMultipleAccountsInfo(
        batch.map((mint) => metadataPda(new PublicKey(mint))),
      );
      accounts.forEach((account, index) => {
        if (!account?.data) return;
        const decoded = decodeMintMetadata(account.data);
        if (decoded) found.set(batch[index]!, decoded);
      });
    });

    // Pass two: a Token-2022 mint keeps its text inside the mint account.
    const unnamed = mints.filter((mint) => !found.has(mint));
    const elsewhere: Array<{ mint: string; account: string }> = [];

    await batched(unnamed, async (batch) => {
      const accounts = await connection.getMultipleAccountsInfo(
        batch.map((mint) => new PublicKey(mint)),
      );
      accounts.forEach((account, index) => {
        const mint = batch[index]!;
        if (!account?.data) return;
        const extensions = tlvExtensions(account.data);

        const inline = extensions.get(EXT_TOKEN_METADATA);
        if (inline) {
          const decoded = decodeTokenMetadataExtension(inline, mint);
          if (decoded) found.set(mint, decoded);
          return;
        }

        const pointer = extensions.get(EXT_METADATA_POINTER);
        const target = pointer ? metadataPointerTarget(pointer) : null;
        // A pointer naming the mint itself is the inline case, and there was no
        // inline record to find — so there is nothing further to read.
        if (target && target !== mint) elsewhere.push({ mint, account: target });
      });
    });

    // Pass three: follow the pointer. Same record, same mint check — which is
    // what makes reading an account an attacker chose safe to do at all.
    await batched(elsewhere, async (batch) => {
      const accounts = await connection.getMultipleAccountsInfo(
        batch.map((entry) => new PublicKey(entry.account)),
      );
      accounts.forEach((account, index) => {
        const { mint } = batch[index]!;
        if (!account?.data) return;
        const decoded = decodeTokenMetadataExtension(account.data, mint);
        if (decoded) found.set(mint, decoded);
      });
    });

    return { found };
  } catch (err) {
    // Partial results are kept: the mints already read are genuinely read, and
    // the failure covers the rest.
    return { found, failure: (err as Error).message };
  }
}

function knownMintSymbol(chainId: string, mint: string): { symbol: string; name: string } | undefined {
  let index = mintIndexCache.get(chainId);
  if (!index) {
    index = new Map(knownTokens(chainId).map((t) => [t.address, { symbol: t.symbol, name: t.name }]));
    mintIndexCache.set(chainId, index);
  }
  return index.get(mint);
}

/** Extension ids this tool can name, for the list the audit shows verbatim. */
const EXTENSION_NAMES: Record<number, string> = {
  1: 'transferFeeConfig',
  3: 'mintCloseAuthority',
  4: 'confidentialTransferMint',
  6: 'defaultAccountState',
  9: 'nonTransferable',
  10: 'interestBearingConfig',
  12: 'permanentDelegate',
  14: 'transferHook',
  16: 'confidentialTransferFeeConfig',
  18: 'metadataPointer',
  19: 'tokenMetadata',
  20: 'groupPointer',
  21: 'tokenGroup',
  22: 'groupMemberPointer',
  23: 'tokenGroupMember',
};

/** A `COption<Pubkey>`: a four-byte tag, then the key. Tag 0 means none. */
function readOptionalAuthority(view: Buffer, offset: number): string | undefined {
  if (offset + 36 > view.length) return undefined;
  if (view.readUInt32LE(offset) !== 1) return undefined;
  try {
    return new PublicKey(view.subarray(offset + 4, offset + 36)).toBase58();
  } catch {
    return undefined;
  }
}

/** The first 32 bytes of an extension, where that is where its authority lives. */
function readAuthority(data: Buffer, offset = 0): string | undefined {
  if (data.length < offset + 32) return undefined;
  try {
    const key = new PublicKey(data.subarray(offset, offset + 32)).toBase58();
    return key === UNSET_PUBKEY ? undefined : key;
  } catch {
    return undefined;
  }
}

/**
 * What a mint's own account says about itself.
 *
 * This exists because the questions people actually ask about a token — can
 * more be printed, can my account be frozen, can somebody take these out of my
 * wallet, can the name change after I buy — are all answerable from one account
 * read, and are answered almost nowhere. A wallet shows a balance and a ticker.
 * The ticker is a string the deployer chose, and every one of those powers is a
 * field sitting next to it.
 *
 * Two things this deliberately does not do. It does not fetch the metadata
 * `uri`: that is a URL an attacker picks, and fetching it would turn a chain
 * read into an outbound request to an address of their choosing, from whatever
 * host this runs on. And it does not return a verdict — see `MintPower` for
 * why a score would be the one kind of wrong answer this tool must not give.
 */
export async function auditMint(chain: ChainSpec, mintAddress: string): Promise<MintAudit> {
  const mint = requirePubkey(mintAddress, 'mint address');

  return withConnection(chain, 'auditMint', async (connection) => {
    const info = await connection.getAccountInfo(mint);
    if (!info?.data || info.data.length < MINT_BASE_SIZE) {
      throw new SingularityError(
        'NOT_A_MINT',
        `${shortAddress(mint.toBase58())} is not an SPL mint on ${chain.name}.`,
        'Pass the mint address, not a token account or a wallet.',
      );
    }

    const programId = info.owner;
    const isToken2022 = programId.equals(TOKEN_2022_PROGRAM_ID);
    if (!isToken2022 && !programId.equals(TOKEN_PROGRAM_ID)) {
      throw new SingularityError(
        'NOT_A_MINT',
        `${shortAddress(mint.toBase58())} is owned by ${shortAddress(programId.toBase58())}, which is not a token program on ${chain.name}.`,
        'An account can look like a mint and be something else entirely; the owning program is what settles it.',
      );
    }

    const view = Buffer.from(info.data);
    const decimals = view.readUInt8(MINT_DECIMALS_OFFSET);
    const rawSupply = view.readBigUInt64LE(36);
    const extensions = isToken2022 ? tlvExtensions(view) : new Map<number, Buffer>();

    const powers: MintPower[] = [];
    const settled: string[] = [];

    const mintAuthority = readOptionalAuthority(view, 0);
    if (mintAuthority) {
      powers.push({
        kind: 'mint',
        holder: mintAuthority,
        what: 'More of this token can be created at any time, diluting every existing holder.',
      });
    } else {
      settled.push('Supply is fixed: the mint authority is revoked, so no more can ever be created.');
    }

    const freezeAuthority = readOptionalAuthority(view, 46);
    if (freezeAuthority) {
      powers.push({
        kind: 'freeze',
        holder: freezeAuthority,
        what: 'Any holder\u2019s account can be frozen, leaving the balance visible and unsendable.',
      });
    } else {
      settled.push('No account can be frozen: the freeze authority is revoked.');
    }

    const closeAuthority = extensions.get(EXT_MINT_CLOSE_AUTHORITY);
    if (closeAuthority) {
      powers.push({
        kind: 'close-mint',
        holder: readAuthority(closeAuthority),
        what: 'The mint account itself can be closed once supply reaches zero, after which the address can be reused for something else.',
      });
    }

    const delegate = extensions.get(EXT_PERMANENT_DELEGATE);
    if (delegate) {
      powers.push({
        kind: 'permanent-delegate',
        holder: readAuthority(delegate),
        what: 'One address can transfer or burn these tokens out of any wallet holding them, at any time, without the holder signing.',
      });
    }

    const hook = extensions.get(EXT_TRANSFER_HOOK);
    if (hook) {
      const program = readAuthority(hook, 32);
      powers.push({
        kind: 'transfer-hook',
        holder: readAuthority(hook),
        // Worth telling apart: with no program set nothing runs on a transfer
        // today, and calling that "every transfer calls a program" would be
        // false about several large stablecoins. The power is still real — the
        // authority can set one whenever it likes — so it stays in the list.
        what: program
          ? `Every transfer calls program ${program}, which can make transfers fail on conditions its author chooses.`
          : 'No hook program is set, so transfers run normally today — but the hook authority can set one at any time, after which every transfer calls it and can be made to fail.',
      });
    }

    if (extensions.has(EXT_TRANSFER_FEE_CONFIG)) {
      powers.push({
        kind: 'transfer-fee',
        holder: readAuthority(extensions.get(EXT_TRANSFER_FEE_CONFIG)!),
        what: 'A fee is withheld from every transfer, so a recipient receives less than was sent. The rate is set on the mint and is not decoded here.',
      });
    }

    const defaultState = extensions.get(EXT_DEFAULT_ACCOUNT_STATE);
    // State 2 is frozen; 1 is the ordinary initialized state and means nothing.
    if (defaultState?.length && defaultState.readUInt8(0) === 2) {
      powers.push({
        kind: 'default-frozen',
        what: 'New token accounts for this mint are created frozen, so a buyer can receive it and be unable to send it until somebody thaws them.',
      });
    }

    if (extensions.has(EXT_NON_TRANSFERABLE)) {
      powers.push({
        kind: 'non-transferable',
        what: 'This token cannot be transferred at all. A holder can only burn it.',
      });
    }

    const interest = extensions.get(EXT_INTEREST_BEARING);
    if (interest) {
      powers.push({
        kind: 'interest-bearing',
        holder: readAuthority(interest),
        what: 'The displayed balance grows by a rate set on the mint. The underlying amount does not change, so a UI figure and the real balance are different numbers.',
      });
    }

    if (extensions.has(EXT_CONFIDENTIAL_TRANSFER)) {
      powers.push({
        kind: 'confidential-transfer',
        what: 'Balances and transfer amounts can be held encrypted, so a public balance read is not the whole holding.',
      });
    }

    const { found, failure } = await readMintMetadata(connection, [mint.toBase58()]);
    const raw = found.get(mint.toBase58());
    const curated = knownMintSymbol(chain.id, mint.toBase58());

    // Only a Token-2022 record settles mutability, and it settles it both ways:
    // an all-zero update authority means the text can never be rewritten. A
    // Metaplex name is left `unknown` rather than assumed either way.
    const mutability = !raw
      ? 'unknown'
      : !extensions.has(EXT_TOKEN_METADATA)
        ? 'unknown'
        : raw.updateAuthority
          ? 'mutable'
          : 'immutable';

    const metadata = raw
      ? {
          name: sanitizeOnchainText(raw.name, ''),
          symbol: sanitizeOnchainText(raw.symbol, ''),
          mutability: mutability as 'immutable' | 'mutable' | 'unknown',
          uri: untrustedText(raw.uri, 'the metadata link on the mint, chosen by whoever deployed it'),
          untrusted: true as const,
        }
      : undefined;

    if (raw?.updateAuthority) {
      powers.push({
        kind: 'metadata-update',
        holder: raw.updateAuthority,
        what: 'The name, ticker and metadata link can all be rewritten, at this same address, after anyone buys.',
      });
    } else if (raw && extensions.has(EXT_TOKEN_METADATA)) {
      settled.push(
        'The name and ticker are immutable: the metadata update authority is revoked, so the text cannot be rewritten later.',
      );
    }

    // Only where a deployer actually chose the string. A curated mint carries
    // this tool's own text, and there is nothing to impersonate itself with.
    const impersonation =
      metadata && !curated
        ? checkImpersonation(chain, {
            symbol: metadata.symbol,
            name: metadata.name,
            address: mint.toBase58(),
          })
        : undefined;

    // A Token-2022 record settles mutability either way. A Metaplex one does
    // not, and silence there would read as "nothing can change" — the same
    // shape of wrong answer as an empty list reading as "holds nothing".
    const mutabilityUnknown = Boolean(raw) && !extensions.has(EXT_TOKEN_METADATA);

    const unnamed = extensions.size
      ? [...extensions.keys()].filter((id) => !EXTENSION_NAMES[id]).length
      : 0;

    return {
      chain: chain.id,
      mint: mint.toBase58(),
      program: isToken2022 ? 'token-2022' : 'spl-token',
      decimals,
      supply: amount(rawSupply, decimals, curated?.symbol ?? metadata?.symbol ?? 'tokens'),
      metadata,
      powers,
      settled,
      // Unrecognized ids are listed as ids rather than dropped, for the same
      // reason an unrecognized log keeps its topic: a short list reads as a
      // short list of what is there, not of what was understood.
      extensions: [...extensions.keys()]
        .sort((a, b) => a - b)
        .map((id) => EXTENSION_NAMES[id] ?? `extension ${id}`),
      ...(impersonation ? { impersonation } : {}),
      completeness: completeness.exhaustive(
        `Every authority and extension on the mint account, read in one go.${
          failure
            ? ` The metadata could not be read (${sanitizeOnchainText(failure, 'the RPC gave no reason')}), so the name, ticker and any impersonation finding are missing — not absent.`
            : ''
        }${unnamed ? ` ${unnamed} extension(s) present here have no description in this tool and are listed by id.` : ''}${
          mutabilityUnknown
            ? ' The name came from a Metaplex metadata account, whose mutability flag sits past variable-length creator data and is not decoded here, so whether this text can be rewritten later is unknown rather than settled.'
            : ''
        }`,
      ),
      note:
        'This says what the mint account permits, and nothing else. It is not a verdict on whether the token is worth holding: liquidity, who owns the supply, and what the deployer does next are not in these bytes. ' +
        (metadata?.uri
          ? 'The metadata link is reported as found and deliberately not fetched — it is a URL chosen by whoever deployed the mint.'
          : ''),
      explorerUrl: explorerUrl(chain, 'address', mint.toBase58()),
    } satisfies MintAudit;
  });
}

/** Manual BurnChecked, alongside the hand-rolled TransferChecked above. */
function burnCheckedInstruction(args: {
  account: PublicKey;
  mint: PublicKey;
  owner: PublicKey;
  value: bigint;
  decimals: number;
  programId: PublicKey;
}): TransactionInstruction {
  const data = Buffer.alloc(10);
  data.writeUInt8(IX_BURN_CHECKED, 0);
  data.writeBigUInt64LE(args.value, 1);
  data.writeUInt8(args.decimals, 9);

  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: args.account, isSigner: false, isWritable: true },
      { pubkey: args.mint, isSigner: false, isWritable: true },
      { pubkey: args.owner, isSigner: true, isWritable: false },
    ],
    data,
  });
}

/** A memo instruction: the text, and the signer it is attributable to. */
function memoInstruction(text: string, signer: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [{ pubkey: signer, isSigner: true, isWritable: false }],
    data: Buffer.from(text, 'utf8'),
  });
}

/**
 * Build an unsigned burn.
 *
 * The only write this tool can honestly stand behind. A burn has no receiving
 * end, so unlike "send it to the treasury" there is no key to trust, nothing to
 * rug, and no custody to explain — the holder signs it in their own wallet,
 * exactly as with a transfer, and the effect is then verifiable by anyone,
 * because supply is public.
 *
 * It is also the one payload here that destroys something, so everything below
 * is refused rather than built when it cannot land. An irreversible instruction
 * is the wrong place to find out that an assumption was wrong, and every reason
 * for refusing here is a fact read off the chain rather than a guess at intent.
 */
export async function buildBurn(
  chain: ChainSpec,
  params: { owner: string; mint: string; amount: string; memo?: string },
): Promise<UnsignedTx> {
  const owner = requirePubkey(params.owner, 'owner address');
  const mint = requirePubkey(params.mint, 'mint address');

  return withConnection(chain, 'buildBurn', async (connection) => {
    const facts = await readMintFacts(connection, mint, chain);
    const value = parseUnits(params.amount, facts.decimals);

    if (value === 0n) {
      throw new SingularityError(
        'BURN_AMOUNT_ZERO',
        `${params.amount} rounds to zero at ${facts.decimals} decimals, so this burn would destroy nothing.`,
        'Pass an amount of at least one base unit.',
      );
    }

    const account = deriveAta(owner, mint, facts.programId);
    const info = await connection.getAccountInfo(account);

    if (!info?.data || info.data.length < TOKEN_ACCOUNT_STATE_OFFSET + 1) {
      throw new SingularityError(
        'NO_TOKEN_ACCOUNT',
        `${shortAddress(owner.toBase58())} holds no token account for mint ${shortAddress(mint.toBase58())} on ${chain.name}.`,
        `Its associated token account under ${facts.programId.toBase58()} would be ${account.toBase58()}, and that account does not exist. Nothing can be burned from an account that was never created.`,
      );
    }

    const view = Buffer.from(info.data);
    const held = view.readBigUInt64LE(TOKEN_ACCOUNT_AMOUNT_OFFSET);

    if (view.readUInt8(TOKEN_ACCOUNT_STATE_OFFSET) === TOKEN_ACCOUNT_FROZEN) {
      throw new SingularityError(
        'TOKEN_ACCOUNT_FROZEN',
        `Token account ${shortAddress(account.toBase58())} is frozen, and a frozen account cannot burn.`,
        'Whoever holds the freeze authority has to thaw it first; mint_audit names that address.',
      );
    }

    if (held < value) {
      throw new SingularityError(
        'INSUFFICIENT_BALANCE',
        `That account holds ${formatUnits(held, facts.decimals)} and the burn asks for ${params.amount}.`,
        'A burn larger than the balance fails on submission. Amounts here are whole tokens, never base units.',
      );
    }

    const transaction = new Transaction();
    transaction.add(
      burnCheckedInstruction({
        account,
        mint,
        owner,
        value,
        decimals: facts.decimals,
        programId: facts.programId,
      }),
    );

    if (params.memo !== undefined) {
      const memo = params.memo.trim();
      if (!memo) {
        throw new SingularityError(
          'EMPTY_MEMO',
          'A memo of nothing attaches this burn to nobody.',
          'Leave the memo off entirely, or pass the claim this burn is meant to satisfy.',
        );
      }
      if (Buffer.byteLength(memo, 'utf8') > MAX_MEMO_LENGTH) {
        throw new SingularityError(
          'MEMO_TOO_LONG',
          `That memo is ${Buffer.byteLength(memo, 'utf8')} bytes, and the limit here is ${MAX_MEMO_LENGTH}.`,
          'A memo carries a claim, not a document.',
        );
      }

      transaction.add(memoInstruction(memo, owner));
    }

    transaction.feePayer = owner;
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;

    const warnings = [
      'This transaction is unsigned. Review every field before signing.',
      'A burn is irreversible. These tokens are destroyed rather than moved — nobody receives them, and nobody can send them back.',
      `After it lands, ${shortAddress(owner.toBase58())} holds ${formatUnits(held - value, facts.decimals)} of this mint.`,
    ];

    if (params.memo) {
      warnings.push(
        'The memo is written into the transaction and is public and permanent, the same as everything else in it. It is what lets this burn be credited to you rather than to whoever quotes the signature first.',
      );
    }

    if (chain.testnet) {
      warnings.push(`${chain.name} is a test network — these tokens have no value.`);
    }

    // The fact that decides whether a burn means anything at all. With a live
    // mint authority, a burn reduces one balance and the supply can be put
    // straight back — every claim of deflation built on that is a claim about
    // somebody's restraint rather than about the chain.
    if (facts.mintAuthority) {
      warnings.push(
        `This mint can still create more tokens (mint authority ${facts.mintAuthority}), so burning reduces your balance without permanently reducing supply.`,
      );
    }

    if (facts.extensions.has(EXT_PERMANENT_DELEGATE)) {
      warnings.push(
        'This mint has a permanent delegate, which can already burn these tokens out of any wallet without the holder signing anything.',
      );
    }

    return {
      chain: chain.id,
      family: 'svm',
      // The mint address, never its name: nothing read off the chain is
      // interpolated into a summary, and a burn is the last place to start.
      summary: `Burn ${params.amount} tokens of mint ${shortAddress(mint.toBase58())} held by ${shortAddress(owner.toBase58())} on ${chain.name}. This destroys them permanently.`,
      payload: {
        transaction: transaction
          .serialize({ requireAllSignatures: false, verifySignatures: false })
          .toString('base64'),
        encoding: 'base64',
        feePayer: owner.toBase58(),
        recentBlockhash: blockhash,
        lastValidBlockHeight,
      },
      signingHint:
        'Base64 wire-format transaction. Deserialize with Transaction.from(Buffer.from(tx, "base64")), sign, then sendRawTransaction. The blockhash expires in ~60 seconds — rebuild if it lapses.',
      warnings,
    } satisfies UnsignedTx;
  });
}

/** The token programs a burn can come from, as jsonParsed labels them. */
const BURN_PROGRAMS = new Set(['spl-token', 'spl-token-2022']);

/** A parsed instruction, in the shape the RPC actually returns one. */
interface ParsedIx {
  program?: string;
  parsed?: { type?: string; info?: Record<string, unknown> } | string;
}

/**
 * Confirm a burn from its signature.
 *
 * The redemption half of `buildBurn`, and the reason a burn can be a sink at
 * all: the agent signs nothing and holds nothing, so the only thing that can
 * make a burn *mean* something afterwards is a read anybody else can repeat.
 *
 * Three things this is careful about.
 *
 * **Finality.** A transaction that is merely confirmed can still be dropped.
 * Reading at any weaker commitment would mean crediting a burn that might not
 * survive, so this asks for a finalized transaction and tells the two failure
 * modes apart: a signature the cluster still knows but has not finalized is a
 * "come back in a moment", and one it has never heard of is something else
 * entirely.
 *
 * **Burns are found by instruction, not by balance arithmetic.** A falling
 * token balance is also what a transfer looks like. Both spellings count —
 * `burn` and `burnChecked` — and inner instructions are walked too, because a
 * burn reached through a program is still a burn.
 *
 * **The mint comes from the chain, never from the caller.** `burn` does not
 * name its mint, so it is resolved through the transaction’s own token
 * balances. A caller who says which mint they expect is checked against that,
 * rather than trusted to label it.
 */
export async function verifyBurn(chain: ChainSpec, rawSignature: string): Promise<BurnReceipt> {
  const signature = requireSignature(rawSignature);

  return withConnection(chain, `verifyBurn`, async (connection) => {
    const tx = await connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: MAX_TX_VERSION,
      commitment: 'finalized',
    });

    if (!tx) {
      // Worth one extra call to separate "not yet" from "not there". Telling a
      // holder their burn does not exist when it merely has not finalized is
      // a wrong answer about the one thing they cannot redo.
      const status = await connection
        .getSignatureStatuses([signature])
        .then((result) => result.value[0])
        .catch(() => null);

      if (status) {
        throw new SingularityError(
          'BURN_NOT_FINAL',
          `Signature ${shortAddress(signature, 10, 8)} is ${status.confirmationStatus ?? "known"} but not finalized on ${chain.name}.`,
          'A transaction below finalized commitment can still be dropped, so it is not evidence of anything yet. Try again in a few seconds.',
        );
      }

      throw new SingularityError(
        'TX_NOT_FOUND',
        `Signature ${shortAddress(signature, 10, 8)} was not found on ${chain.name}.`,
        'Solana public RPCs prune history aggressively, so this is either a signature that never landed or one old enough to need an archival endpoint. The two are indistinguishable from here.',
      );
    }

    if (tx.meta?.err != null) {
      throw new SingularityError(
        'TX_FAILED',
        `Transaction ${shortAddress(signature, 10, 8)} failed, so nothing was burned.`,
        'A failed transaction changes no balances. Whatever it was meant to do, it did not happen.',
      );
    }

    const keys = tx.transaction.message.accountKeys.map((key) => key.pubkey.toBase58());

    // Token accounts are described in the metadata rather than the instruction,
    // and this is what lets an unchecked `burn` be resolved to a mint at all.
    const described = new Map<string, { mint: string; owner?: string; decimals: number }>();
    for (const entry of [...(tx.meta?.preTokenBalances ?? []), ...(tx.meta?.postTokenBalances ?? [])]) {
      const address = keys[entry.accountIndex];
      if (!address || described.has(address)) continue;
      described.set(address, {
        mint: entry.mint,
        owner: entry.owner ?? undefined,
        decimals: entry.uiTokenAmount.decimals,
      });
    }

    const instructions: ParsedIx[] = [
      ...(tx.transaction.message.instructions as ParsedIx[]),
      ...(tx.meta?.innerInstructions ?? []).flatMap((inner) => inner.instructions as ParsedIx[]),
    ];

    const burns: BurnEvent[] = [];
    let memo: UntrustedText | undefined;

    for (const instruction of instructions) {
      if (instruction.program === 'spl-memo' && typeof instruction.parsed === 'string') {
        memo ??= untrustedText(instruction.parsed, `a memo written by whoever signed this transaction`);
        continue;
      }

      if (!instruction.program || !BURN_PROGRAMS.has(instruction.program)) continue;
      if (!instruction.parsed || typeof instruction.parsed === 'string') continue;

      const { type, info } = instruction.parsed;
      if (type !== 'burn' && type !== 'burnChecked') continue;
      if (!info) continue;

      const account = typeof info.account === 'string' ? info.account : undefined;
      if (!account) continue;
      const context = described.get(account);

      // burnChecked names its mint and decimals; burn names neither, so both
      // come from the transaction metadata for that account.
      const checked = info.tokenAmount as { amount?: string; decimals?: number } | undefined;
      const raw = checked?.amount ?? (typeof info.amount === 'string' ? info.amount : undefined);
      const mint = (typeof info.mint === 'string' ? info.mint : undefined) ?? context?.mint;
      const decimals = checked?.decimals ?? context?.decimals;

      if (raw === undefined || mint === undefined || decimals === undefined) continue;

      const owner =
        (typeof info.authority === 'string' ? info.authority : undefined) ??
        (typeof info.multisigAuthority === 'string' ? info.multisigAuthority : undefined) ??
        context?.owner;

      burns.push({
        mint,
        owner: owner ?? '',
        account,
        amount: amount(BigInt(raw), decimals, 'tokens'),
      });
    }

    if (!burns.length) {
      throw new SingularityError(
        'NO_BURN_IN_TRANSACTION',
        `Transaction ${shortAddress(signature, 10, 8)} contains no burn.`,
        'A falling token balance is also what a transfer looks like. This checks for a burn instruction, and there is none here — including in the inner instructions.',
      );
    }

    return {
      chain: chain.id,
      signature,
      slot: tx.slot,
      ...(tx.blockTime ? { timestamp: toIso(tx.blockTime) } : {}),
      burns,
      ...(memo ? { memo } : {}),
      completeness: completeness.exhaustive(
        'Every burn instruction in this transaction, top level and inner, read at finalized commitment.',
      ),
      note:
        'This proves a burn happened: that mint, that owner, that amount, final. It proves nothing about whoever handed you the signature — signatures are public the moment they land, so anyone can quote somebody else\u2019s burn. Bind a burn to a claimant by what the burner wrote into it, which they signed, not by who repeats it.',
      explorerUrl: explorerUrl(chain, `tx`, signature),
    } satisfies BurnReceipt;
  });
}

// ───────────────────────────────────────────────────────────────── payments

/**
 * What accepting this mint exposes a merchant to after the money arrives.
 *
 * The distinction this makes, and that `mint_audit` does not, is between
 * *dilution* and *custody*. A live mint authority means the supply can grow,
 * which is a pricing problem. A live freeze authority or a permanent delegate
 * means the balance you were just paid is held at somebody else's discretion,
 * which is a different category: you can ship the goods and then lose the
 * money, with nothing on chain to appeal to.
 *
 * `custodyIsYours` turns only on the second kind. It is the one bit a merchant
 * actually has to decide on, and it is deliberately not a score.
 */
export async function assessMintRisk(chain: ChainSpec, mintAddress: string): Promise<MintRisk> {
  const mint = requirePubkey(mintAddress, 'mint address');
  const short = shortAddress(mint.toBase58());

  return withConnection(chain, 'assessMintRisk', async (connection) => {
    const facts = await readMintFacts(connection, mint, chain);

    const delegateData = facts.extensions.get(EXT_PERMANENT_DELEGATE);
    const permanentDelegate = delegateData ? readAuthority(delegateData) : undefined;

    const hookData = facts.extensions.get(EXT_TRANSFER_HOOK);
    const transferHook = hookData ? readAuthority(hookData, 32) : undefined;

    const warnings: string[] = [];

    if (facts.freezeAuthority) {
      warnings.push(
        `${facts.freezeAuthority} can freeze token accounts for mint ${short}, including the one you are paid into. A frozen balance is still yours and cannot be moved, for as long as they choose.`,
      );
    }

    if (permanentDelegate) {
      warnings.push(
        `Mint ${short} has a permanent delegate (${permanentDelegate}) that can transfer or burn these tokens out of any wallet without the holder signing. Being paid in this token is not the same as keeping it.`,
      );
    }

    if (hookData) {
      warnings.push(
        transferHook
          ? `Every transfer of mint ${short} calls program ${transferHook}, which can make your outgoing payments fail on conditions the issuer controls.`
          : `Mint ${short} has a transfer hook extension with no program set. Whoever holds the hook authority can set one at any time, and ordinary transfers start failing when they do.`,
      );
    }

    if (facts.extensions.has(EXT_TRANSFER_FEE_CONFIG)) {
      warnings.push(
        `Mint ${short} charges a transfer fee, so you receive less than the amount sent. Price accordingly, or the payment will look short when it is not.`,
      );
    }

    if (facts.extensions.has(EXT_DEFAULT_ACCOUNT_STATE)) {
      warnings.push(
        `Mint ${short} sets a default account state, which can make newly created token accounts frozen on arrival. A first payment into a fresh account may be unusable immediately.`,
      );
    }

    if (facts.extensions.has(EXT_NON_TRANSFERABLE)) {
      warnings.push(
        `Mint ${short} is non-transferable. Whatever arrives cannot be sent anywhere afterwards.`,
      );
    }

    if (facts.mintAuthority) {
      // Deliberately not a custody warning. Supply growth is a reason to price
      // differently, not a reason to distrust the balance in hand.
      warnings.push(
        `Mint ${short} can still issue more supply (mint authority ${facts.mintAuthority}). That dilutes the token without affecting your claim on what you hold.`,
      );
    }

    const seizable = Boolean(facts.freezeAuthority || permanentDelegate);
    const nonTransferable = facts.extensions.has(EXT_NON_TRANSFERABLE);

    return {
      mint: mint.toBase58(),
      ...(facts.freezeAuthority ? { freezeAuthority: facts.freezeAuthority } : {}),
      ...(facts.mintAuthority ? { mintAuthority: facts.mintAuthority } : {}),
      ...(permanentDelegate ? { permanentDelegate } : {}),
      ...(transferHook ? { transferHook } : {}),
      custodyIsYours: !seizable && !nonTransferable,
      warnings,
    } satisfies MintRisk;
  });
}

/**
 * Create a recipient's associated token account, idempotently.
 *
 * The idempotent variant (discriminator 1) rather than plain create (0), for a
 * reason that is not theoretical: minutes pass between building a transaction
 * and signing it, and anyone at all may create this account in between —
 * creating an ATA needs no permission from its owner. Plain create fails in
 * that window and takes the payment down with it; idempotent create succeeds
 * either way.
 */
function createAtaIdempotent(params: {
  payer: PublicKey;
  account: PublicKey;
  owner: PublicKey;
  mint: PublicKey;
  programId: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: params.payer, isSigner: true, isWritable: true },
      { pubkey: params.account, isSigner: false, isWritable: true },
      { pubkey: params.owner, isSigner: false, isWritable: false },
      { pubkey: params.mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: params.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}

/**
 * A payment built for one specific order.
 *
 * Structurally a transfer, with one addition that changes what it is for: the
 * `references` are attached to the transfer instruction as read-only,
 * non-signer accounts. They do nothing on chain — no program reads them, no
 * balance touches them — and that is the point. They make the transaction
 * discoverable by a key only the merchant knew in advance, which is how a
 * payment is matched to an order without asking the payer to quote an id,
 * paste a memo, or be trusted about either.
 *
 * Built for the account the wallet sends, so nobody types their own address.
 */
export async function buildPayment(
  chain: ChainSpec,
  params: {
    payer: string;
    to: string;
    amount: string;
    mint?: string;
    memo?: string;
    references?: string[];
  },
): Promise<UnsignedTx> {
  const payer = requirePubkey(params.payer, 'payer address');
  const to = requirePubkey(params.to, 'recipient address');
  const references = (params.references ?? []).map((key) => requirePubkey(key, 'reference'));

  return withConnection(chain, 'buildPayment', async (connection) => {
    const transaction = new Transaction();
    const warnings = ['This transaction is unsigned. Review every field before signing.'];
    let summary: string;

    if (params.mint) {
      const mint = requirePubkey(params.mint, 'mint address');
      const facts = await readMintFacts(connection, mint, chain);
      const value = parseUnits(params.amount, facts.decimals);

      if (value === 0n) {
        throw new SingularityError(
          'PAYMENT_AMOUNT_ZERO',
          `${params.amount} rounds to zero at ${facts.decimals} decimals, so this payment would move nothing.`,
          'Pass an amount of at least one base unit.',
        );
      }

      const source = deriveAta(payer, mint, facts.programId);
      const destination = deriveAta(to, mint, facts.programId);

      const held = await connection.getAccountInfo(source).catch(() => null);
      if (!held?.data || held.data.length < TOKEN_ACCOUNT_AMOUNT_OFFSET + 8) {
        throw new SingularityError(
          'NO_TOKEN_ACCOUNT',
          `${shortAddress(payer.toBase58())} holds no token account for mint ${shortAddress(mint.toBase58())}, so it cannot pay in this token.`,
          `The associated token account would be ${source.toBase58()}, and it does not exist.`,
        );
      }

      const balance = Buffer.from(held.data).readBigUInt64LE(TOKEN_ACCOUNT_AMOUNT_OFFSET);
      if (balance < value) {
        throw new SingularityError(
          'INSUFFICIENT_BALANCE',
          `That account holds ${formatUnits(balance, facts.decimals)} and this payment asks for ${params.amount}.`,
          'The transaction would fail on submission. Amounts here are whole tokens, never base units.',
        );
      }

      const destinationExists = await connection.getAccountInfo(destination).catch(() => null);
      if (!destinationExists) {
        // Create it, rather than warning that the transfer will fail. Warning
        // alone hands back a transaction that cannot land, which is the thing
        // this whole path exists not to do — and a payee who has never held
        // the token is the ordinary case for a first payment, not an error.
        transaction.add(
          createAtaIdempotent({
            payer,
            account: destination,
            owner: to,
            mint,
            programId: facts.programId,
          }),
        );
        warnings.push(
          `The recipient had no token account for this mint (${destination.toBase58()}), so this transaction creates it before paying. That costs you about 0.002 SOL of rent, which goes to the account itself and is recoverable only by its owner.`,
        );
      }

      warnings.push(...transferExtensionWarnings(facts, mint, chain));

      const instruction = transferCheckedInstruction({
        source,
        mint,
        destination,
        owner: payer,
        value,
        decimals: facts.decimals,
        programId: facts.programId,
      });

      // Appended after the program's own accounts, which is where the Solana
      // Pay spec puts them and where a parser expects to find them.
      for (const reference of references) {
        instruction.keys.push({ pubkey: reference, isSigner: false, isWritable: false });
      }

      transaction.add(instruction);
      summary = `Pay ${params.amount} of mint ${shortAddress(mint.toBase58())} from ${shortAddress(payer.toBase58())} to ${shortAddress(to.toBase58())} on ${chain.name}.`;
    } else {
      const lamports = parseUnits(params.amount, chain.nativeCurrency.decimals);

      if (lamports === 0n) {
        throw new SingularityError(
          'PAYMENT_AMOUNT_ZERO',
          `${params.amount} rounds to zero lamports, so this payment would move nothing.`,
          'Pass an amount of at least one lamport.',
        );
      }

      const instruction = SystemProgram.transfer({
        fromPubkey: payer,
        toPubkey: to,
        lamports: Number(lamports),
      });

      for (const reference of references) {
        instruction.keys.push({ pubkey: reference, isSigner: false, isWritable: false });
      }

      transaction.add(instruction);
      summary = `Pay ${params.amount} SOL from ${shortAddress(payer.toBase58())} to ${shortAddress(to.toBase58())} on ${chain.name}.`;
    }

    if (params.memo !== undefined) {
      const memo = params.memo.trim();
      if (memo && Buffer.byteLength(memo, 'utf8') > MAX_MEMO_LENGTH) {
        throw new SingularityError(
          'MEMO_TOO_LONG',
          `That memo is ${Buffer.byteLength(memo, 'utf8')} bytes, and the limit here is ${MAX_MEMO_LENGTH}.`,
          'A memo carries a reference, not a document.',
        );
      }
      if (memo) transaction.add(memoInstruction(memo, payer));
    }

    if (chain.testnet) {
      warnings.push(`${chain.name} is a test network — these tokens have no value.`);
    }

    transaction.feePayer = payer;
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;

    return {
      chain: chain.id,
      family: 'svm',
      summary,
      payload: {
        transaction: transaction
          .serialize({ requireAllSignatures: false, verifySignatures: false })
          .toString('base64'),
        encoding: 'base64',
        feePayer: payer.toBase58(),
        recentBlockhash: blockhash,
        lastValidBlockHeight,
        references: references.map((key) => key.toBase58()),
      },
      signingHint:
        'Base64 wire-format transaction. Deserialize with Transaction.from(Buffer.from(tx, "base64")), sign, then sendRawTransaction. The blockhash expires in ~60 seconds — rebuild if it lapses.',
      warnings,
    } satisfies UnsignedTx;
  });
}

/**
 * Find the payment that satisfies a claim, and say how settled it is.
 *
 * The reference is the index: `getSignaturesForAddress` returns every
 * transaction that touched it, and a reference generated per order is touched
 * by exactly one — the payment for that order. Nothing has to be quoted by the
 * payer and nothing has to be trusted from them.
 *
 * Read in two passes on purpose. The signature list comes back at the caller's
 * commitment, so it can see a transaction that is confirmed but not yet
 * finalized; the transaction itself is then fetched and matched against the
 * claim. That ordering is what lets this report `probabilistic` honestly rather
 * than either lying about finality or pretending nothing is there yet.
 */
export async function findPayment(
  chain: ChainSpec,
  claim: PaymentClaim,
): Promise<PaymentSettlement> {
  const reference = requirePubkey(claim.reference, 'reference');
  const recipient = requirePubkey(claim.to, 'recipient address');

  return withConnection(chain, 'findPayment', async (connection) => {
    const signatures = await connection.getSignaturesForAddress(reference, { limit: 10 });

    if (signatures.length === 0) {
      return {
        level: 'unpaid',
        mismatches: [],
        note: `No transaction on ${chain.name} has touched reference ${shortAddress(reference.toBase58())}. That means this payment has not been made, has not propagated to this endpoint yet, or is old enough to have been pruned from it — the three are indistinguishable from here.`,
      } satisfies PaymentSettlement;
    }

    // Newest first is what the RPC returns; a reference is meant to be used
    // once, so anything beyond the first is either a retry or someone reusing
    // a reference they should not have.
    const candidate = signatures.find((entry) => entry.err == null);

    if (!candidate) {
      return {
        level: 'unpaid',
        signature: signatures[0]?.signature,
        mismatches: [],
        note: `Every transaction touching reference ${shortAddress(reference.toBase58())} failed, so no money moved. A failed transaction changes no balances.`,
      } satisfies PaymentSettlement;
    }

    const finalized = candidate.confirmationStatus === 'finalized';

    const tx = await connection.getParsedTransaction(candidate.signature, {
      maxSupportedTransactionVersion: MAX_TX_VERSION,
      commitment: finalized ? 'finalized' : 'confirmed',
    });

    if (!tx) {
      return {
        level: 'pending',
        signature: candidate.signature,
        mismatches: [],
        note: `Transaction ${shortAddress(candidate.signature, 10, 8)} is known to this endpoint but its contents are not retrievable yet. It has not settled.`,
      } satisfies PaymentSettlement;
    }

    const keys = tx.transaction.message.accountKeys.map((key) => key.pubkey.toBase58());
    const mismatches: string[] = [];

    let paidRaw = 0n;
    let decimals = chain.nativeCurrency.decimals;
    let symbol = chain.nativeCurrency.symbol;
    let paidMint: string | undefined;

    if (claim.mint) {
      // Token balances are reported in the metadata rather than the
      // instruction, which is what makes the destination resolvable to an
      // owner at all. The destination is matched by *owner*, not by token
      // account, because the account address depends on the token program and
      // a merchant should not have to know which one a mint uses.
      const wanted = requirePubkey(claim.mint, 'mint address').toBase58();

      const before = new Map<number, bigint>();
      for (const entry of tx.meta?.preTokenBalances ?? []) {
        before.set(entry.accountIndex, BigInt(entry.uiTokenAmount.amount));
      }

      for (const entry of tx.meta?.postTokenBalances ?? []) {
        if (entry.owner !== recipient.toBase58()) continue;
        const gained = BigInt(entry.uiTokenAmount.amount) - (before.get(entry.accountIndex) ?? 0n);
        if (gained <= 0n) continue;

        paidMint = entry.mint;
        decimals = entry.uiTokenAmount.decimals;
        if (entry.mint === wanted) paidRaw += gained;
      }

      if (paidMint && paidMint !== wanted) {
        // The failure this exists to catch: a ticker is not an identity, and a
        // payment in a mint that calls itself USDC lands exactly as cleanly as
        // one in the real thing.
        mismatches.push(
          `paid in mint ${paidMint}, but this order asked for ${wanted}. A token that shares a name with the one you asked for is a different token.`,
        );
      } else if (!paidMint) {
        mismatches.push(
          `no token balance of ${recipient.toBase58()} increased in this transaction, so it did not pay this recipient.`,
        );
      }

      symbol = '';
    } else {
      const index = keys.indexOf(recipient.toBase58());
      const pre = tx.meta?.preBalances?.[index];
      const post = tx.meta?.postBalances?.[index];

      if (index < 0 || pre === undefined || post === undefined) {
        mismatches.push(
          `${recipient.toBase58()} does not appear in this transaction, so it was not paid by it.`,
        );
      } else {
        paidRaw = BigInt(post) - BigInt(pre);
        if (paidRaw <= 0n) {
          mismatches.push(`the balance of ${recipient.toBase58()} did not increase in this transaction.`);
          paidRaw = 0n;
        }
      }
    }

    const expected = parseUnits(claim.amount, decimals);
    if (mismatches.length === 0 && paidRaw < expected) {
      mismatches.push(
        `paid ${formatUnits(paidRaw, decimals)} but the order asked for ${claim.amount}. A short payment is not a payment.`,
      );
    }

    let memo: UntrustedText | undefined;
    const instructions: ParsedIx[] = [
      ...(tx.transaction.message.instructions as ParsedIx[]),
      ...(tx.meta?.innerInstructions ?? []).flatMap((inner) => inner.instructions as ParsedIx[]),
    ];
    for (const instruction of instructions) {
      if (instruction.program === 'spl-memo' && typeof instruction.parsed === 'string') {
        memo = untrustedText(instruction.parsed, 'the payer, who wrote it into the transaction');
        break;
      }
    }

    if (claim.memo && !(memo?.text ?? '').includes(claim.memo)) {
      mismatches.push(
        `the memo does not contain ${JSON.stringify(claim.memo)}, which this order required.`,
      );
    }

    const level: SettlementLevel = finalized ? 'final' : 'probabilistic';
    const at = candidate.blockTime ? new Date(candidate.blockTime * 1000).toISOString() : undefined;

    const note =
      mismatches.length > 0
        ? `A transaction touched this reference but does not satisfy the order. Do not fulfil it: ${mismatches.length} check(s) failed.`
        : level === 'final'
          ? 'Paid in full, to the right account, in the right token, and finalized. This is irreversible.'
          : 'Paid in full and confirmed, but not finalized. A confirmed transaction can still be dropped, so this is not yet safe to ship against.';

    return {
      level,
      signature: candidate.signature,
      paid: amount(paidRaw, decimals, symbol),
      ...(keys[0] ? { from: keys[0] } : {}),
      ...(at ? { at } : {}),
      ...(memo ? { memo } : {}),
      mismatches,
      note,
      finality: finalized
        ? finality.final('Finalized by the cluster, which does not roll back.', { height: tx.slot })
        : finality.probabilistic(
            1,
            'Confirmed but not finalized. It can still be dropped.',
            { height: tx.slot },
          ),
    } satisfies PaymentSettlement;
  });
}

// ──────────────────────────────────────────────────────────── exit analysis

/**
 * Known pool and program accounts, so a large holder can be told apart from a
 * whale.
 *
 * A pool holding most of the supply is what a healthy market looks like; a
 * person holding most of the supply is the thing that empties it. Reporting
 * them identically would make the concentration figure useless in both
 * directions — and this list is short and incomplete, so the answer it feeds is
 * marked absent rather than false when nothing matches.
 */
const POOL_OWNERS = new Set([
  '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', // Raydium AMM v4 authority
  'GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ', // Raydium authority v4
  '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', // Serum/OpenBook
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', // Orca Whirlpools
]);

/**
 * What stands between buying this token and selling it again.
 *
 * Reads the mint account and the largest holders. Deliberately *not* a score:
 * it names mechanisms, because a mechanism can be checked and a score cannot.
 *
 * The limit that matters, and the reason `completeness` is never exhaustive: a
 * mint account says nothing about liquidity. Whether the pool is locked, how
 * deep it is, and whether a hook program is benign are all outside what this
 * can see. `canExit: true` means no mint-level mechanism blocks a sale. It does
 * not mean the token is safe to buy, and the note says so every time.
 */
export async function inspectTokenExit(
  chain: ChainSpec,
  mintAddress: string,
): Promise<TokenExitReport> {
  const mint = requirePubkey(mintAddress, 'mint address');
  const short = shortAddress(mint.toBase58());

  return withConnection(chain, 'inspectTokenExit', async (connection) => {
    const facts = await readMintFacts(connection, mint, chain);

    const delegateData = facts.extensions.get(EXT_PERMANENT_DELEGATE);
    const hookData = facts.extensions.get(EXT_TRANSFER_HOOK);
    const hookProgram = hookData ? readAuthority(hookData, 32) : undefined;

    // Flattened into plain data, then judged by `classifyExitRisks`. The
    // reading needs a network and is dull; the judging has opinions in it and
    // is worth testing against every combination without one.
    const risks = classifyExitRisks({
      mint: mint.toBase58(),
      ...(facts.mintAuthority ? { mintAuthority: facts.mintAuthority } : {}),
      ...(facts.freezeAuthority ? { freezeAuthority: facts.freezeAuthority } : {}),
      ...(delegateData ? { permanentDelegate: readAuthority(delegateData) } : {}),
      ...(hookProgram ? { transferHookProgram: hookProgram } : {}),
      hasTransferHookExtension: Boolean(hookData),
      hasTransferFee: facts.extensions.has(EXT_TRANSFER_FEE_CONFIG),
      hasDefaultAccountState: facts.extensions.has(EXT_DEFAULT_ACCOUNT_STATE),
      nonTransferable: facts.extensions.has(EXT_NON_TRANSFERABLE),
    });

    // ── how spread the supply is ────────────────────────────────────────
    // A failure here is a gap in the report, never a reason to fail the whole
    // call: the mint-level findings above are the valuable half and they are
    // already in hand.
    let concentration: Concentration | undefined;
    let concentrationNote = '';

    try {
      const [largest, supply] = await Promise.all([
        connection.getTokenLargestAccounts(mint),
        connection.getTokenSupply(mint),
      ]);

      const total = BigInt(supply.value.amount);
      const accounts = largest.value ?? [];

      if (total > 0n && accounts.length > 0) {
        const held = accounts.map((entry) => BigInt(entry.amount));
        const top = held.reduce((sum, value) => sum + value, 0n);
        const biggest = held[0] ?? 0n;

        // Basis points, so integer maths carries two decimals of precision.
        const pct = (part: bigint): number => Number((part * 10_000n) / total) / 100;

        const largestOwner = accounts[0]?.address?.toBase58();
        const owner = largestOwner
          ? await connection
              .getParsedAccountInfo(new PublicKey(largestOwner))
              .then((info) => {
                const data = info.value?.data;
                return data && 'parsed' in data
                  ? (data.parsed as { info?: { owner?: string } }).info?.owner
                  : undefined;
              })
              .catch(() => undefined)
          : undefined;

        concentration = {
          largestPercent: pct(biggest),
          topPercent: pct(top),
          accountsCounted: accounts.length,
          ...(owner ? { largestIsPool: POOL_OWNERS.has(owner) } : {}),
        };

        // A pool holding most of the supply is what a working market looks
        // like. A person holding it is the thing that empties one. Only the
        // second is worth warning about, and only when it is known which it is.
        if (concentration.largestPercent >= 25 && concentration.largestIsPool === false) {
          risks.push({
            mechanism: 'holder-concentration',
            severity: 'degrades',
            ...(owner ? { holder: owner } : {}),
            note: `One account holds ${concentration.largestPercent.toFixed(1)}% of supply and is not a recognised pool. They can exhaust the liquidity ahead of you, and your exit price is whatever is left.`,
          });
        }
      }
    } catch {
      concentrationNote =
        ' Holder distribution could not be read from this endpoint, so nothing here speaks to how concentrated the supply is.';
    }

    const blockers = risks.filter((risk) => risk.severity === 'blocks');
    const controlled = risks.filter((risk) => risk.severity === 'discretionary');
    const { canExit, underThirdPartyControl } = exitVerdict(risks);
    const ordered = sortBySeverity(risks);

    const holders = [...new Set(controlled.map((risk) => risk.holder).filter(Boolean))];

    const note = !canExit
      ? `${blockers.length} mechanism(s) in this mint stop a sale outright, with nobody having to act.${concentrationNote} Read each one before buying.`
      : underThirdPartyControl
        ? `Nothing stops a sale today, but ${holders.length === 1 ? `${holders[0]} can` : `${controlled.length} named parties can`} prevent one whenever they choose.${concentrationNote} Whether that is acceptable depends on who they are, which is why they are named rather than scored. This reads the mint, not the market — it says nothing about whether liquidity is locked or how deep the pool is.`
        : `No mechanism in this mint account prevents a sale, and no third party can freeze or seize the balance.${concentrationNote} That is not the same as safe to buy: this reads the mint, not the market, so it says nothing about whether liquidity is locked, how deep the pool is, or what the token is worth.`;

    return {
      mint: mint.toBase58(),
      chain: chain.id,
      canExit,
      underThirdPartyControl,
      risks: ordered,
      ...(concentration ? { concentration } : {}),
      // Never exhaustive, and the note says exactly why. A report that claimed
      // to have covered liquidity would be the most dangerous thing here.
      completeness: completeness.curated(
        'Covers what the mint account and its Token-2022 extensions declare, plus the largest holders the endpoint would name. It does not cover liquidity: whether the pool is locked or burned, how deep it is, or whether a transfer-hook program behaves. Those need pool-level reads this does not do.',
      ),
      note,
      explorerUrl: explorerUrl(chain, 'address', mint.toBase58()),
    } satisfies TokenExitReport;
  });
}

/** Where a token account keeps the mint it holds, and whose it is. */
const TOKEN_ACCOUNT_MINT_OFFSET = 0;
const TOKEN_ACCOUNT_OWNER_OFFSET = 32;

/**
 * Whether a payment somebody is asking you to make can actually be paid.
 *
 * The mirror of {@link findPayment}. That one asks, afterwards, whether a
 * payment satisfied a claim you issued. This asks, beforehand, whether a claim
 * *issued at you* is one that signing can satisfy — and it exists because the
 * answer is routinely no, in ways that are invisible in a wallet and trivial to
 * read off the chain.
 *
 * The failure that prompted it is worth stating, because it is not exotic. A
 * live marketplace quoted an invoice naming USDC, an amount, a treasury owner
 * and the exact token account to pay into. Every field was well-formed. The
 * mint was one character short of USDC's — a valid base58 pubkey for a mint
 * that has never existed — and the token account was the associated account
 * *derived from that non-existent mint*, so it had never existed either. The
 * invoice was perfectly consistent with itself and completely unpayable, and
 * nothing in the signing path would have said so.
 *
 * That is the general shape: the dangerous demands are not malformed. They are
 * consistent with themselves and inconsistent with the chain, so the only thing
 * that catches them is reading the chain.
 *
 * This function only reads. What a reading *means* is {@link classifyDemand},
 * which is pure and where every case is tested — the same split `inspect_exit`
 * makes, and for the same reason: the account shapes worth checking are ones
 * nobody has deployed on purpose.
 */
export async function inspectPaymentDemand(
  chain: ChainSpec,
  demand: PaymentDemand,
): Promise<PaymentDemandReport> {
  const malformed: string[] = [];
  const parse = (value: string | undefined, label: string): PublicKey | undefined => {
    if (!value) return undefined;
    try {
      return requirePubkey(value, label);
    } catch {
      malformed.push(label);
      return undefined;
    }
  };

  const mint = parse(demand.mint, 'mint');
  const to = parse(demand.to, 'recipient');
  const named = parse(demand.tokenAccount, 'destination token account');

  const facts: DemandFacts = { ...(malformed.length > 0 ? { malformed } : {}) };

  try {
    await withConnection(chain, 'inspectPaymentDemand', async (connection) => {
      // A mint that was named but would not parse: there is nothing to read,
      // and treating it as a native payment would answer a different question.
      if (demand.mint && !mint) return;

      if (!mint) {
        if (to) {
          const info = await connection.getAccountInfo(to).catch(() => null);
          facts.destination = { address: to.toBase58(), exists: Boolean(info) };
          facts.recipientIsTokenAccount = Boolean(
            info && (info.owner.equals(TOKEN_PROGRAM_ID) || info.owner.equals(TOKEN_2022_PROGRAM_ID)),
          );
        }
        return;
      }

      let mintFacts: MintFacts;
      try {
        mintFacts = await readMintFacts(connection, mint, chain);
      } catch {
        facts.tokenMissing = true;
        return;
      }

      // Structural, not a warning string: a payer needs to branch on this, and
      // `assessMintRisk` only states it in prose.
      facts.transferFee = mintFacts.extensions.has(EXT_TRANSFER_FEE_CONFIG);

      const curated = knownTokens(chain.id).find((known) => known.address === mint.toBase58())?.symbol;
      facts.token = {
        address: mint.toBase58(),
        decimals: mintFacts.decimals,
        ...(curated ? { curatedSymbol: curated } : {}),
      };

      const derived = to ? deriveAta(to, mint, mintFacts.programId) : undefined;
      if (derived) facts.derivedAta = derived.toBase58();

      // The named account wins over the derived one. A demand that names a
      // destination is making the stronger claim, and checking the account it
      // would rather you looked at is not checking the payment.
      const target = named ?? derived;
      if (!target) return;

      const info = await connection.getAccountInfo(target).catch(() => null);

      if (!info?.data || info.data.length < TOKEN_ACCOUNT_STATE_OFFSET + 1) {
        facts.destination = {
          address: target.toBase58(),
          exists: false,
          ...(derived ? { isAssociated: derived.equals(target) } : {}),
        };
        return;
      }

      const view = Buffer.from(info.data);
      const heldMint = new PublicKey(view.subarray(TOKEN_ACCOUNT_MINT_OFFSET, TOKEN_ACCOUNT_MINT_OFFSET + 32));
      const owner = new PublicKey(view.subarray(TOKEN_ACCOUNT_OWNER_OFFSET, TOKEN_ACCOUNT_OWNER_OFFSET + 32));

      facts.destination = {
        address: target.toBase58(),
        exists: true,
        mint: heldMint.toBase58(),
        owner: owner.toBase58(),
        frozen: view.readUInt8(TOKEN_ACCOUNT_STATE_OFFSET) === TOKEN_ACCOUNT_FROZEN,
        ...(derived ? { isAssociated: derived.equals(target) } : {}),
      };
    });
  } catch (error) {
    // An endpoint that would not answer is not evidence about the demand, and
    // reporting it as a refusal is how a validator gets ignored.
    facts.unreadable = error instanceof Error ? error.message : String(error);
  }

  if (facts.token) {
    const risk = await assessMintRisk(chain, facts.token.address).catch(() => undefined);
    if (risk) facts.risk = risk;
  }

  const context: DemandChain = {
    id: chain.id,
    name: chain.name,
    nativeSymbol: chain.nativeCurrency.symbol,
    nativeDecimals: chain.nativeCurrency.decimals,
    family: 'svm',
  };

  const authentic = demand.asset ? tokenBySymbol(chain.id, demand.asset)?.address : undefined;
  const findings = classifyDemand(context, demand, facts, authentic);
  const verdict = demandVerdict(findings, !facts.unreadable);

  return {
    chain: chain.id,
    verdict,
    findings,
    ...(facts.destination ? { destination: facts.destination } : {}),
    ...(facts.token
      ? {
          token: {
            mint: facts.token.address,
            decimals: facts.token.decimals,
            ...(facts.token.curatedSymbol ? { symbol: facts.token.curatedSymbol } : {}),
          },
        }
      : {}),
    ...(facts.risk ? { risk: facts.risk } : {}),
    note: demandNote(findings, verdict),
  } satisfies PaymentDemandReport;
}
