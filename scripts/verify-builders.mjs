/**
 * Check what this project builds by executing it, against mainnet.
 *
 * The builders are the one part of this repository that unit tests cannot
 * honestly cover. They emit bytes — instruction discriminators, account
 * orderings, struct offsets, calldata — and a test written from the same
 * understanding that produced the bytes agrees with them whether or not they
 * are right. The QR encoder already taught that lesson once: two bugs, and
 * every test agreed with both.
 *
 * So this asks the chain instead. Every transaction below is built by the same
 * code paths a caller uses, executed against current state by simulation, and
 * checked on the outcome rather than the encoding. Nothing is signed and
 * nothing is sent; a simulated transaction touches no balance and costs no fee.
 *
 *   npm run verify:builders
 *
 * It is deliberately not part of `npm test`. It needs the network, it is slow,
 * and a CI run that fails because a public RPC rate-limited would train people
 * to ignore it. Run it after touching an adapter, a builder, or anything that
 * decodes an account by offset.
 */

import { Keypair, PublicKey } from '@solana/web3.js';
import { getChain } from '../dist/core/registry.js';
import { buildPayment, simulateUnsigned, inspectPaymentDemand } from '../dist/adapters/solana.js';
import { simulateUnsignedEvm, inspectEvmPaymentDemand } from '../dist/adapters/evm.js';
import * as ops from '../dist/tools/operations.js';

const USDC_SOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

/** Holds USDC on Solana; used as a payer, never signed for. */
const SOL_HOLDER = '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9';
/** Holds USDC on Base, and carries an EIP-7702 delegation there. */
const EVM_HOLDER = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const EVM_PAYEE = '0x5A7FC11397E9a8AD41BF10bf13F22B0a63f96f6d';
const SOL_PAYEE = '2BJ4ezxqV9YJXc38D9duKBkdn4su4jE1beKUHwH663sL';
const SOL_PAYEE_ATA = '5RyKShQxSkbUJ9vA2MZ1Qf2TKgnwhhS3m7mj2ZZaVh6t';

let checks = 0;
const failures = [];

function check(name, condition, detail) {
  checks += 1;
  if (condition) {
    console.log(`  ok    ${name}`);
    return true;
  }
  console.log(`  FAIL  ${name}`);
  if (detail) console.log(`        ${detail}`);
  failures.push(name);
  return false;
}

async function section(name, fn) {
  console.log(`\n${name}`);
  try {
    await fn();
  } catch (error) {
    check(`${name} ran without throwing`, false, error?.message ?? String(error));
  }
}

const solana = getChain('solana');
const base = getChain('base');

await section('Solana — a token payment into an account that already exists', async () => {
  const built = await buildPayment(solana, {
    payer: SOL_HOLDER,
    to: SOL_PAYEE,
    amount: '2.5',
    mint: USDC_SOL,
  });

  const out = await simulateUnsigned(solana, {
    transaction: built.payload.transaction,
    destination: SOL_PAYEE_ATA,
    mint: USDC_SOL,
    expected: '2.5',
  });

  check('executes against current state', out.succeeded, out.error);
  check('delivers exactly what was asked', out.delivered?.raw === '2500000', `delivered ${out.delivered?.raw}`);
  check('reports no shortfall', out.shortfall === undefined);
  check('measured the delivery rather than assuming it', out.completeness.kind === 'exhaustive');
});

await section('Solana — a token payment that must create the recipient account first', async () => {
  // A wallet generated here has certainly never held this mint, so this is the
  // only path that exercises the associated-token-account instruction: its
  // discriminator, its six accounts, and their order. A wrong byte anywhere
  // fails the simulation rather than passing a test.
  const stranger = Keypair.generate().publicKey.toBase58();

  const built = await buildPayment(solana, {
    payer: SOL_HOLDER,
    to: stranger,
    amount: '1',
    mint: USDC_SOL,
  });

  const [ata] = PublicKey.findProgramAddressSync(
    [
      new PublicKey(stranger).toBuffer(),
      new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA').toBuffer(),
      new PublicKey(USDC_SOL).toBuffer(),
    ],
    new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'),
  );

  const out = await simulateUnsigned(solana, {
    transaction: built.payload.transaction,
    destination: ata.toBase58(),
    mint: USDC_SOL,
    expected: '1',
  });

  check('creates the account and executes', out.succeeded, out.error);
  check('delivers the full amount into the new account', out.delivered?.raw === '1000000', `delivered ${out.delivered?.raw}`);
  check('warned that the account did not exist', built.warnings.some((w) => /had no token account/.test(w)));
});

await section('Solana — a native payment', async () => {
  const built = await buildPayment(solana, { payer: SOL_HOLDER, to: SOL_PAYEE, amount: '0.001' });
  const out = await simulateUnsigned(solana, {
    transaction: built.payload.transaction,
    destination: SOL_PAYEE,
    expected: '0.001',
  });

  check('executes', out.succeeded, out.error);
  check('delivers exactly 0.001 SOL', out.delivered?.raw === '1000000', `delivered ${out.delivered?.raw}`);
});

await section('Solana — a payment the payer cannot afford', async () => {
  // The failure must be a refusal, never a delivery of zero.
  const broke = Keypair.generate().publicKey.toBase58();
  const built = await buildPayment(solana, { payer: broke, to: SOL_PAYEE, amount: '1000' });
  const out = await simulateUnsigned(solana, {
    transaction: built.payload.transaction,
    destination: SOL_PAYEE,
    expected: '1000',
  });

  check('does not execute', out.succeeded === false);
  check('reports no delivered amount at all', out.delivered === undefined);
  check('does not report a shortfall for a transaction that never ran', out.shortfall === undefined);
  check('completeness says nothing was measured', out.completeness.kind === 'failed');
});

await section('Solana — decoding a token account by offset', async () => {
  // inspect_payment reads the mint at byte 0 and the owner at byte 32 of a
  // 165-byte account. Both are hand-rolled offsets with nothing but this to
  // confirm them.
  const report = await inspectPaymentDemand(solana, {
    mint: USDC_SOL,
    to: SOL_PAYEE,
    tokenAccount: SOL_PAYEE_ATA,
    amount: '0.01',
  });

  check('reads the mint out of the account', report.destination?.mint === USDC_SOL, report.destination?.mint);
  check('reads the owner out of the account', report.destination?.owner === SOL_PAYEE, report.destination?.owner);
  check('recognises it as the associated account', report.destination?.isAssociated === true);
  check('finds the account is not frozen', report.destination?.frozen === false);
  check('passes the demand', report.verdict === 'payable', report.note);
});

await section('EVM — a token transfer on Base', async () => {
  const built = await ops.buildTransfer({
    chain: 'base',
    from: EVM_HOLDER,
    to: EVM_PAYEE,
    amount: '10',
    token: USDC_BASE,
  });

  const out = await simulateUnsignedEvm(base, {
    from: built.payload.from,
    to: built.payload.to,
    data: built.payload.data,
    value: built.payload.value,
    destination: EVM_PAYEE,
    token: USDC_BASE,
    expected: '10',
  });

  check('executes against current state', out.succeeded, out.error);
  check('delivers exactly what was asked', out.delivered?.raw === '10000000', `delivered ${out.delivered?.raw}`);
  check('measured it rather than assuming', out.completeness.kind === 'exhaustive');
  check('calldata targets the token, not the payee', built.payload.to.toLowerCase() === USDC_BASE.toLowerCase());
});

await section('EVM — an address with code that is still a wallet', async () => {
  // EIP-7702: 0xef0100 || implementation, 23 bytes. Reading "has code" as "is a
  // contract" would warn about an ordinary payee.
  const report = await inspectEvmPaymentDemand(base, {
    token: USDC_BASE,
    to: EVM_HOLDER,
    amount: '1',
    asset: 'USDC',
  });

  const codes = report.findings.map((f) => f.code);
  check('does not call it a contract', !codes.includes('DESTINATION_IS_A_CONTRACT'), codes.join(', '));
  check('records the delegation instead', codes.includes('DESTINATION_IS_A_DELEGATED_WALLET'));
  check('still finds the demand payable', report.verdict === 'payable', report.note);
});

console.log(`\n${checks - failures.length}/${checks} checks passed`);

if (failures.length) {
  console.log('\nFailed:');
  for (const name of failures) console.log(`  - ${name}`);
  process.exitCode = 1;
}
