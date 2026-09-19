/**
 * A read-only Singularity application.
 *
 * Runs against public endpoints with no key and no signer. Everything here is
 * safe to point at any address on any supported chain, because nothing in it
 * can write.
 *
 * The part worth copying is not the reads — it is the completeness handling at
 * the bottom. `tokens: []` means "this wallet holds nothing" only when the
 * envelope says `exhaustive`; on Ethereum it almost never does, because no
 * JSON-RPC method can enumerate an account's tokens. An application that
 * renders an empty list as "no tokens" is confidently wrong on the one chain
 * most people will try first.
 */

import { createSingularity, type BalanceResult, type Completeness } from 'singularity-sdk';

const sdk = createSingularity({
  chain: 'ethereum',
  // Eight rows is what this prints. Saying so gets an honest `truncated`
  // envelope back, rather than a list silently cut to fit.
  budget: { maxItems: 8 },
});

async function main(): Promise<void> {
  const who = process.argv[2] ?? 'vitalik.eth';

  // What kind of string is this? An address, a name, a hash, a height — and
  // which chains could it belong to. Worth doing first whenever the input came
  // from a human.
  const identity = await sdk.resolve(who);
  console.log(`\n${who} → ${identity.kind}`);
  if (identity.address) console.log(`  ${identity.address}`);

  const balance = await sdk.balance({ address: who, includeTokens: true });
  print(balance);

  // One address across several chains. Chains the address format cannot be
  // valid on are skipped rather than reported as errors.
  const portfolio = await sdk.portfolio({ address: who, chains: ['ethereum', 'base', 'arbitrum'] });
  console.log(`\nAcross ${portfolio.chainsQueried.join(', ')}:`);
  for (const entry of portfolio.balances) {
    console.log(`  ${entry.chain.padEnd(10)} ${entry.native.amount.formatted} ${entry.native.token?.symbol ?? ''}`);
  }
  console.log(`\n  ${describe(portfolio.completeness)}`);
}

function print(balance: BalanceResult): void {
  console.log(`\n${balance.chain}`);
  console.log(`  ${balance.native.amount.formatted} ${balance.native.token?.symbol ?? ''} (native)`);

  for (const token of balance.tokens) {
    console.log(`  ${token.amount.formatted.padStart(16)} ${token.token?.symbol ?? '?'}`);
  }

  console.log(`\n  ${describe(balance.tokenCompleteness)}`);
}

/**
 * Turn an envelope into a sentence a user can act on.
 *
 * The four kinds are not decorations. `exhaustive` is the only one where an
 * empty list is evidence of anything; `failed` means nothing was checked, which
 * is the opposite of "nothing is there" and looks identical in the data.
 */
function describe(c: Completeness): string {
  switch (c.kind) {
    case 'exhaustive':
      return `Complete. ${c.note}`;
    case 'curated':
      return `Partial — a known subset was checked, so an absence proves nothing. ${c.note}`;
    case 'truncated':
      return `Showing ${c.shown ?? '?'}, omitted ${c.omitted ?? '?'}. ${c.note}`;
    case 'failed':
      return `Could not determine. Nothing was checked. ${c.note}`;
  }
}

main().catch((err: unknown) => {
  // Errors from the agent core carry a `hint` written for whoever has to fix
  // it. Printing the message without it throws away the useful half.
  const hint = (err as { hint?: string })?.hint;
  console.error(`\n${(err as Error).message}`);
  if (hint) console.error(hint);
  process.exitCode = 1;
});
