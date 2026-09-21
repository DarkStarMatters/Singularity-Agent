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
  /** Named in the demand, exists, and is a mint. */
  mint?: { address: string; decimals: number; curatedSymbol?: string };
  /** A mint was named and there is no mint at that address. */
  mintMissing?: boolean;
  /** Where the money would land, as read rather than as claimed. */
  destination?: DemandDestination;
  /** The associated token account for the payee and mint, where both are known. */
  derivedAta?: string;
  /** A native payment aimed at something owned by a token program. */
  recipientIsTokenAccount?: boolean;
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
  if (!demand.asset || !demand.mint || !authentic) return undefined;
  if (authentic === demand.mint.trim()) return undefined;

  return finding(
    'fatal',
    'ASSET_NOT_WHAT_IT_CLAIMS',
    `This demand calls itself ${demand.asset}, but ${demand.asset} on ${chain.name} is ${authentic} and the mint it names is ${demand.mint}. Those are different tokens. A ticker is not an identity — anyone can create a mint with any name, and one wrong character produces an address that is still valid base58.`,
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

/** What the destination turned out to be, judged against what was claimed. */
export function checkDestination(
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
  if (!facts.mint && !facts.mintMissing) {
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
    if (demand.tokenAccount) {
      found.push(
        finding(
          'fatal',
          'DESTINATION_DOES_NOT_EXIST',
          `The token account this demand names as the destination (${destination.address}) does not exist on ${chain.name}. A transfer to it fails rather than waiting, and a client that creates an account there instead would be paying rent on a destination the payee is not watching.`,
        ),
      );
      if (derivedAta && derivedAta !== destination.address) {
        found.push(
          finding(
            'warning',
            'DESTINATION_NOT_DERIVED',
            `It is not the associated token account for the payee and mint this demand names either — that would be ${derivedAta}. A destination that is neither an existing account nor the derived one usually means it was derived from different values than the ones you were shown.`,
          ),
        );
      }
    } else {
      found.push(
        finding(
          'warning',
          'DESTINATION_UNCREATED',
          `The payee holds no token account for this mint yet (${destination.address}). The transfer fails unless that account is created in the same transaction, which costs the sender about 0.002 SOL of rent.`,
        ),
      );
    }
    return found;
  }

  if (facts.mint && destination.mint && destination.mint !== facts.mint.address) {
    found.push(
      finding(
        'fatal',
        'DESTINATION_WRONG_MINT',
        `The destination account holds mint ${destination.mint}, and this demand is denominated in ${facts.mint.address}. The token program rejects a transfer of one mint into an account opened for another.`,
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

  if (facts.mintMissing) {
    found.push(
      finding(
        'fatal',
        'MINT_DOES_NOT_EXIST',
        `No SPL mint exists at ${demand.mint} on ${chain.name}. The address is valid base58 — which is why nothing upstream rejected it — but there is no token there, so this demand cannot be paid in the asset it names.`,
      ),
    );
    // Everything downstream is measured against a mint, so there is nothing
    // honest left to check. Saying less here is the point.
    return found.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
  }

  found.push(...checkAmounts(demand, facts.mint?.decimals ?? chain.nativeDecimals));
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
