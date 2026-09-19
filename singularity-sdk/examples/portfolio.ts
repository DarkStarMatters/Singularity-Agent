/**
 * One address across many chains, and the envelope that says what the answer covers.
 *
 *   npx tsx singularity-sdk/examples/portfolio.ts [address-or-name]
 *
 * Note which chains actually get queried: `portfolio` filters the configured
 * list down to the ones the address format is valid on, so an EVM address does
 * not produce a Solana error. `chainsQueried` is the authority on what was
 * asked, and it is printed rather than assumed.
 *
 * The reads are the easy part. The part worth copying is `describe` at the
 * bottom: on Ethereum a token list is almost never exhaustive, because no
 * JSON-RPC method can enumerate an account's holdings, and an application that
 * renders `[]` as "no tokens" is confidently wrong on the chain most people
 * try first.
 */

import { createSingularity } from '../src/index.js';
import type { BalanceResult, Completeness } from '../src/index.js';

const sdk = createSingularity({
  // Eight rows is what this prints. Saying so gets an honest `truncated`
  // envelope back rather than a list quietly cut to fit.
  budget: { maxItems: 8 },
  portfolioChains: ['ethereum', 'base', 'arbitrum', 'solana'],
});

async function main(): Promise<void> {
  const who = process.argv[2] ?? 'vitalik.eth';

  // What kind of string is this, and which chains could it belong to? Worth
  // doing first whenever the input came from a human.
  const identity = await sdk.resolve(who);
  console.log(`
${who} — ${identity.kind}`);
  if (identity.address) console.log(`  ${identity.address}`);
  if (identity.chains?.length) console.log(`  valid on: ${identity.chains.join(', ')}`);

  const portfolio = await sdk.portfolio({ address: who, includeTokens: true });

  for (const balance of portfolio.balances) print(balance);

  for (const failure of portfolio.errors) {
    // Reported, not hidden. A chain that could not be read is a gap in the
    // answer, and the combined envelope below accounts for it.
    console.log(`
${failure.chain}: ${failure.error}`);
    if (failure.hint) console.log(`  ${failure.hint}`);
  }

  // The weakest guarantee across every chain queried — one curated scan is
  // enough to make "holds nothing anywhere" an unsupported statement, however
  // many chains enumerated cleanly.
  console.log(`
Across ${portfolio.chainsQueried.join(', ')}:`);
  console.log(`  ${describe(portfolio.completeness)}`);
}

function print(balance: BalanceResult): void {
  console.log(`
${balance.chain}`);
  console.log(`  ${balance.native.amount.formatted} ${balance.native.token?.symbol ?? ''} (native)`);

  for (const token of balance.tokens) {
    console.log(`  ${token.amount.formatted.padStart(18)} ${token.token?.symbol ?? '?'}`);
  }

  console.log(`  ${describe(balance.tokenCompleteness)}`);
}

/**
 * Turn an envelope into a sentence someone can act on.
 *
 * The four kinds are not decoration. `exhaustive` is the only one where an
 * empty list is evidence of anything, and `failed` means nothing was checked —
 * the opposite of "nothing is there", and identical in the data.
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
      return `Could not determine — nothing was checked. ${c.note}`;
  }
}

main().catch((err: unknown) => {
  console.error(`
${(err as Error).message}`);
  const hint = (err as { hint?: string }).hint;
  if (hint) console.error(hint);
  process.exitCode = 1;
});
