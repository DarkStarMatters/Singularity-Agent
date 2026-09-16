import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import type { ChainAdapter, ContractReadParams, TransferParams } from '../core/adapter.js';
import type {
  BalanceEntry,
  ChainSpec,
  FeeEstimate,
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
import { amount, explorerUrl, nativeAmount, parseUnits, shortAddress, toIso } from '../core/format.js';
import { knownTokens, tokenBySymbol } from '../core/tokens.js';

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

/** Base signature fee, in lamports. Priority fees stack on top of this. */
const BASE_SIGNATURE_FEE = 5_000n;
/** SPL Token program instruction discriminator for TransferChecked. */
const IX_TRANSFER_CHECKED = 12;
/**
 * Most mints an unfiltered scan will return. Solana lets anyone airdrop a token
 * account onto any wallet, so an active address accumulates thousands of dust
 * mints; returning all of them buries the real holdings and can overflow a
 * model's tool-result budget outright.
 */
const TOKEN_SCAN_LIMIT = 50;

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

function deriveAta(owner: PublicKey, mint: PublicKey, programId = TOKEN_PROGRAM_ID): PublicKey {
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
          .catch(() => ({ value: [] as never[] })),
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

      const all = [...byMint].map(([mint, { decimals, total, accounts }]) => {
        const known = knownMintSymbol(chain.id, mint);
        return {
          known: Boolean(known),
          magnitude: Number(total) / 10 ** decimals,
          entry: {
            chain: chain.id,
            address: owner.toBase58(),
            token: {
              address: mint,
              // An uncurated mint has no symbol here — the short mint stands in
              // for one. Nothing on-chain is read for it, but it is still not a
              // name this tool vouches for, so it travels marked. No
              // impersonation check either, for the same reason: there is no
              // deployer-chosen string here to collide with a curated one. That
              // changes the moment mint metadata is read (roadmap 1.4), and the
              // check has to be added in the same change that reads it.
              symbol:
                known?.symbol ?? sanitizeOnchainText(null, `${mint.slice(0, 4)}…${mint.slice(-4)}`),
              name: known?.name,
              decimals,
              native: false,
              ...(known ? {} : { untrusted: true as const }),
            },
            amount: amount(total, decimals, known?.symbol ?? 'tokens'),
            ...(accounts > 1 ? { tokenAccounts: accounts } : {}),
          } satisfies BalanceEntry,
        };
      });

      // An explicit `tokens` list is the caller asking for specific mints — give
      // back every one of them, in the order they were requested.
      if (filter) {
        return {
          entries: all.map((t) => t.entry),
          completeness: completeness.exhaustive(
            `Every token account the address holds for the ${filter.size} mint(s) you named, summed per mint.`,
          ),
        };
      }

      // Curated tokens first; within each group, larger balances first. Note that
      // magnitude is not value — there is no pricing here, so a trillion units of
      // dust outranks a thousand USDC. It is a stable, explicable order, not a
      // ranking by worth.
      all.sort((a, b) => Number(b.known) - Number(a.known) || b.magnitude - a.magnitude);

      if (all.length <= TOKEN_SCAN_LIMIT) {
        return {
          entries: all.map((t) => t.entry),
          completeness: completeness.exhaustive(
            'Complete: on Solana token accounts are owned by the wallet, so this really is every SPL and Token-2022 mint held, summed across accounts.',
          ),
        };
      }

      const omitted = all.length - TOKEN_SCAN_LIMIT;
      return {
        entries: all.slice(0, TOKEN_SCAN_LIMIT).map((t) => t.entry),
        completeness: completeness.truncated(
          TOKEN_SCAN_LIMIT,
          omitted,
          `Showing ${TOKEN_SCAN_LIMIT} of ${all.length} mints held — curated tokens first, ` +
            `then by raw balance. ${omitted} omitted, and because there is no pricing here that ` +
            'order is magnitude, not value. Pass `tokens` with mint addresses to check specific holdings.',
        ),
      };
    });
  },

  async getTransaction(chain, hash) {
    return withConnection(chain, 'getParsedTransaction', async (connection) => {
      const tx = await connection.getParsedTransaction(hash, {
        maxSupportedTransactionVersion: 0,
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

        const decimals = known?.decimals ?? (await mintDecimals(connection, mint, chain));
        const value = parseUnits(params.amount, decimals);

        const source = deriveAta(from, mint);
        const destination = deriveAta(to, mint);

        const destinationExists = await connection.getAccountInfo(destination).catch(() => null);
        if (!destinationExists) {
          warnings.push(
            `The recipient has no token account for this mint. The transaction must also create one (associated token account ${destination.toBase58()}), which costs ~0.002 SOL of rent.`,
          );
        }

        transaction.add(
          transferCheckedInstruction({ source, mint, destination, owner: from, value, decimals }),
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
}): TransactionInstruction {
  const data = Buffer.alloc(10);
  data.writeUInt8(IX_TRANSFER_CHECKED, 0);
  data.writeBigUInt64LE(args.value, 1);
  data.writeUInt8(args.decimals, 9);

  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: args.source, isSigner: false, isWritable: true },
      { pubkey: args.mint, isSigner: false, isWritable: false },
      { pubkey: args.destination, isSigner: false, isWritable: true },
      { pubkey: args.owner, isSigner: true, isWritable: false },
    ],
    data,
  });
}

async function mintDecimals(connection: Connection, mint: PublicKey, chain: ChainSpec): Promise<number> {
  const info = await connection.getParsedAccountInfo(mint);
  const data = info.value?.data;
  if (!data || !('parsed' in data) || data.parsed?.type !== 'mint') {
    throw new SingularityError(
      'NOT_A_MINT',
      `${shortAddress(mint.toBase58())} is not an SPL mint on ${chain.name}.`,
      'Pass the mint address, not a token account address.',
    );
  }
  return (data.parsed.info as { decimals: number }).decimals;
}

/** mint -> metadata, memoized per chain, so token lists render real symbols. */
const mintIndexCache = new Map<string, Map<string, { symbol: string; name: string }>>();

function knownMintSymbol(chainId: string, mint: string): { symbol: string; name: string } | undefined {
  let index = mintIndexCache.get(chainId);
  if (!index) {
    index = new Map(knownTokens(chainId).map((t) => [t.address, { symbol: t.symbol, name: t.name }]));
    mintIndexCache.set(chainId, index);
  }
  return index.get(mint);
}
