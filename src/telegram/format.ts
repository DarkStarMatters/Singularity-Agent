/**
 * Rendering for Telegram's HTML parse mode.
 *
 * Two rules hold throughout, and `truncateForTelegram` depends on both:
 *   1. Every tag opens and closes on the same line, so cutting the text on a
 *      line boundary can never leave unbalanced HTML (which Telegram rejects
 *      with a 400 for the whole message).
 *   2. Every value interpolated from chain data goes through `esc`. Token
 *      symbols are attacker-controlled — a scam token can be named `<b>`.
 */
import type {
  Amount,
  BalanceEntry,
  DecodedCall,
  MintAudit,
  FeeEstimate,
  NormalizedBlock,
  NormalizedTx,
  ResolvedIdentity,
  UnsignedTx,
} from '../core/types.js';
import type {
  BalanceResult,
  BurnClaim,
  ChainSummary,
  PortfolioResult,
} from '../tools/operations.js';
import type { TokenIdentity } from '../core/types.js';
import type { TokenExitReport } from '../trade/types.js';
import type { PaymentDemandReport } from '../pay/types.js';
import type { SettlementResult } from '../pay/operations.js';
import type { StoredIntent } from '../pay/intent.js';
import type { TransactionHistory } from '../core/adapter.js';
import { describeAge, type ChainLiveness } from '../core/liveness.js';
import { SingularityError } from '../core/errors.js';

/** Telegram HTML mode needs exactly these three escaped. */
export function esc(value: unknown): string {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function code(value: unknown): string {
  return `<code>${esc(value)}</code>`;
}

export function bold(value: unknown): string {
  return `<b>${esc(value)}</b>`;
}

function link(url: string, label: string): string {
  return `<a href="${esc(url)}">${esc(label)}</a>`;
}

/** Addresses are unreadable at full length in a phone-width chat bubble. */
function shortAddress(address: string): string {
  return address.length <= 16 ? address : `${address.slice(0, 8)}…${address.slice(-6)}`;
}

function amountLine(amount: Amount): string {
  return `${esc(amount.formatted)} ${esc(amount.symbol)}`;
}

function tokenLine(entry: BalanceEntry): string {
  const accounts = entry.tokenAccounts && entry.tokenAccounts > 1 ? ` (${entry.tokenAccounts} accounts)` : '';
  // A chat client shows the symbol and nothing else, which is the whole reason
  // a contract wearing someone else's name works. Say it on the line itself.
  const impersonation = entry.token.impersonation;
  const warning = impersonation
    ? `\n    ⚠️ ${esc(`Not the real ${impersonation.symbol}`)}${
        impersonation.authentic ? ` — that is ${code(impersonation.authentic)}` : ' — that has no contract at all'
      }`
    : '';
  return `  • ${amountLine(entry.amount)}${esc(accounts)}${warning}`;
}

export function formatBalance(result: BalanceResult): string {
  const lines = [
    `${bold(result.chain)} — ${code(shortAddress(result.address))}`,
    '',
    bold(amountLine(result.native.amount)),
  ];

  if (result.tokens.length) {
    lines.push('', bold('Tokens'), ...result.tokens.map(tokenLine));
  }
  if (result.tokenScanNote) lines.push('', `<i>${esc(result.tokenScanNote)}</i>`);
  if (result.explorerUrl) lines.push('', link(result.explorerUrl, 'View on explorer'));

  return lines.join('\n');
}

export function formatPortfolio(result: PortfolioResult): string {
  const lines = [bold(`Portfolio — ${shortAddress(result.address)}`), ''];

  for (const balance of result.balances) {
    const tokens = balance.tokens
      .filter((t) => Number(t.amount.formatted) > 0)
      .map((t) => `${t.amount.formatted} ${t.token.symbol}`);

    lines.push(`${bold(balance.chain)}: ${amountLine(balance.native.amount)}`);
    if (tokens.length) lines.push(`  ${esc(tokens.join(' · '))}`);
  }

  if (!result.balances.length) lines.push('<i>No balances found on the chains queried.</i>');

  for (const error of result.errors) {
    lines.push(`${bold(error.chain)}: <i>${esc(error.error)}</i>`);
  }

  // Which chains were actually queried is the interesting part of a cross-family
  // sweep — the ones missing were skipped as inapplicable, not failed.
  lines.push('', `<i>Queried: ${esc(result.chainsQueried.join(', '))}</i>`);
  lines.push('<i>Balances only — no fiat pricing.</i>');

  return lines.join('\n');
}

const STATUS_ICON: Record<NormalizedTx['status'], string> = {
  success: '✅',
  failed: '❌',
  pending: '⏳',
  unknown: '❔',
};

export function formatTransaction(tx: NormalizedTx): string {
  const lines = [
    `${STATUS_ICON[tx.status]} ${bold(tx.chain)} — ${esc(tx.status)}`,
    '',
    esc(tx.summary),
    '',
    `${bold('Hash')}: ${code(shortAddress(tx.hash))}`,
  ];

  if (tx.from) lines.push(`${bold('From')}: ${code(shortAddress(tx.from))}`);
  if (tx.to) lines.push(`${bold('To')}: ${code(shortAddress(tx.to))}`);
  if (tx.value) lines.push(`${bold('Value')}: ${amountLine(tx.value)}`);
  if (tx.fee) lines.push(`${bold('Fee')}: ${amountLine(tx.fee)}`);
  if (tx.blockNumber !== undefined) lines.push(`${bold('Block')}: ${esc(tx.blockNumber)}`);
  if (tx.timestamp) lines.push(`${bold('Time')}: ${esc(tx.timestamp)}`);

  if (tx.decoded?.signature) {
    lines.push('', `${bold('Decoded')}: ${code(tx.decoded.signature)}`);
    for (const arg of tx.decoded.args ?? []) {
      lines.push(`  ${esc(arg.name ?? arg.type ?? '?')} = ${code(arg.value)}`);
    }
  }

  if (tx.explorerUrl) lines.push('', link(tx.explorerUrl, 'View on explorer'));
  return lines.join('\n');
}

/**
 * `getTransaction` without a chain searches several, so the same hash can land
 * on more than one — an identical deployment or a replayed tx across EVM chains.
 * Collapsing that to "the" transaction would hide a genuinely useful signal.
 */
export function formatTransactionSearch(result: {
  found: NormalizedTx[];
  searched: string[];
  note?: string;
}): string {
  if (!result.found.length) {
    return [
      '⚠️ Transaction not found.',
      '',
      `<i>Searched: ${esc(result.searched.join(', '))}</i>`,
      ...(result.note ? ['', `<i>${esc(result.note)}</i>`] : []),
    ].join('\n');
  }

  const parts = result.found.map(formatTransaction);
  if (result.found.length > 1) {
    parts.unshift(bold(`Found on ${result.found.length} chains`) + '\n');
  }
  return parts.join('\n\n');
}

/**
 * An address's history, for a chat.
 *
 * A `failed` completeness is the whole message rather than a footnote under an
 * empty list. In a chat the caveat under nothing at all is the line most likely
 * to go unread, and it is the line that says whether "nothing" means anything.
 */
export function formatHistory(history: TransactionHistory): string {
  const header = `${bold('History')} — ${code(shortAddress(history.address))} on ${esc(history.chain)}`;

  if (history.completeness.kind === 'failed') {
    return [header, '', esc(history.completeness.note)].join('\n');
  }

  if (!history.entries.length) {
    return [header, '', 'No transactions.', '', `<i>${esc(history.completeness.note)}</i>`].join('\n');
  }

  const rows = history.entries.map((entry: TransactionHistory['entries'][number]) => {
    const way =
      entry.direction === 'in'
        ? '←'
        : entry.direction === 'out'
          ? '→'
          : entry.direction === 'self'
            ? '↺'
            : '•';
    const when = entry.timestamp ? entry.timestamp.slice(0, 10) : 'unconfirmed';
    const failed = entry.status === 'failed' ? ' (failed)' : '';

    // `summary` is written by this tool. Nothing read off the chain is
    // interpolated here, which is why a memo cannot reach a chat message.
    return `${way} ${esc(when)}  ${esc(entry.summary)}${failed}\n   ${code(shortAddress(entry.hash))}`;
  });

  return [header, '', rows.join('\n'), '', `<i>${esc(history.completeness.note)}</i>`].join('\n');
}

export function formatFees(fees: FeeEstimate): string {
  const lines = [bold(`Fees — ${fees.chain}`), ''];

  if (fees.simpleTransfer) lines.push(`${bold('Simple transfer')}: ${amountLine(fees.simpleTransfer)}`);
  for (const [key, value] of Object.entries(fees.details)) {
    lines.push(`${bold(key)}: ${esc(value)}`);
  }
  if (fees.note) lines.push('', `<i>${esc(fees.note)}</i>`);

  return lines.join('\n');
}

export function formatBlock(block: NormalizedBlock): string {
  const lines = [
    bold(`${block.chain} block ${block.number}`),
    '',
    `${bold('Hash')}: ${code(shortAddress(block.hash))}`,
    `${bold('Transactions')}: ${esc(block.txCount)}`,
  ];
  if (block.timestamp) lines.push(`${bold('Time')}: ${esc(block.timestamp)}`);
  if (block.explorerUrl) lines.push('', link(block.explorerUrl, 'View on explorer'));
  return lines.join('\n');
}

export function formatResolved(identity: ResolvedIdentity): string {
  const lines = [`${bold('Resolved')}: ${code(identity.input)}`, '', `${bold('Kind')}: ${esc(identity.kind)}`];

  if (identity.address) lines.push(`${bold('Address')}: ${code(identity.address)}`);
  if (identity.name) lines.push(`${bold('Name')}: ${esc(identity.name)}`);
  if (identity.chains?.length) lines.push(`${bold('Chains')}: ${esc(identity.chains.join(', '))}`);
  if (identity.note) lines.push('', `<i>${esc(identity.note)}</i>`);

  return lines.join('\n');
}

export function formatChains(chains: ChainSummary[]): string {
  const families = new Map<string, string[]>();
  for (const chain of chains) {
    const list = families.get(chain.family) ?? [];
    list.push(chain.id);
    families.set(chain.family, list);
  }

  const lines = [bold(`${chains.length} chains supported`), ''];
  for (const [family, ids] of families) {
    lines.push(`${bold(family.toUpperCase())}: ${esc(ids.join(', '))}`);
  }
  return lines.join('\n');
}

/**
 * Warnings come first and the payload last. In a group the payload is a wall of
 * hex that pushes everything above it off-screen, and the warnings are the only
 * thing standing between someone and a signature.
 */
/**
 * An unsigned transaction, laid out so the long string cannot be mistaken for
 * the other long string.
 *
 * The first version dumped every payload field under a heading of "Payload",
 * and on Solana the field holding the bytes is called `transaction`. Somebody
 * then asked to redeem a burn, reasonably pasted the thing labelled
 * `transaction`, and got told it was not a signature — which was true, useless,
 * and entirely the formatting's fault. A payload is a *proposal* and a signature
 * is its *receipt*; they exist at different times and only one of them exists
 * yet. So the signable string gets its own heading saying what it is, the rest
 * of the payload moves under "Details", and the gap between the two is spelled
 * out rather than left to be inferred from a field name.
 */
export function formatUnsignedTx(tx: UnsignedTx): string {
  const lines = [bold('Unsigned transaction'), '', esc(tx.summary), ''];

  for (const warning of tx.warnings) lines.push(`⚠️ ${esc(warning)}`);

  const { transaction, ...rest } = tx.payload as { transaction?: unknown } & Record<string, unknown>;

  if (typeof transaction === 'string') {
    lines.push(
      '',
      bold('Sign this string'),
      code(transaction),
      '',
      `<i>${esc(
        'That is the transaction to sign — it is not a signature. Signing and sending it is what produces one: about 88 characters, no "+", "/" or "=". The signature is what /redeem wants; this string is not.',
      )}</i>`,
    );
  }

  lines.push('', `<i>${esc(tx.signingHint)}</i>`);

  if (Object.keys(rest).length) {
    lines.push('', bold('Details'));
    for (const [key, value] of Object.entries(rest)) {
      lines.push(`${esc(key)}: ${code(typeof value === 'string' ? value : JSON.stringify(value))}`);
    }
  }

  lines.push('', '<i>Singularity holds no keys. Nothing here has been signed or broadcast.</i>');
  return lines.join('\n');
}

/**
 * A decoded call. The `note` branch matters: an unrecognized selector is a
 * useful answer ("this is not a function I know"), not a failure, and saying so
 * is better than showing an empty argument list as if it decoded cleanly.
 */
export function formatDecoded(call: DecodedCall): string {
  const lines = [bold('Decoded calldata'), ''];

  if (call.signature) lines.push(`${bold('Signature')}: ${code(call.signature)}`);
  else if (call.name) lines.push(`${bold('Function')}: ${code(call.name)}`);
  if (call.selector) lines.push(`${bold('Selector')}: ${code(call.selector)}`);

  if (call.args?.length) {
    lines.push('', bold('Arguments'));
    call.args.forEach((arg, index) => {
      const label = arg.name || `arg${index}`;
      const type = arg.type ? ` <i>(${esc(arg.type)})</i>` : '';
      lines.push(`  ${esc(label)}${type}: ${code(arg.value)}`);
    });
  }

  if (call.note) lines.push('', `<i>${esc(call.note)}</i>`);
  return lines.join('\n');
}

/**
 * Contract reads return whatever the function returns, so there is no fixed
 * shape to format. Scalars are shown plainly and anything structured goes in a
 * code block, which is the only honest rendering of an unknown value.
 */
export function formatReadResult(chain: string, address: string, value: unknown): string {
  const lines = [`${bold('Contract read')} — ${esc(chain)}`, code(shortAddress(address)), ''];

  if (value === null || value === undefined) {
    lines.push('<i>The call returned nothing.</i>');
  } else if (typeof value === 'object') {
    lines.push(`<pre>${esc(JSON.stringify(value, null, 2))}</pre>`);
  } else {
    lines.push(code(String(value)));
  }

  return lines.join('\n');
}

export interface EndpointHealth {
  chain: string;
  ok: boolean;
  ms: number;
  error?: string;
}

/**
 * Endpoint health, failures first — a list of 40 green ticks buries the one
 * red line that the person actually needs to see.
 */
/**
 * The liveness board, for a chat window.
 *
 * Ordered worst first rather than by chain, because the whole reason this is
 * not the old reachability list is that the interesting rows are the ones that
 * would otherwise look fine. A live chain gets one line; anything else gets its
 * reason, since "stale" without "the head is 76 days old" is not actionable.
 */
export function formatLiveness(report: ChainLiveness[]): string {
  const icon: Record<ChainLiveness['status'], string> = {
    live: '✅',
    single: '⚠️',
    undatable: '⚠️',
    skewed: '⚠️',
    lagging: '⚠️',
    stale: '🛑',
    down: '❌',
  };

  const rank: Record<ChainLiveness['status'], number> = {
    stale: 0,
    down: 1,
    lagging: 2,
    skewed: 3,
    undatable: 4,
    single: 5,
    live: 6,
  };

  const sorted = [...report].sort((a, b) => rank[a.status] - rank[b.status]);
  const live = report.filter((c) => c.status === 'live').length;

  const lines = [bold('Chain liveness'), `${live}/${report.length} fully live`, ''];

  for (const chain of sorted) {
    const age = chain.ageSeconds !== undefined ? ` <i>${esc(describeAge(chain.ageSeconds))}</i>` : '';
    lines.push(
      `${icon[chain.status]} ${bold(chain.chain)} — ${esc(chain.status)}` +
        ` <i>${chain.answering}/${chain.configured} rpc</i>${age}`,
    );
    if (chain.status !== 'live') {
      for (const note of chain.notes) lines.push(`   ${esc(note)}`);
    }
  }

  return lines.join('\n');
}

export function formatHealth(results: EndpointHealth[]): string {
  const failed = results.filter((r) => !r.ok);
  const healthy = results.filter((r) => r.ok);

  const lines = [
    bold('Endpoint health'),
    `${healthy.length}/${results.length} reachable`,
    '',
  ];

  for (const result of failed) {
    lines.push(`❌ ${bold(result.chain)} — ${esc(result.error ?? 'unreachable')}`);
  }
  if (failed.length && healthy.length) lines.push('');

  for (const result of healthy) {
    lines.push(`✅ ${esc(result.chain)} <i>${esc(result.ms)}ms</i>`);
  }

  return lines.join('\n');
}

/** A hint is the actionable half of a Singularity error — always show it. */
export function formatError(err: unknown): string {
  if (err instanceof SingularityError) {
    const lines = [`⚠️ ${esc(err.message)}`];
    if (err.hint) lines.push('', `<i>${esc(err.hint)}</i>`);
    return lines.join('\n');
  }
  return `⚠️ ${esc((err as Error)?.message ?? String(err))}`;
}

/**
 * A mint audit in a chat bubble.
 *
 * Powers first and settled facts second, because someone asking this in a group
 * is deciding whether to hold the thing, and what can still be done to them is
 * the answer. The holder address goes on its own line rather than inline: a
 * phone-width bubble wraps a 44-character key into unreadable soup.
 */
export function formatMintAudit(audit: MintAudit): string {
  const name = audit.metadata
    ? `${esc(audit.metadata.name)} (${esc(audit.metadata.symbol)})`
    : code(shortAddress(audit.mint));

  const lines = [
    `${bold('Mint audit')} — ${name}`,
    `${code(audit.mint)}`,
    `${esc(audit.program)} · supply ${amountLine(audit.supply)}`,
  ];

  if (audit.impersonation) {
    lines.push('', `⚠️ ${esc(audit.impersonation.note)}`);
  }

  if (audit.powers.length) {
    lines.push('', bold('Still possible'));
    for (const power of audit.powers) {
      lines.push(`  • ${bold(power.kind)} — ${esc(power.what)}`);
      if (power.holder) lines.push(`    ${code(power.holder)}`);
    }
  }

  if (audit.settled.length) {
    lines.push('', bold('Settled'));
    for (const fact of audit.settled) lines.push(`  ✅ ${esc(fact)}`);
  }

  if (audit.metadata) {
    lines.push('', `<i>${esc('The name and ticker above were chosen by whoever deployed the mint.')}</i>`);
  }

  lines.push(`<i>${esc(audit.note)}</i>`);
  if (audit.explorerUrl) lines.push(link(audit.explorerUrl, 'explorer'));

  return lines.join('\n');
}

/**
 * A burn receipt in a chat bubble.
 *
 * The memo is the one field here somebody else wrote, so it is escaped like
 * every other piece of chain data and labelled as theirs. It is also the field
 * most likely to be read as an instruction, because writing one is the whole
 * point of a memo.
 */
export function formatBurnClaim(
  claim: BurnClaim & { redemption?: { redeemedAt: string; purpose?: string } },
): string {
  const { receipt } = claim;
  const lines = [`${bold('Burn')} ${code(receipt.signature.slice(0, 16) + '…')}`];

  for (const burn of receipt.burns) {
    const matched = claim.matched && claim.matched.account === burn.account ? ' ✅' : '';
    lines.push(`  • ${esc(burn.amount.formatted)} of ${code(burn.mint)}${matched}`);
    lines.push(`    ${esc('burned by')} ${code(burn.owner)}`);
  }

  if (receipt.memo) {
    lines.push('', `${bold('Memo')} — ${esc(receipt.memo.source)}`, code(receipt.memo.text));
  }

  if (claim.redemption) {
    lines.push(
      '',
      `✅ ${esc('Redeemed')} ${esc(claim.redemption.redeemedAt)}${
        claim.redemption.purpose ? ` — ${esc(claim.redemption.purpose)}` : ''
      }`,
    );
  } else if (claim.redeemed) {
    lines.push('', `⚠️ ${esc(`Already redeemed ${claim.redeemed.redeemedAt}`)}`);
  }

  lines.push('', `<i>${esc(receipt.note)}</i>`);
  if (receipt.explorerUrl) lines.push(link(receipt.explorerUrl, 'explorer'));

  return lines.join('\n');
}

/**
 * A mint’s identity in a chat bubble.
 *
 * This is the answer to "is this the real one", asked in the place it is
 * always asked — a group chat, about a link somebody pasted. So the address
 * leads, the declared accounts are shown as the mint’s own claim rather than
 * as endorsement, and whether any of it can be rewritten is on its own line.
 */
export function formatTokenIdentity(identity: TokenIdentity): string {
  const title = identity.name
    ? `${esc(identity.name)} (${esc(identity.symbol ?? '')})`
    : code(identity.mint);

  const anchored = identity.immutable.metadata === 'immutable' && identity.immutable.document;

  const lines = [`${bold('Identity')} — ${title}`, code(identity.mint), ''];

  lines.push(`${anchored ? '🔒' : '⚠️'} ${esc(identity.immutable.note)}`);

  if (identity.impersonation) {
    lines.push('', `⚠️ ${esc(identity.impersonation.note)}`);
  }

  if (identity.accounts?.length) {
    lines.push('', bold('Declared by this mint'));
    for (const account of identity.accounts) {
      lines.push(`  • ${esc(account.kind)} — ${code(account.value.text)}`);
    }
  }

  if (identity.document) lines.push('', `<i>${esc(identity.document.note)}</i>`);
  lines.push(`<i>${esc(identity.note)}</i>`);
  if (identity.explorerUrl) lines.push(link(identity.explorerUrl, 'explorer'));

  return lines.join('\n');
}

/**
 * An exit report, for a chat message somebody reads on a phone before buying.
 *
 * Two headline lines, never one. "Sellable" and "nobody can stop you" are
 * different claims, and a single green tick would merge them — which is how
 * USDC came back looking like a soulbound token in the first draft.
 */
export function formatExitReport(report: TokenExitReport): string {
  const lines = [`${bold('Exit analysis')} — ${code(report.mint)}`, ''];

  lines.push(
    report.canExit
      ? '✅ <b>Sellable</b> — nothing in the mint stops a sale'
      : '⛔ <b>Not sellable</b> — the mint itself blocks it',
  );

  lines.push(
    report.underThirdPartyControl
      ? '⚠️ <b>Controlled</b> — a named party can stop you whenever they choose'
      : '✅ <b>Uncontrolled</b> — no third party can freeze or seize it',
  );

  const groups = [
    ['blocks', '⛔', 'Blocks a sale outright'],
    ['discretionary', '⚠️', 'Can be stopped, by a named party, at any time'],
    ['degrades', 'ℹ️', 'Sells, on worse terms'],
  ] as const;

  for (const [severity, mark, heading] of groups) {
    const found = report.risks.filter((risk) => risk.severity === severity);
    if (found.length === 0) continue;

    lines.push('', bold(heading));
    for (const risk of found) {
      lines.push(`${mark} <b>${esc(risk.mechanism)}</b>`);
      lines.push(`  ${esc(risk.note)}`);
      if (risk.holder) lines.push(`  held by ${code(risk.holder)}`);
    }
  }

  if (report.concentration) {
    const { largestPercent, topPercent, accountsCounted, largestIsPool } = report.concentration;
    lines.push(
      '',
      `${bold('Supply')} — largest ${largestPercent.toFixed(1)}%, top ${accountsCounted} hold ${topPercent.toFixed(1)}%`,
    );
    if (largestIsPool !== undefined) {
      lines.push(
        `  <i>${largestIsPool ? 'largest holder is a recognised pool' : 'largest holder is not a recognised pool'}</i>`,
      );
    }
  }

  // The completeness note is not a footnote here. It is the sentence that stops
  // somebody reading a clean report as permission to buy.
  lines.push('', `<i>${esc(report.completeness.note)}</i>`);
  if (report.explorerUrl) lines.push(link(report.explorerUrl, 'explorer'));

  return lines.join('\n');
}

/**
 * A settlement verdict, for somebody deciding whether to ship.
 *
 * Two lines before any detail, because they answer different questions and a
 * merchant needs both: how settled the payment is, and whether *this* call is
 * the one that should act on it. The second is not derivable from the first —
 * `final` stays true on every later check, and a bot polling in a loop would
 * ship the same order each time.
 */
export function formatSettlement(result: SettlementResult): string {
  const level =
    result.level === 'final'
      ? '✅ <b>Final</b> — irreversible'
      : result.level === 'probabilistic'
        ? '⏳ <b>Confirmed, not final</b> — can still be dropped'
        : result.level === 'pending'
          ? '⏳ <b>Pending</b>'
          : '⬜ <b>Unpaid</b>';

  const lines = [
    `${bold('Payment')} — ${code(result.intent.id)}`,
    '',
    level,
    result.fulfil
      ? '✅ <b>Fulfil now</b> — this is the one check that should release the order'
      : result.alreadyFulfilled
        ? `☑️ Already fulfilled at ${esc(result.alreadyFulfilled.at)}`
        : '⛔ <b>Do not fulfil</b>',
  ];

  if (result.mismatches.length > 0) {
    lines.push('', bold('This is not your payment'));
    for (const mismatch of result.mismatches) lines.push(`⛔ ${esc(mismatch)}`);
  }

  if (result.paid) lines.push('', `paid ${bold(result.paid.formatted)}`);
  if (result.from) lines.push(`from ${code(result.from)}`);
  if (result.signature) lines.push(`sig ${code(result.signature)}`);

  lines.push('', `<i>${esc(result.note)}</i>`);

  return lines.join('\n');
}

/**
 * Open payment requests, for a chat that wants to know what it is owed.
 *
 * Each row leads with its state rather than its id, because the question being
 * asked is "has anything been paid" and the id is only useful once the answer
 * is no.
 */
export function formatIntentList(intents: StoredIntent[], total: number): string {
  const lines = [bold('Payment requests'), ''];

  for (const intent of intents) {
    const state = intent.settledAt
      ? '✅'
      : new Date(intent.expiresAt) < new Date()
        ? '⌛'
        : '⬜';

    const asset = intent.mint ? code(intent.mint.slice(0, 8)) : 'SOL';
    lines.push(`${state} <b>${esc(intent.amount)}</b> ${asset}${intent.orderId ? ` — ${esc(intent.orderId)}` : ''}`);
    lines.push(`     <code>${intent.id}</code>`);
  }

  if (total > intents.length) {
    lines.push('', `<i>${total - intents.length} more not shown.</i>`);
  }

  lines.push('', '<i>⬜ open · ✅ paid · ⌛ expired. Check one with /paid &lt;id&gt;.</i>');

  return lines.join('\n');
}

/**
 * A payment demand, rendered for somebody about to decide whether to sign.
 *
 * The verdict goes first and the worst finding goes second, because this is
 * read on a phone by somebody with a wallet already open. Everything else can
 * scroll.
 */
export function formatPaymentDemand(report: PaymentDemandReport): string {
  const lines = [`${bold('Payment check')} — ${esc(report.chain)}`, ''];

  const verdicts = {
    unpayable: '⛔ <b>Do not pay</b> — this cannot do what it says',
    payable: '✅ <b>Payable</b> — every stated claim checks out',
    unproven: '❓ <b>Unchecked</b> — the chain would not answer',
  } as const;

  lines.push(verdicts[report.verdict], '', esc(report.note));

  if (report.token) {
    const named = report.token.symbol ? ` (${esc(report.token.symbol)})` : '';
    lines.push('', `${bold('Asset')} ${code(report.token.mint)}${named}, ${report.token.decimals} decimals`);
  }

  if (report.destination) {
    const { address, exists, owner, frozen } = report.destination;
    lines.push('', `${bold('Destination')} ${code(address)}`);
    lines.push(`  ${exists ? 'exists' : '<b>does not exist</b>'}${frozen ? ', <b>frozen</b>' : ''}`);
    if (owner) lines.push(`  owned by ${code(owner)}`);
  }

  const groups = [
    ['fatal', '⛔', 'Stops this being a payment'],
    ['warning', '⚠️', 'Worth knowing before you sign'],
    ['note', 'ℹ️', 'Recorded'],
  ] as const;

  for (const [severity, mark, heading] of groups) {
    const found = report.findings.filter((f) => f.severity === severity);
    if (found.length === 0) continue;

    lines.push('', bold(heading));
    for (const f of found) {
      lines.push(`${mark} <b>${esc(f.code)}</b>`);
      lines.push(`  ${esc(f.detail)}`);
    }
  }

  return lines.join('\n');
}
