/**
 * A burn somebody can approve in their wallet, without ever seeing base64.
 *
 * The signing seam is not negotiable — this tool holds no keys and never will —
 * but *how* a payload reaches a wallet is entirely negotiable, and handing
 * somebody a base64 blob in a chat message was the worst available answer. It
 * asks them to own the hardest step, and it puts two long opaque strings (the
 * payload and, later, the signature) in front of a person who has no way to
 * tell them apart. Watching that go wrong four times in a row is what this file
 * is for.
 *
 * A Solana Pay transaction request moves the work to where the keys already
 * are. The bot posts a link; the wallet fetches it, is told what it is, posts
 * back the account that will sign, and receives a transaction built for that
 * account; the user sees a burn with its memo and approves or does not. Nothing
 * is exported, nothing is pasted, and the seam is exactly where it was.
 *
 * The flow, as the spec has it:
 *
 *   GET  → { label, icon }            what the wallet shows before asking
 *   POST → { transaction, message }   built for the account it sends
 */
import { buildBurn } from '../adapters/solana.js';
import { getChain } from '../core/registry.js';
import { SingularityError } from '../core/errors.js';

/** The project's own mint, which is what this endpoint exists to serve. */
const DEFAULT_MINT = '5pTy48gtfzaR8NPUVZTbybVUGpQvFT4JsNHzwQE8pump';

/**
 * Which mints a link may name.
 *
 * Deliberately not "any". A transaction request is a URL anybody can craft and
 * send to anybody, and the wallet shows its origin — so an open burn endpoint
 * is a phishing primitive wearing this project's domain, and the more the
 * domain comes to be trusted the better it works. Restricting it costs a config
 * line and removes the whole category.
 */
export function allowedMints(): string[] {
  const configured = process.env.SINGULARITY_BURN_MINTS?.trim();
  if (!configured) return [DEFAULT_MINT];
  return configured
    .split(',')
    .map((mint) => mint.trim())
    .filter(Boolean);
}

export interface BurnRequestParams {
  mint: string;
  amount: string;
  memo?: string;
  chain?: string;
}

/** Read and check the parameters a link carries. */
export function parseBurnRequest(query: Record<string, string | undefined>): BurnRequestParams {
  const mint = query.mint?.trim();
  const amount = query.amount?.trim();

  if (!mint || !amount) {
    throw new SingularityError(
      'BAD_REQUEST',
      'A burn link needs both `mint` and `amount`.',
      'These are the two things a wallet cannot supply for you.',
    );
  }

  if (!allowedMints().includes(mint)) {
    throw new SingularityError(
      'MINT_NOT_ALLOWED',
      `This endpoint does not build burns for ${mint}.`,
      'It serves a named set of mints on purpose: an endpoint that will build a burn of anything is a link worth sending to strangers.',
    );
  }

  if (!/^\d+(\.\d+)?$/.test(amount)) {
    throw new SingularityError(
      'BAD_REQUEST',
      `"${amount}" is not an amount.`,
      'Amounts are whole tokens as a decimal string, never base units.',
    );
  }

  return {
    mint,
    amount,
    ...(query.memo ? { memo: query.memo.slice(0, 256) } : {}),
    ...(query.chain ? { chain: query.chain } : {}),
  };
}

/**
 * The `solana:` URL a wallet opens.
 *
 * The inner https URL is percent-encoded whole, because it carries its own
 * query string and a wallet splitting on the first `?` would otherwise lose
 * everything after it.
 */
export function burnLink(endpoint: string, params: BurnRequestParams): string {
  const url = new URL(endpoint);
  url.searchParams.set('mint', params.mint);
  url.searchParams.set('amount', params.amount);
  if (params.memo) url.searchParams.set('memo', params.memo);
  if (params.chain) url.searchParams.set('chain', params.chain);

  return `solana:${encodeURIComponent(url.toString())}`;
}

/** What the wallet shows before it asks anyone to approve anything. */
export function describeBurnRequest(params: BurnRequestParams): { label: string; icon: string } {
  return {
    label: `Burn ${params.amount}`,
    icon:
      process.env.SINGULARITY_PAY_ICON ||
      'https://singularity-agent-nine.vercel.app/assets/icon-64.png',
  };
}

/**
 * Build the burn for the account the wallet sends.
 *
 * The account arrives in the POST body rather than in the link, which is the
 * quiet improvement over the old flow: nobody has to know, type, or paste their
 * own address. The wallet knows it.
 *
 * `message` is what the wallet displays alongside the decoded transaction. It
 * says what will happen in the plainest words available, because it is the last
 * thing read before an irreversible signature — and it names the mint by
 * address, never by any name read off the chain.
 */
export async function buildBurnRequest(
  account: string,
  params: BurnRequestParams,
): Promise<{ transaction: string; message: string }> {
  const chain = getChain(params.chain ?? 'solana');

  const built = await buildBurn(chain, {
    owner: account,
    mint: params.mint,
    amount: params.amount,
    ...(params.memo ? { memo: params.memo } : {}),
  });

  const message =
    `Burn ${params.amount} tokens of mint ${params.mint}. They are destroyed permanently — ` +
    'nobody receives them and nobody can send them back.' +
    (params.memo ? ` Carries the memo "${params.memo}", which is what credits the burn to you.` : '');

  return { transaction: built.payload.transaction as string, message };
}
