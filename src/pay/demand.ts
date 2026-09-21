/**
 * Judging a payment demand, separated from reading one.
 *
 * The same split `trade/classify.ts` makes, for the same reason. Every
 * interesting case here — a mint that does not exist, a destination holding the
 * wrong token, an amount that disagrees with its own base units — would
 * otherwise need a live account of that exact shape to test against, and the
 * shapes that matter most are the ones nobody has deployed on purpose. Reading
 * is one function in the Solana adapter; deciding what a reading means is all
 * of this file, and it touches no network.
 *
 * The rule the findings follow: **a finding names both values and says what
 * happens if you sign anyway.** "Mismatch" is not a reason, and whoever reads
 * this is deciding whether to pay a stranger.
 */

import type {
  DemandDestination,
  DemandFinding,
  DemandSeverity,
  DemandVerdict,
  MintRisk,
  PaymentDemand,
} from './types.js';
import { formatUnits, parseUnits } from '../core/format.js';

/**
 * What was actually read off the chain, stated so the judging never guesses.
 *
 * Every field is optional and every absence means something specific, which is
 * why they are not collapsed: a mint that could not be read and a mint that was
 * never named are different demands, and a validator that treats them alike is
 * one people learn to ignore.
 */
export interface DemandFacts {
  /** The token named in the demand, as read: a mint on Solana, a contract on EVM. */
  token?: { address: string; decimals: number; curatedSymbol?: string };
  /** A token was named and there is nothing at that address that is one. */
  tokenMissing?: boolean;
  /** Where the money would land, as read rather than as claimed. */
  destination?: DemandDestination;
  /** The associated token account for the payee and mint, where both are known. */
  derivedAta?: string;
  /** Solana: a native payment aimed at something owned by a token program. */
  recipientIsTokenAccount?: boolean;
  /**
   * EVM: the recipient address has code at it.
   *
   * Not fatal on its own — plenty of payees are contracts — but a contract
   * that was not written to hold ERC-20s cannot move them out again, and
   * nothing on chain distinguishes the two.
   */
  destinationIsContract?: boolean;
  /** EVM: the recipient *is* the token contract, which almost always strands it. */
  destinationIsTheToken?: boolean;
  /** EVM: the recipient is the zero address, so this is a burn. */
  destinationIsZero?: boolean;
  /**
   * EVM: the recipient is an EOA carrying an EIP-7702 delegation, and this is
   * the address it points at.
   *
   * It has code, and it is still a wallet — key-controlled, able to move tokens
   * out like any other. Reading "has code" as "is a contract" would warn on an
   * ordinary and increasingly common wallet, so the designator is read rather
   * than the code length.
   */
  destinationDelegate?: string;
  /** Labels of fields whose address would not parse at all. */
  malformed?: string[];
  /** What holding this token afterwards exposes the payee to. */
  risk?: MintRisk;
  /**
   * The mint charges a fee on every transfer, so the payee receives less than
   * is sent.
   *
   * Read separately because {@link MintRisk} only carries this as prose in
   * `warnings`, and a sentence is not something a check can branch on. It was
   * invisible here until a demand for a fee-bearing mint came back `payable`
   * and would have arrived short.
   */
  transferFee?: boolean;
  /** Set when the chain would not answer, with why. Nothing below was checked. */
  unreadable?: string;
}

/** The chain facts the judging needs, without importing the registry. */
export interface DemandChain {
  id: string;
  name: string;
  nativeSymbol: string;
  nativeDecimals: number;
  /** Which family's destination rules apply. Solana has token accounts; EVM does not. */
  family: 'svm' | 'evm';
}

const finding = (severity: DemandSeverity, code: string, detail: string): DemandFinding => ({
  code,
  severity,
  detail,
});

/**
 * Whether the ticker a demand claims agrees with the mint it names.
 *
 * Answerable with no network at all, which is why it runs first and why it is
 * worth having even when everything else is skipped. A demand saying USDC while
 * naming an address that is not USDC is either the oldest trick in the book or
 * somebody's typo, and the two are indistinguishable from outside — so this
 * says what is true and declines to say which.
 */
export function checkClaimedAsset(
  chain: DemandChain,
  demand: PaymentDemand,
  authentic: string | undefined,
): DemandFinding | undefined {
  // Both spellings, or this check silently does nothing for whichever the
  // caller happened to use — which is how it came to pass a demand labelled
  // USDC that named the USDT contract.
  const named = (demand.token ?? demand.mint)?.trim();
  if (!demand.asset || !named || !authentic) return undefined;

  // EVM addresses are case-insensitive and arrive in whatever casing the
  // invoice used; comparing them literally would condemn the correct address
  // for being lowercase. Base58 is case-sensitive and must not be folded.
  const same =
    chain.family === 'evm' ? named.toLowerCase() === authentic.toLowerCase() : named === authentic;
  if (same) return undefined;

  return finding(
    'fatal',
    'ASSET_NOT_WHAT_IT_CLAIMS',
    `This demand calls itself ${demand.asset}, but ${demand.asset} on ${chain.name} is ${authentic} and the token it names is ${named}. Those are different tokens. A ticker is not an identity — anyone can deploy a token with any name, and one wrong character produces an address that is still well-formed.`,
  );
}

/** Whether a demand has already stopped being one. */
export function checkExpiry(demand: PaymentDemand, now = Date.now()): DemandFinding | undefined {
  if (!demand.expiresAt) return undefined;

  const at = Date.parse(demand.expiresAt);
  if (!Number.isFinite(at)) {
    return finding(
      'note',
      'EXPIRY_UNREADABLE',
      `This demand states an expiry of "${demand.expiresAt}", which is not a date, so how long it is good for cannot be checked.`,
    );
  }

  if (at <= now) {
    return finding(
      'fatal',
      'EXPIRED',
      `This demand expired at ${new Date(at).toISOString()}. Paying it now sends money against a quote the other side has already stopped honouring, and a payment nobody is expecting is not usually refunded quickly.`,
    );
  }

  if (at - now < 60_000) {
    return finding(
      'warning',
      'EXPIRES_SOON',
      `This demand expires in ${Math.round((at - now) / 1000)} seconds, which is less time than signing and confirming reliably take. A payment that lands after it lapses may not be credited.`,
    );
  }

  return undefined;
}

/**
 * Whether the numbers in a demand agree with each other and with the mint.
 *
 * The check worth having is the last one. A demand that states an amount *and*
 * its base units has handed you two numbers that must be the same number, and
 * where they differ the displayed one is the lie — base units are what actually
 * gets signed.
 */
export function checkAmounts(demand: PaymentDemand, decimals: number): DemandFinding[] {
  const found: DemandFinding[] = [];

  if (demand.decimals !== undefined && demand.decimals !== decimals) {
    found.push(
      finding(
        'fatal',
        'DECIMALS_MISMATCH',
        `This demand assumes ${demand.decimals} decimals and the asset has ${decimals}. Every amount computed from the wrong scale is wrong by a power of ten, in whichever direction costs you.`,
      ),
    );
  }

  if (demand.amount === undefined) {
    found.push(
      finding('note', 'AMOUNT_UNSTATED', 'This demand states no amount, so there is nothing to check one against.'),
    );
    return found;
  }

  const written = demand.amount.trim();

  if (written.startsWith('-')) {
    found.push(
      finding(
        'fatal',
        'AMOUNT_NEGATIVE',
        `This demand is for ${written}. A transfer has no negative direction, so whatever this was meant to express, signing it is not it.`,
      ),
    );
    return found;
  }

  const [, fraction = ''] = written.split('.');
  if (fraction.length > decimals) {
    // Worth its own finding rather than a generic parse failure: the demand is
    // asking for a quantity of a token that does not divide that far, which
    // usually means it was computed against a different asset's decimals.
    found.push(
      finding(
        'fatal',
        'AMOUNT_TOO_PRECISE',
        `This demand asks for ${written}, which has ${fraction.length} decimal places, and the asset has ${decimals}. That quantity cannot be expressed in its base units, so there is no transaction that pays exactly this.`,
      ),
    );
    return found;
  }

  let base: bigint;
  try {
    base = parseUnits(written, decimals);
  } catch (error) {
    found.push(
      finding(
        'fatal',
        'AMOUNT_UNREADABLE',
        `"${demand.amount}" is not an amount that can be paid: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    return found;
  }

  if (base === 0n) {
    found.push(
      finding(
        'fatal',
        'AMOUNT_IS_ZERO',
        `This demand is for ${written}, which at ${decimals} decimals is zero base units. Signing it would move nothing while looking like a payment.`,
      ),
    );
  }

  if (demand.amountBaseUnits !== undefined) {
    let stated: bigint;
    try {
      stated = BigInt(demand.amountBaseUnits);
    } catch {
      found.push(
        finding('fatal', 'BASE_UNITS_UNREADABLE', `"${demand.amountBaseUnits}" is not a base-unit amount.`),
      );
      return found;
    }

    if (stated !== base) {
      found.push(
        finding(
          'fatal',
          'AMOUNT_MISMATCH',
          `This demand displays ${demand.amount} but states ${demand.amountBaseUnits} base units, which at ${decimals} decimals is ${formatUnits(stated, decimals)}. Base units are what gets signed, so you would be paying the second number and reading the first.`,
        ),
      );
    }
  }

  return found;
}

/**
 * What the destination turned out to be, judged against what was claimed.
 *
 * Dispatches on family because this is the one part of a demand whose rules
 * genuinely differ. Solana pays into a token account that must exist, hold the
 * right mint and belong to the right owner; EVM pays an address that always
 * "exists" and where the dangerous cases are different ones — the zero address,
 * the token's own contract, a contract that cannot move ERC-20s out again.
 * Ticker, amounts and expiry are the same questions on both, so they are not
 * split.
 */
export function checkDestination(
  chain: DemandChain,
  demand: PaymentDemand,
  facts: DemandFacts,
): DemandFinding[] {
  return chain.family === 'evm'
    ? checkEvmDestination(chain, demand, facts)
    : checkSolanaDestination(chain, demand, facts);
}

/**
 * EVM: an address is always a valid recipient, so the checks are about what
 * happens *after* it arrives.
 *
 * None of these are exotic. Sending ERC-20s to the token's own contract is one
 * of the most common ways tokens are permanently lost, and it looks like an
 * ordinary transfer in every wallet.
 */
export function checkEvmDestination(
  chain: DemandChain,
  demand: PaymentDemand,
  facts: DemandFacts,
): DemandFinding[] {
  const found: DemandFinding[] = [];

  if (demand.tokenAccount) {
    // There is no such thing here. A demand carrying one was almost certainly
    // built for a different chain than the one it names.
    found.push(
      finding(
        'warning',
        'TOKEN_ACCOUNT_ON_EVM',
        `This demand names a destination token account, and ${chain.name} has no such thing — balances live in the token contract against the holder's address. The demand was probably built for a different chain than the one it names.`,
      ),
    );
  }

  if (demand.memo || demand.reference) {
    // The demand says something must travel with the payment, and an ordinary
    // transfer here carries nothing. The money lands and the order is not
    // credited, which looks exactly like not having paid.
    found.push(
      finding(
        'warning',
        'MEMO_CANNOT_BE_CARRIED',
        `This demand expects the payment to carry ${demand.memo ? `the memo "${demand.memo}"` : `the reference ${demand.reference}`}, and a plain transfer on ${chain.name} has no field to put it in. Paid as an ordinary transfer this will land and may not be credited to your order — ask the payee how they expect it to be attached.`,
      ),
    );
  }

  if (!facts.destination) {
    found.push(
      finding(
        'note',
        'DESTINATION_UNSTATED',
        'This demand names no payee, so where the money would go cannot be checked at all.',
      ),
    );
    return found;
  }

  const { address } = facts.destination;

  if (facts.destinationIsZero) {
    found.push(
      finding(
        'fatal',
        'DESTINATION_IS_ZERO_ADDRESS',
        `This demand pays the zero address (${address}). That destroys the funds — it is a burn, not a payment, and no payee is credited.`,
      ),
    );
    return found;
  }

  if (facts.destinationIsTheToken) {
    found.push(
      finding(
        'fatal',
        'DESTINATION_IS_THE_TOKEN',
        `This demand pays the token's own contract (${address}). Tokens sent to their own contract are recoverable only if that contract was written to release them, and almost none are. This is one of the most common ways ERC-20s are permanently lost.`,
      ),
    );
    return found;
  }

  if (facts.destinationDelegate) {
    // Has code, is not a contract. Worth recording because an explorer will
    // show bytecode at this address and invite exactly the wrong conclusion.
    found.push(
      finding(
        'note',
        'DESTINATION_IS_A_DELEGATED_WALLET',
        `The payee (${address}) is a wallet carrying an EIP-7702 delegation to ${facts.destinationDelegate}. It has code at it and is still key-controlled, so this is an ordinary payee — not a contract that might be unable to move the token out.`,
      ),
    );
  } else if (facts.destinationIsContract) {
    found.push(
      finding(
        'warning',
        'DESTINATION_IS_A_CONTRACT',
        demand.mint || demand.token
          ? `The payee (${address}) is a contract, not a wallet. A contract that was not written to hold this token cannot move it out again, and nothing readable on chain says which kind it is.`
          : `The payee (${address}) is a contract. A plain ${chain.nativeSymbol} transfer to a contract with no payable fallback reverts, so this payment may simply fail.`,
      ),
    );
  }

  return found;
}

/** Solana: the destination is a token account, and all three of its facts matter. */
export function checkSolanaDestination(
  chain: DemandChain,
  demand: PaymentDemand,
  facts: DemandFacts,
): DemandFinding[] {
  const found: DemandFinding[] = [];
  const { destination, derivedAta } = facts;

  if (!destination) {
    found.push(
      finding(
        'note',
        'DESTINATION_UNSTATED',
        'This demand names neither a payee nor a destination token account, so where the money would go cannot be checked at all.',
      ),
    );
    return found;
  }

  // Native payments: the recipient need not exist, the transfer creates it.
  if (!facts.token && !facts.tokenMissing) {
    if (facts.recipientIsTokenAccount) {
      found.push(
        finding(
          'fatal',
          'DESTINATION_IS_A_TOKEN_ACCOUNT',
          `This demand asks for native ${chain.nativeSymbol} but names ${destination.address}, which is a token account. Lamports sent there are not credited as a token balance and are not recoverable by its owner in the ordinary way.`,
        ),
      );
    }
    return found;
  }

  if (!destination.exists) {
    // Whether a missing destination is fatal turns entirely on one question:
    // is this address derivable from the payee and mint the demand itself
    // names? If it is, it is that payee's canonical account, creating it is
    // what any wallet does, and the funds land where they are being watched
    // for. If it is not, then nothing ties the address to the payee and
    // creating an account there is how money reaches somewhere nobody is
    // looking. The first version refused both, which condemned every honest
    // invoice to a payee who had simply never held the token.
    if (!demand.tokenAccount || destination.isAssociated) {
      found.push(
        finding(
          'warning',
          'DESTINATION_UNCREATED',
          `The payee holds no token account for this mint yet (${destination.address}). It is the associated account derived from the payee and mint this demand names, so creating it pays them at their canonical address — but the transfer fails unless it is created in the same transaction, which costs the sender about 0.002 SOL of rent.`,
        ),
      );
      return found;
    }

    found.push(
      finding(
        'fatal',
        'DESTINATION_DOES_NOT_EXIST',
        `The token account this demand names as the destination (${destination.address}) does not exist on ${chain.name}, and it is not the associated account for the payee and mint the demand names${derivedAta ? ` — that would be ${derivedAta}` : ''}. Nothing ties this address to the payee, so creating an account there would put the money somewhere nobody is watching. A destination that is neither an existing account nor the derived one usually means it was computed from different values than the ones you were shown.`,
      ),
    );
    return found;
  }

  if (facts.token && destination.mint && destination.mint !== facts.token.address) {
    found.push(
      finding(
        'fatal',
        'DESTINATION_WRONG_MINT',
        `The destination account holds mint ${destination.mint}, and this demand is denominated in ${facts.token.address}. The token program rejects a transfer of one mint into an account opened for another.`,
      ),
    );
  }

  if (demand.to && destination.owner && destination.owner !== demand.to.trim()) {
    found.push(
      finding(
        'fatal',
        'DESTINATION_WRONG_OWNER',
        `The destination account belongs to ${destination.owner}, and this demand names ${demand.to} as the payee. Paying it credits somebody other than the party you are transacting with.`,
      ),
    );
  }

  if (destination.frozen) {
    found.push(
      finding(
        'fatal',
        'DESTINATION_FROZEN',
        'The destination account is frozen, so it cannot receive this token. The transfer fails until whoever holds the freeze authority thaws it.',
      ),
    );
  }

  return found;
}

/** What the mint's own powers mean for the party about to pay. */
export function checkTokenRisk(facts: DemandFacts): DemandFinding[] {
  const found: DemandFinding[] = [];

  if (facts.transferFee) {
    // A warning rather than a refusal, matching what `inspect_exit` already
    // decided about the same extension: a transfer fee is a reason to price
    // differently, not to abort. What it must not be is silent — paying the
    // amount as demanded delivers less than the amount demanded, and the payee
    // records it short.
    found.push(
      finding(
        'warning',
        'TRANSFER_FEE',
        'This mint charges a fee on every transfer, so the payee receives less than you send. Paying exactly the amount demanded will be recorded as an underpayment — settle the gross amount, or agree the shortfall first.',
      ),
    );
  }

  const { risk } = facts;
  if (!risk) return found;

  if (risk.transferHook) {
    found.push(
      finding(
        'warning',
        'TRANSFER_HOOK',
        `Every transfer of this mint calls program ${risk.transferHook}, which the issuer controls and which can make this payment fail on conditions you cannot see.`,
      ),
    );
  }

  if (risk.freezeAuthority || risk.permanentDelegate) {
    found.push(
      finding(
        'note',
        'TOKEN_NOT_FULLY_YOURS',
        "Whoever holds this mint's authorities can freeze or move it after it lands. That exposes the payee more than you, and it also means a refund of this payment is not entirely within their power.",
      ),
    );
  }

  return found;
}

const RANK: Record<DemandSeverity, number> = { fatal: 0, warning: 1, note: 2 };

/**
 * Every finding a demand produces, worst first.
 *
 * Order of checks matters only in that the cheap offline ones come first, so a
 * demand that is wrong on its face says so even when the chain is unreachable.
 */
export function classifyDemand(
  chain: DemandChain,
  demand: PaymentDemand,
  facts: DemandFacts,
  authentic?: string,
): DemandFinding[] {
  const found: DemandFinding[] = [];

  for (const label of facts.malformed ?? []) {
    found.push(
      finding(
        'fatal',
        'ADDRESS_MALFORMED',
        `The ${label} this demand names is not a Solana address, so there is nothing to pay to it.`,
      ),
    );
  }

  const expiry = checkExpiry(demand);
  if (expiry) found.push(expiry);

  const asset = checkClaimedAsset(chain, demand, authentic);
  if (asset) found.push(asset);

  if (facts.unreadable) {
    found.push(
      finding(
        'note',
        'CHAIN_UNREADABLE',
        `${chain.name} could not be read, so nothing here was checked against it: ${facts.unreadable}`,
      ),
    );
    return found.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
  }

  if (facts.tokenMissing) {
    const named = demand.token ?? demand.mint;
    found.push(
      finding(
        'fatal',
        'TOKEN_DOES_NOT_EXIST',
        chain.family === 'evm'
          ? `Nothing at ${named} on ${chain.name} answers as an ERC-20. The address is well-formed — which is why nothing upstream rejected it — but there is either no contract there or one that does not implement the token interface, so this demand cannot be paid in the asset it names.`
          : `No SPL mint exists at ${named} on ${chain.name}. The address is valid base58 — which is why nothing upstream rejected it — but there is no token there, so this demand cannot be paid in the asset it names.`,
      ),
    );
    // Everything downstream is measured against a mint, so there is nothing
    // honest left to check. Saying less here is the point.
    return found.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
  }

  found.push(...checkAmounts(demand, facts.token?.decimals ?? chain.nativeDecimals));
  found.push(...checkDestination(chain, demand, facts));
  found.push(...checkTokenRisk(facts));

  return found.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
}

/**
 * Whether this demand can be paid, given what was found.
 *
 * `unproven` exists so an unreachable endpoint never reads as a clean bill of
 * health. A validator that cannot tell "I checked and it is fine" from "I could
 * not check" is one whose approval means nothing.
 */
export function demandVerdict(findings: DemandFinding[], read: boolean): DemandVerdict {
  if (findings.some((f) => f.severity === 'fatal')) return 'unpayable';
  return read ? 'payable' : 'unproven';
}

/** One sentence for whoever has to act on this. Never empty. */
export function demandNote(findings: DemandFinding[], verdict: DemandVerdict): string {
  const fatal = findings.filter((f) => f.severity === 'fatal');

  if (fatal.length > 0) {
    const count =
      fatal.length === 1 ? 'One thing makes it unpayable' : `${fatal.length} things make it unpayable`;
    return `Do not pay this. ${count} as stated: ${fatal[0]!.detail}`;
  }

  if (verdict === 'unproven') {
    return 'Nothing was found wrong with this demand, and nothing was confirmed either — the chain could not be read, so treat this as unchecked rather than as cleared.';
  }

  if (findings.length > 0) {
    return `This demand can be paid as stated, with ${findings.length} thing${findings.length === 1 ? '' : 's'} worth reading first.`;
  }

  return 'This demand can be paid as stated: the asset exists, the destination exists and belongs to the payee named, and the amounts agree.';
}
