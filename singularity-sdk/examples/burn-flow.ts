/**
 * The custody seam, end to end, without a signer.
 *
 * A burn is the sharpest example of why the boundary is drawn where it is. It
 * is irreversible, it needs no counterparty, and every piece of it except the
 * signature is a read. So the whole flow runs here — audit the mint, check what
 * it permits, build the instruction, inspect what was built — and stops one
 * step short, holding out bytes for a wallet to approve.
 *
 * Run it with no configuration:
 *
 *   npx tsx singularity-sdk/examples/burn-flow.ts
 */

import { createSingularity } from '../src/index.js';

const sdk = createSingularity({ chain: 'solana' });

// Wrapped SOL — a real mint with no authorities left, which makes it a clean
// thing to audit in an example. Pass your own as the first argument.
const MINT = process.argv[2] ?? 'So11111111111111111111111111111111111111112';
const OWNER = process.argv[3] ?? '11111111111111111111111111111111';

async function main(): Promise<void> {
  // ── 1. What is this mint, and can it change? ───────────────────────────
  const identity = await sdk.tokenIdentity({ mint: MINT });

  console.log(`\n${identity.mint}`);
  console.log(`  name       ${identity.name ?? '(none on chain)'}`);
  console.log(`  symbol     ${identity.symbol ?? '(none on chain)'}`);

  // Both halves have to hold. Immutable on-chain text pointing at a document
  // somebody can still rewrite is a record that changes with nothing on the
  // chain to show for it — the more dangerous of the two failures, because it
  // looks settled.
  console.log(`  metadata   ${identity.immutable.metadata}`);
  console.log(`  document   ${identity.immutable.document ? 'content-addressed' : 'a mutable pointer'}`);

  if (identity.impersonation) {
    console.log(`\n  WARNING: this mint wears a name that belongs to a different address.`);
  }

  console.log(`\n  ${identity.note}`);

  // ── 2. What powers does anyone still hold over it? ─────────────────────
  const audit = await sdk.mintAudit({ mint: MINT });

  console.log(`\nPowers:`);
  if (audit.powers.length === 0) {
    console.log('  none — every authority is revoked.');
  }
  for (const power of audit.powers) {
    console.log(`  ${power.kind.padEnd(22)} ${power.holder ?? '(revoked)'}`);
  }

  // Worth doing *before* building, not after. A mint whose supply its owner
  // can still inflate is a different proposition to burn into, and this is the
  // last point where that is a decision rather than a regret.
  const live = audit.powers.filter((p) => p.holder);
  if (live.length > 0) {
    console.log(`\n  ${live.length} authority still held. A burn here reduces a supply somebody can restore.`);
  }

  // ── 3. Build the instruction ───────────────────────────────────────────
  // `build` works with no signer configured, because building is a read that
  // returns bytes. Nothing below this line touches a key.
  let unsigned;
  try {
    unsigned = await sdk.build.burn({
      mint: MINT,
      amount: '1',
      owner: OWNER,
      memo: 'singularity-sdk example',
    });
  } catch (err) {
    // Expected for the placeholder owner: it holds no token account for this
    // mint. The failure is the interesting part — it happened at build time,
    // against real chain state, rather than at signing time in a wallet.
    console.log(`\nCould not build: ${(err as Error).message}`);
    const hint = (err as { hint?: string }).hint;
    if (hint) console.log(hint);
    console.log('\nPass a real owner address as the second argument to see the payload.');
    return;
  }

  // ── 4. Hand it off ─────────────────────────────────────────────────────
  // `summary`, `warnings` and `signingHint` exist for exactly this moment. The
  // payload is an opaque structure and somebody is about to approve it
  // irreversibly; a builder that handed over bytes alone would be technically
  // complete and practically a trap.
  console.log(`\nUnsigned ${unsigned.family} transaction for ${unsigned.chain}`);
  console.log(`\n  ${unsigned.summary}`);

  for (const warning of unsigned.warnings) console.log(`\n  ! ${warning}`);

  console.log(`\n  To sign it:     ${unsigned.signingHint}`);
  console.log(`  Payload fields: ${Object.keys(unsigned.payload).join(', ')}`);

  console.log(`
This is where this SDK stops. To complete it you supply a Signer:

    const sdk = createSingularity({ chain: 'solana', signer: myWallet });
    const receipt = await sdk.write.burn({ mint, amount: '1' });

    receipt.broadcast   // false if your signer has no send() — that is fine
    receipt.hash        // present only when it actually went to a network

The SDK ships no signer and holds no keys. Yours signs, and yours broadcasts.
`);

  // ── 5. Afterwards ──────────────────────────────────────────────────────
  // Once it has landed, `verifyBurn` is what turns a signature into a claim —
  // checking the mint, the owner, the amount and a memo you chose, so that a
  // burn is credited to whoever made it rather than to whoever quotes the
  // public signature first. It is never cached, for exactly that reason.
  console.log('After it lands:  sdk.verifyBurn({ signature, mint, owner, expectMemo })');
}

main().catch((err: unknown) => {
  console.error(`\n${(err as Error).message}`);
  const hint = (err as { hint?: string }).hint;
  if (hint) console.error(hint);
  process.exitCode = 1;
});
