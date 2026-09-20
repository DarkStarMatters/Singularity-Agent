import type {
  DecodedCall,
  FeeEstimate,
  HistoryEntry,
  MintAudit,
  TokenIdentity,
  NormalizedBlock,
  NormalizedTx,
  ResolvedIdentity,
  UnsignedTx,
} from '../core/types.js';
import type { TransactionHistory } from '../core/adapter.js';
import type { TokenExitReport } from '../trade/types.js';
import type { CreatedIntent, SettlementResult } from '../pay/operations.js';
import type { StoredIntent } from '../pay/intent.js';
import { describeAge, type ChainLiveness } from '../core/liveness.js';
import { shortAddress } from '../core/format.js';
import type { Finality } from '../core/finality.js';
import type {
  BalanceResult,
  BurnClaim,
  ChainSummary,
  PortfolioResult,
} from '../tools/operations.js';

/** Colors are opt-out via NO_COLOR and auto-off when stdout is not a TTY. */
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

const paint = (code: string) => (text: string) => (useColor ? `[${code}m${text}[0m` : text);

export const dim = paint('2');
export const bold = paint('1');
export const green = paint('32');
export const yellow = paint('33');
export const red = paint('31');
export const cyan = paint('36');

export function heading(text: string): string {
  return `\n${bold(text)}\n${dim('─'.repeat(Math.min(text.length, 60)))}`;
}

/** Left-aligned columns sized to content. Handles ragged rows. */
export function table(rows: string[][], headers?: string[]): string {
  const all = headers ? [headers, ...rows] : rows;
  if (!all.length) return dim('  (nothing to show)');

  const columnCount = Math.max(...all.map((r) => r.length));
  const widths = Array.from({ length: columnCount }, (_, i) =>
    Math.max(...all.map((r) => visibleLength(r[i] ?? ''))),
  );

  const line = (row: string[], style: (s: string) => string = (s) => s) =>
    row
      .map((cell, i) => style(pad(cell ?? '', widths[i] ?? 0)))
      .join('  ')
      .trimEnd();

  const body = rows.map((r) => `  ${line(r)}`);
  if (!headers) return body.join('\n');

  return [`  ${line(headers, bold)}`, ...body].join('\n');
}

function visibleLength(text: string): number {
  return text.replace(/\[\d+m/g, '').length;
}

function pad(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - visibleLength(text)));
}

/**
 * The liveness board.
 *
 * Every status but `live` prints its reason, because the point of this command
 * is the chains that answer and should not be trusted, and a coloured word on
 * its own does not tell anyone what to do about it. Endpoints stay folded away
 * unless asked for or unless something is wrong with them — an eighty-row dump
 * is how a report stops being read.
 */
export function renderLiveness(
  report: ChainLiveness[],
  options: { endpoints: boolean } = { endpoints: false },
): string {
  const mark: Record<ChainLiveness['status'], string> = {
    live: green('live'),
    single: yellow('single'),
    undatable: yellow('undated'),
    skewed: yellow('skewed'),
    lagging: yellow('lagging'),
    stale: red('STALE'),
    down: red('down'),
  };

  const rows = report.map((chain) => [
    mark[chain.status],
    chain.chain,
    chain.height !== undefined ? `#${chain.height}` : dim('—'),
    chain.ageSeconds !== undefined ? describeAge(chain.ageSeconds) : dim('—'),
    `${chain.answering}/${chain.configured}`,
  ]);

  const out = [table(rows, ['', 'CHAIN', 'HEAD', 'AGE', 'RPC'])];

  const explained = report.filter((c) => c.notes.length);
  if (explained.length) {
    out.push('');
    for (const chain of explained) {
      out.push(`  ${bold(chain.chain)}`);
      for (const note of chain.notes) out.push(`    ${dim(note)}`);
    }
  }

  const detailed = options.endpoints ? report : report.filter((c) => c.endpoints.some((e) => !e.ok));
  if (detailed.length) {
    out.push('');
    for (const chain of detailed) {
      out.push(`  ${bold(chain.chain)}`);
      for (const endpoint of chain.endpoints) {
        out.push(
          `    ${endpoint.ok ? green('ok') : red('fail')}  ${pad(endpoint.host, 34)} ` +
            `${pad(`${endpoint.ms}ms`, 8)}` +
            (endpoint.ok
              ? `${endpoint.height !== undefined ? `#${endpoint.height} ` : ''}` +
                `${endpoint.ageSeconds !== undefined ? dim(describeAge(endpoint.ageSeconds)) : dim('undated')}`
              : dim(truncate(endpoint.error ?? 'failed', 80))),
        );
      }
    }
  }

  const bad = report.filter((c) => c.status !== 'live').length;
  out.push(
    '',
    bad
      ? `  ${yellow(`${bad} of ${report.length} chains are not fully live.`)} ${dim('Public endpoints rate-limit aggressively — set SINGULARITY_RPC_<CHAIN> to your own.')}`
      : `  ${green(`All ${report.length} chains are live.`)}`,
  );

  return out.join('\n');
}

/** Trim on a word boundary so a cut-off host or reason stays readable. */
function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut}…`;
}

export function renderChains(chains: ChainSummary[]): string {
  if (!chains.length) return dim('No chains matched.');

  const rows = chains.map((c) => [
    cyan(c.id),
    c.name,
    c.family,
    String(c.chainId ?? '—'),
    c.nativeSymbol,
    c.testnet ? yellow('testnet') : '',
    dim(c.aliases?.join(', ') ?? ''),
  ]);

  return [
    table(rows, ['ID', 'NAME', 'FAMILY', 'CHAIN ID', 'ASSET', '', 'ALIASES']),
    dim(`\n  ${chains.length} chain(s).`),
  ].join('\n');
}

export function renderResolve(result: ResolvedIdentity): string {
  const lines = [
    `  ${bold('Input')}    ${result.input}`,
    `  ${bold('Kind')}     ${result.kind}`,
  ];
  // Shown as its own line rather than left to the note: the expansion is the
  // one step between what was typed and what was answered about.
  if (result.alias) lines.push(`  ${bold('Alias')}    ${yellow(result.alias)} ${dim('(address book)')}`);
  if (result.address) lines.push(`  ${bold('Address')}  ${cyan(result.address)}`);
  if (result.name) lines.push(`  ${bold('Name')}     ${green(result.name)}`);
  if (result.family) lines.push(`  ${bold('Family')}   ${result.family}`);
  if (result.chains.length) {
    lines.push(`  ${bold('Chains')}   ${result.chains.slice(0, 8).join(', ')}${result.chains.length > 8 ? dim(` +${result.chains.length - 8} more`) : ''}`);
  }
  if (result.equivalents) {
    lines.push(`\n  ${bold('Same account on')}`);
    for (const [chain, address] of Object.entries(result.equivalents)) {
      lines.push(`    ${dim(chain.padEnd(12))} ${address}`);
    }
  }
  if (result.note) lines.push(`\n  ${dim(result.note)}`);
  return lines.join('\n');
}

export function renderBalance(result: BalanceResult): string {
  const lines = [
    // The heading carries the block, because a historical answer that looks
    // identical to a current one is the whole hazard here.
    heading(result.atBlock === undefined ? result.chain : `${result.chain}  @ block ${result.atBlock}`),
    `  ${bold(result.native.amount.formatted)} ${result.native.token.symbol}  ${dim('(native)')}`,
  ];

  if (result.tokens.length) {
    lines.push('');
    lines.push(
      table(
        result.tokens.map((t) => [
          // A base-unit figure has to say so in the row. Unmarked, the honest
          // integer reads as an enormous holding, which is a different wrong
          // answer from the one it replaced rather than a fix.
          t.amount.decimalsUnknown
            ? `${bold(t.amount.formatted)} ${dim('base units')}`
            : bold(t.amount.formatted),
          t.token.symbol,
          dim(
            [
              t.token.address ? shorten(t.token.address) : '',
              t.tokenAccounts ? `${t.tokenAccounts} accounts` : '',
            ]
              .filter(Boolean)
              .join('  '),
          ),
          // The one thing a shortened address cannot tell you by eye: this
          // symbol belongs to something else. It goes in the row rather than a
          // footnote, because the row is what gets read. A name collision gets
          // its own wording — the symbol in this row is the token's own, so
          // "not the real USDC" next to "USDCOIN" would read as a non sequitur.
          t.token.impersonation
            ? red(
                t.token.impersonation.kind === 'curated-name'
                  ? `uses ${t.token.impersonation.symbol}'s name`
                  : `not the real ${t.token.impersonation.symbol}`,
              )
            : '',
        ]),
      ),
    );
  }

  // Spelled out under the table, because the marker in the row says there is a
  // problem and this says which address is the real one — which is the part
  // nobody can work out by looking.
  for (const t of result.tokens) {
    if (t.token.impersonation) {
      lines.push(`\n  ${red('impersonation')}  ${dim(t.token.impersonation.note)}`);
    }
  }

  // An exhaustive scan is the only one where an empty list means what it looks
  // like, so it is the only one that gets to stay quiet.
  const scan = result.tokenCompleteness;
  if (scan.kind !== 'exhaustive') {
    const label = scan.kind === 'failed' ? red('incomplete') : yellow(scan.kind);
    lines.push(`\n  ${label}  ${dim(scan.note)}`);
  } else if (!result.tokens.length) {
    lines.push(`\n  ${dim(`No tokens. ${scan.note}`)}`);
  }

  if (result.explorerUrl) lines.push(`  ${dim(result.explorerUrl)}`);

  return lines.join('\n');
}

export function renderPortfolio(result: PortfolioResult): string {
  const sections = [
    heading(`Portfolio for ${result.address}`),
    dim(`  Queried ${result.chainsQueried.length} chain(s).`),
  ];

  const withBalance = result.balances.filter(
    (b) => b.native.amount.raw !== '0' || b.tokens.length > 0,
  );
  const empty = result.balances.filter(
    (b) => b.native.amount.raw === '0' && b.tokens.length === 0,
  );

  for (const balance of withBalance) {
    sections.push(renderBalance(balance));
  }

  if (empty.length) {
    sections.push(`\n  ${dim(`Empty on: ${empty.map((b) => b.chain).join(', ')}`)}`);
  }

  if (result.errors.length) {
    sections.push(heading('Errors'));
    for (const error of result.errors) {
      sections.push(`  ${red(error.chain)}  ${error.error}`);
      if (error.hint) sections.push(`    ${dim(error.hint)}`);
    }
  }

  sections.push(`\n  ${dim(result.note)}`);
  return sections.join('\n');
}

/**
 * An address's history.
 *
 * The completeness goes at the top rather than the bottom when it is `failed`,
 * because that is the case where the entries below are empty and a reader
 * skimming an empty list concludes "no activity" before ever reaching a
 * footnote. It is the one line that changes what the result means.
 */
export function renderHistory(history: TransactionHistory): string {
  const lines = [heading(`${history.chain}  ${shorten(history.address)}`)];

  if (history.completeness.kind === 'failed') {
    lines.push('', `  ${yellow(history.completeness.note)}`);
    return lines.join('\n');
  }

  if (!history.entries.length) {
    lines.push('', `  ${dim('No transactions.')}`, '', `  ${dim(history.completeness.note)}`);
    return lines.join('\n');
  }

  const arrow = (direction: HistoryEntry['direction']): string =>
    direction === 'in' ? '<-' : direction === 'out' ? '->' : direction === 'self' ? '<>' : '  ';

  lines.push('');
  lines.push(
    table(
      history.entries.map((entry) => [
        entry.status === 'failed' ? red(arrow(entry.direction)) : arrow(entry.direction),
        entry.timestamp ? entry.timestamp.slice(0, 19).replace('T', ' ') : dim('unconfirmed'),
        entry.value ? bold(entry.value.formatted) : '',
        entry.summary,
        dim(shorten(entry.hash)),
      ]),
    ),
  );

  lines.push('', `  ${dim(history.completeness.note)}`);

  if (history.cursor) {
    lines.push(`  ${dim(`Next page: --cursor ${history.cursor}`)}`);
  }

  return lines.join('\n');
}

export function renderTx(tx: NormalizedTx): string {
  const statusColor = tx.status === 'success' ? green : tx.status === 'failed' ? red : yellow;

  const lines = [
    heading(`${tx.chain}  ${statusColor(tx.status)}`),
    `  ${bold('Hash')}      ${tx.hash}`,
  ];

  if (tx.from) lines.push(`  ${bold('From')}      ${cyan(tx.from)}`);
  if (tx.to) lines.push(`  ${bold('To')}        ${cyan(tx.to)}`);
  if (tx.value) lines.push(`  ${bold('Value')}     ${tx.value.formatted} ${tx.value.symbol}`);
  if (tx.fee) lines.push(`  ${bold('Fee')}       ${tx.fee.formatted} ${tx.fee.symbol}`);
  if (tx.blockNumber !== undefined) lines.push(`  ${bold('Block')}     ${tx.blockNumber}`);
  if (tx.timestamp) lines.push(`  ${bold('Time')}      ${tx.timestamp}`);
  // Directly under the status it qualifies. "success" and "settled" are
  // different claims and reading one as the other is the whole hazard.
  lines.push(...renderFinality(tx.finality));

  lines.push(`\n  ${tx.summary}`);

  if (tx.decoded?.signature) {
    lines.push(`\n  ${bold('Decoded')}   ${green(tx.decoded.signature)}`);
    lines.push(...renderCall(tx.decoded, '    '));
  } else if (tx.decoded?.note) {
    lines.push(`\n  ${dim(tx.decoded.note)}`);
  }

  if (tx.events?.length) {
    lines.push(`\n  ${bold('Events')}`);
    for (const event of tx.events) {
      lines.push(
        `    ${green(event.signature ?? 'unrecognized')} ${dim(`from ${shorten(event.address)}`)}`,
      );
      if (event.note) lines.push(`      ${dim(event.note)}`);
      for (const arg of event.args ?? []) {
        const label = dim(`${arg.name ?? '?'} (${arg.type ?? '?'})`);
        lines.push(`      ${label}  ${arg.untrusted ? yellow(arg.value) : arg.value}`);
      }
    }
  }

  if (tx.memo) lines.push(`\n  ${bold('Memo')}      ${yellow(tx.memo.text)}`);
  if (tx.failureLog) lines.push(`\n  ${bold('Reverted')}  ${yellow(tx.failureLog.text)}`);

  if (tx.logs?.length) {
    lines.push(`\n  ${bold('Logs')}`);
    for (const log of tx.logs) lines.push(`    ${yellow(log.text)}`);
  }

  if (tx.memo || tx.failureLog || tx.logs?.length || carriesMarkedText(tx)) {
    lines.push(`\n  ${dim('Yellow text was written by someone on the chain, not by this tool.')}`);
  }

  if (tx.explorerUrl) lines.push(`\n  ${dim(tx.explorerUrl)}`);
  return lines.join('\n');
}

/**
 * One decoded call, and anything it carried inside it.
 *
 * A batch reported as `multicall(bytes[])` with nothing under it tells a
 * reviewer exactly what the selector already told them. The indentation is the
 * point: it is how "approve, then swap" stops looking like one opaque call.
 */
function renderCall(call: DecodedCall, indent: string): string[] {
  const lines: string[] = [];

  for (const arg of call.args ?? []) {
    // The mark has to survive the trip to a terminal too. Someone scanning
    // output cannot tell an address from a sentence a stranger wrote unless
    // something says so, and the field carrying it is no help at a terminal.
    const label = dim(`${arg.name ?? '?'} (${arg.type ?? '?'})`);
    lines.push(`${indent}${label}  ${arg.untrusted ? yellow(arg.value) : arg.value}`);
  }

  for (const candidate of call.candidates ?? []) {
    lines.push(`${indent}${dim('candidate')}  ${yellow(candidate.signature)}`);
  }

  for (const inner of call.inner ?? []) {
    const what = inner.signature ?? inner.selector ?? 'unknown';
    const where = inner.target ? dim(` -> ${shorten(inner.target)}`) : '';
    lines.push(`${indent}${green(what)}${where}`);
    if (inner.note) lines.push(`${indent}  ${dim(inner.note)}`);
    lines.push(...renderCall(inner, `${indent}  `));
  }

  return lines;
}

/** Does anything in this transaction's decode carry text somebody chose? */
function carriesMarkedText(tx: NormalizedTx): boolean {
  const inCall = (call: DecodedCall): boolean =>
    Boolean(call.args?.some((arg) => arg.untrusted)) ||
    Boolean(call.candidates?.length) ||
    Boolean(call.inner?.some(inCall));

  return (
    (tx.decoded ? inCall(tx.decoded) : false) ||
    Boolean(tx.events?.some((event) => event.args?.some((arg) => arg.untrusted)))
  );
}

/**
 * How settled a result is, coloured by whether it may be acted on.
 *
 * `final` is the only green, and `probabilistic` is deliberately not green
 * however many confirmations it carries — the colour would be this tool making
 * a risk decision that belongs to whoever is reading.
 */
export function renderFinality(
  value: Finality | undefined,
  indent = '  ',
  labelWidth = 9,
): string[] {
  if (!value) return [];

  const label: Record<Finality['kind'], string> = {
    final: green('final'),
    probabilistic: yellow(`probabilistic${value.confirmations !== undefined ? ` (${value.confirmations} conf)` : ''}`),
    reversible: yellow('reversible'),
    unknown: dim('unknown'),
  };

  return [
    `${indent}${bold(pad('Settled', labelWidth))} ${label[value.kind]}`,
    `${indent}  ${dim(value.note)}`,
  ];
}

export function renderBlock(block: NormalizedBlock): string {
  const lines = [
    heading(`${block.chain} block ${block.number}`),
    `  ${bold('Hash')}        ${block.hash}`,
    `  ${bold('Txs')}         ${block.txCount}`,
  ];
  if (block.timestamp) lines.push(`  ${bold('Time')}        ${block.timestamp}`);
  lines.push(...renderFinality(block.finality, '  ', 11));
  if (block.parentHash) lines.push(`  ${bold('Parent')}      ${dim(block.parentHash)}`);

  for (const [key, value] of Object.entries(block.raw ?? {})) {
    if (value === undefined || value === null) continue;
    lines.push(`  ${dim(key.padEnd(11))} ${String(value)}`);
  }

  if (block.explorerUrl) lines.push(`\n  ${dim(block.explorerUrl)}`);
  return lines.join('\n');
}

export function renderFees(fees: FeeEstimate): string {
  const lines = [heading(`Fees on ${fees.chain}`)];

  if (fees.simpleTransfer) {
    lines.push(
      `  ${bold('Simple transfer')}  ~${fees.simpleTransfer.formatted} ${fees.simpleTransfer.symbol}`,
    );
  }

  lines.push('');
  lines.push(table(Object.entries(fees.details).map(([k, v]) => [dim(k), v])));

  if (fees.note) lines.push(`\n  ${dim(fees.note)}`);
  return lines.join('\n');
}

export function renderUnsignedTx(tx: UnsignedTx): string {
  const lines = [
    heading(`Unsigned transaction — ${tx.chain}`),
    `  ${tx.summary}`,
    '',
    // Named for what it is rather than for the field it lives in. On Solana
    // that field is called `transaction`, which reads as "the transaction" —
    // the thing an explorer would show you — when it is the proposal, not the
    // receipt. Only one of those exists at this point.
    `  ${bold('Payload to sign — this is not a signature')}`,
    indent(JSON.stringify(tx.payload, null, 2), 4),
    '',
    `  ${bold('How to sign')}`,
    `    ${tx.signingHint}`,
    `    ${dim('Signing and sending this is what produces a signature; that is the string to keep.')}`,
  ];

  if (tx.warnings.length) {
    lines.push('', `  ${yellow(bold('Warnings'))}`);
    for (const warning of tx.warnings) lines.push(`    ${yellow('!')} ${warning}`);
  }

  lines.push('', dim('  Singularity holds no keys and has not signed or broadcast anything.'));
  return lines.join('\n');
}

function indent(text: string, spaces: number): string {
  const prefix = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line) => prefix + line)
    .join('\n');
}

function shorten(value: string): string {
  return value.length <= 20 ? value : `${value.slice(0, 10)}…${value.slice(-6)}`;
}

export function renderMintAudit(audit: MintAudit): string {
  const name = audit.metadata ? `${audit.metadata.name} (${audit.metadata.symbol})` : audit.mint;
  const lines = [heading(`Mint audit — ${name}`)];

  lines.push(
    '',
    table([
      [dim('mint'), audit.mint],
      [dim('program'), audit.program],
      [dim('supply'), `${audit.supply.formatted} ${audit.supply.symbol}`],
      [dim('decimals'), String(audit.decimals)],
      ...(audit.metadata?.uri ? [[dim('metadata'), audit.metadata.uri.text]] : []),
      ...(audit.extensions.length ? [[dim('extensions'), audit.extensions.join(', ')]] : []),
    ]),
  );

  if (audit.metadata) {
    lines.push('', `  ${dim('The name and ticker above were chosen by whoever deployed the mint.')}`);
  }

  // Powers first. Someone reading this in a terminal is deciding whether to
  // hold the thing, and what can still be done to them is the answer.
  if (audit.powers.length) {
    lines.push('', `  ${yellow(bold('Still possible'))}`);
    for (const power of audit.powers) {
      lines.push(`    ${yellow('!')} ${bold(power.kind)}  ${power.what}`);
      if (power.holder) lines.push(`        ${dim(power.holder)}`);
    }
  }

  if (audit.settled.length) {
    lines.push('', `  ${green(bold('Settled'))}`);
    for (const fact of audit.settled) lines.push(`    ${green('✓')} ${fact}`);
  }

  if (audit.impersonation) {
    lines.push('', `  ${red(bold('Impersonation'))}`, `    ${audit.impersonation.note}`);
  }

  lines.push('', `  ${dim(audit.completeness.note)}`, `  ${dim(audit.note)}`);
  if (audit.explorerUrl) lines.push(`  ${cyan(audit.explorerUrl)}`);

  return lines.join('\n');
}

export function renderBurnClaim(claim: BurnClaim & { redemption?: { redeemedAt: string } }): string {
  const { receipt } = claim;
  const lines = [heading(`Burn — ${receipt.signature.slice(0, 16)}…`)];

  lines.push(
    '',
    table([
      [dim('slot'), String(receipt.slot)],
      ...(receipt.timestamp ? [[dim('time'), receipt.timestamp]] : []),
      ...(receipt.memo ? [[dim('memo'), receipt.memo.text]] : []),
    ]),
  );

  for (const burn of receipt.burns) {
    const marker = claim.matched && claim.matched.account === burn.account ? green('✓') : ' ';
    lines.push(`  ${marker} ${burn.amount.formatted} of ${burn.mint}`);
    lines.push(`      ${dim(`burned by ${burn.owner}`)}`);
  }

  if (claim.redemption) {
    lines.push('', `  ${green(bold('Redeemed'))}  ${claim.redemption.redeemedAt}`);
  } else if (claim.redeemed) {
    lines.push('', `  ${yellow(bold('Already redeemed'))}  ${claim.redeemed.redeemedAt}`);
  }

  lines.push('', `  ${dim(receipt.note)}`);
  if (receipt.explorerUrl) lines.push(`  ${cyan(receipt.explorerUrl)}`);

  return lines.join('\n');
}

export function renderTokenIdentity(identity: TokenIdentity): string {
  const title = identity.name ? `${identity.name} (${identity.symbol})` : identity.mint;
  const lines = [heading(`Identity — ${title}`)];

  const anchored =
    identity.immutable.metadata === 'immutable' && identity.immutable.document;

  lines.push(
    '',
    table([
      [dim('mint'), identity.mint],
      [dim('metadata'), identity.immutable.metadata],
      [dim('document'), identity.immutable.document ? 'content-addressed' : 'a location'],
      ...(identity.uri ? [[dim('link'), identity.uri.text]] : []),
    ]),
    '',
    `  ${anchored ? green(identity.immutable.note) : yellow(identity.immutable.note)}`,
  );

  if (identity.impersonation) {
    lines.push('', `  ${red(bold('Impersonation'))}`, `    ${identity.impersonation.note}`);
  }

  if (identity.accounts?.length) {
    lines.push('', `  ${bold('Declared accounts')}`);
    for (const account of identity.accounts) {
      lines.push(`    ${dim(account.kind.padEnd(8))} ${account.value.text}`);
    }
  }

  if (identity.document) lines.push(`\n  ${dim(identity.document.note)}`);
  lines.push(`  ${dim(identity.completeness.note)}`, `  ${dim(identity.note)}`);
  if (identity.explorerUrl) lines.push(`  ${cyan(identity.explorerUrl)}`);

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────── watch mode

/**
 * One line per change, for a terminal somebody is leaving open.
 *
 * Watch output is read differently from every other rendering in this file. A
 * `balance` result is read once, in full, by someone who just asked for it.
 * Watch output accumulates for hours in a scrollback nobody is staring at, and
 * gets read backwards after something happened. So each line is timestamped,
 * self-contained, and short enough not to wrap — a change you have to
 * reconstruct from three wrapped lines is a change you misread at 3am.
 */
export function watchLine(at: Date, text: string): string {
  return `${dim(at.toTimeString().slice(0, 8))}  ${text}`;
}

/** `6.71259795 ETH` → `6.71259795 ETH`, with the delta when there is one. */
export function watchBalanceChange(
  current: BalanceResult,
  previous: BalanceResult | undefined,
): string {
  const symbol = current.native.token?.symbol ?? '';
  const now = current.native.amount.formatted;

  if (!previous) {
    // The first reading is not a change, and saying "→" here would claim a
    // movement that nothing observed.
    return `${bold(now)} ${symbol}  ${dim('(first reading)')}`;
  }

  const before = previous.native.amount.formatted;
  if (before === now) {
    // Reached when a token moved but the native balance did not.
    return `${dim(now)} ${symbol}  ${dim('native unchanged; a token balance moved')}`;
  }

  const rose = Number(now) > Number(before);
  const arrow = rose ? green('↑') : red('↓');
  return `${dim(before)} ${arrow} ${bold(now)} ${symbol}`;
}

/** A new chain head, and how far it moved. */
export function watchTipChange(
  current: NormalizedBlock,
  previous: NormalizedBlock | undefined,
): string {
  if (!previous) return `#${current.number}  ${dim('(first reading)')}`;

  const advanced = current.number - previous.number;

  // A height that went backwards is a reorg. It is reported rather than
  // smoothed over, because smoothing it is how a reorg becomes invisible to
  // the one tool that was watching.
  if (advanced < 0) {
    return `${red('REORG')}  #${previous.number} → #${current.number}  ${dim(`(${-advanced} back)`)}`;
  }

  return `#${current.number}  ${dim(`+${advanced}`)}`;
}

/** A transaction's progress toward the depth the caller asked for. */
export function watchTxChange(tx: NormalizedTx, target: number): string {
  const confirmations = tx.finality?.confirmations ?? 0;
  const status = tx.status === 'success' ? green(tx.status) : tx.status === 'failed' ? red(tx.status) : yellow(tx.status);

  const depth =
    tx.finality?.kind === 'final'
      ? green('final')
      : `${confirmations}/${target} ${dim('confirmations')}`;

  return `${status}  ${depth}`;
}

/** Which chains changed status, and to what. */
export function watchLivenessChange(
  current: ChainLiveness[],
  previous: ChainLiveness[] | undefined,
): string[] {
  if (!previous) {
    return current.map(
      (chain) =>
        `${chain.chain.padEnd(14)} ${chain.status}  ${dim(`${chain.answering}/${chain.configured} answering`)}`,
    );
  }

  const lines: string[] = [];

  for (const now of current) {
    const before = previous.find((c) => c.chain === now.chain);
    if (!before || before.status === now.status) continue;

    const worse = rank(now.status) > rank(before.status);
    const arrow = worse ? red('→') : green('→');
    lines.push(`${now.chain.padEnd(14)} ${dim(before.status)} ${arrow} ${bold(now.status)}`);

    // The notes explain *why* a status changed, and they are the reason a
    // human opened this terminal. Printing the status alone sends them to
    // `doctor` to ask a question this already answered.
    for (const note of now.notes) lines.push(`  ${dim(note)}`);
  }

  return lines;
}

/** How bad a status is, so a transition can be coloured by direction. */
function rank(status: ChainLiveness['status']): number {
  const order: Record<ChainLiveness['status'], number> = {
    live: 0,
    single: 1,
    undatable: 2,
    skewed: 3,
    lagging: 4,
    stale: 5,
    down: 6,
  };
  return order[status];
}

/**
 * An exit report, rendered worst-first.
 *
 * The verdict line is deliberately not a colour on its own. `canExit: true`
 * printed in green would read as "safe to buy", which is exactly the claim this
 * analysis cannot make — it reads the mint, not the market. So the headline
 * states what was actually established, and the completeness note under it
 * states what was not, in the same block, where a reader cannot take one
 * without the other.
 */
export function renderExitReport(report: TokenExitReport): string {
  const lines: string[] = [];

  const blockers = report.risks.filter((risk) => risk.severity === 'blocks');
  const controlled = report.risks.filter((risk) => risk.severity === 'discretionary');
  const degraders = report.risks.filter((risk) => risk.severity === 'degrades');

  // Two headline facts, never one. "Sellable" and "nobody can stop you" are
  // different claims, and a single green line would merge them.
  lines.push(
    report.canExit
      ? `  ${green('sellable')}      ${dim('nothing in the mint stops a sale')}`
      : `  ${red('not sellable')}  ${bold(`${blockers.length} mechanism(s) block it outright`)}`,
  );

  lines.push(
    report.underThirdPartyControl
      ? `  ${yellow('controlled')}    ${bold(`${controlled.length} named part${controlled.length === 1 ? 'y' : 'ies'} can stop you at will`)}`
      : `  ${green('uncontrolled')}  ${dim('no third party can freeze or seize it')}`,
  );

  for (const [group, mark, heading] of [
    [blockers, red('!'), red('blocks a sale outright')],
    [controlled, yellow('~'), yellow('can be stopped, by a named party, at any time')],
    [degraders, dim('-'), dim('sells, on worse terms')],
  ] as const) {
    if (group.length === 0) continue;
    lines.push('');
    lines.push(`  ${heading}`);
    for (const risk of group) {
      lines.push(`  ${mark} ${bold(risk.mechanism)}`);
      if (risk.holder) lines.push(`      ${dim('held by')} ${risk.holder}`);
      lines.push(`      ${wrap(risk.note, 72, '      ')}`);
    }
  }

  if (report.concentration) {
    const { largestPercent, topPercent, accountsCounted, largestIsPool } = report.concentration;
    lines.push('');
    lines.push(`  ${dim('supply')}  largest ${largestPercent.toFixed(1)}%, top ${accountsCounted} hold ${topPercent.toFixed(1)}%`);
    if (largestIsPool !== undefined) {
      lines.push(
        `          ${dim(largestIsPool ? 'largest holder is a recognised pool' : 'largest holder is not a recognised pool')}`,
      );
    }
  }

  lines.push('');
  lines.push(`  ${wrap(report.note, 72, '  ')}`);
  lines.push('');
  lines.push(`  ${dim(wrap(report.completeness.note, 72, '  '))}`);

  if (report.explorerUrl) lines.push(`  ${dim(report.explorerUrl)}`);

  return lines.join('\n');
}

/** Soft-wrap a sentence so a long warning stays readable in a terminal. */
function wrap(text: string, width: number, indent: string): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';

  for (const word of words) {
    if (line.length + word.length + 1 > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);

  return lines.join(`\n${indent}`);
}

// ───────────────────────────────────────────────────────────────── payments

/**
 * A freshly created payment request.
 *
 * The risk block is the part that matters and it is printed before the id, not
 * after: a merchant reading this is deciding whether to accept the token at
 * all, and that decision is worth more than the reference they will copy.
 */
export function renderIntent(created: CreatedIntent): string {
  const { intent, risk } = created;
  const lines: string[] = [];

  lines.push(`  ${dim('id')}         ${intent.id}`);
  lines.push(`  ${dim('amount')}     ${bold(intent.amount)} ${intent.mint ? dim(intent.mint) : 'SOL'}`);
  lines.push(`  ${dim('to')}         ${intent.to}`);
  if (intent.memo) lines.push(`  ${dim('memo')}       ${intent.memo}`);
  if (intent.orderId) lines.push(`  ${dim('order')}      ${intent.orderId}`);
  lines.push(`  ${dim('expires')}    ${intent.expiresAt}`);

  if (risk) {
    lines.push('');
    lines.push(
      risk.custodyIsYours
        ? `  ${green('custody is yours')}  ${dim('no third party can freeze or seize what you are paid')}`
        : `  ${yellow('custody is shared')} ${bold('a named party can freeze or take this after you are paid')}`,
    );

    for (const warning of risk.warnings) {
      lines.push(`  ${dim('-')} ${wrap(warning, 70, '    ')}`);
    }
  }

  lines.push('');
  lines.push(
    `  ${dim('Scan it, or open the link on the same device. The wallet builds and shows the')}`,
  );
  lines.push(`  ${dim('transaction; Singularity holds no keys and cannot sign it.')}`);
  lines.push('');
  lines.push(`  ${dim('Check it with')}  singularity pay status ${intent.id}`);

  return lines.join('\n');
}

/** One settlement, in full. */
export function renderSettlement(result: SettlementResult): string {
  const lines: string[] = [];

  lines.push(render(result));

  if (result.mismatches.length > 0) {
    lines.push('');
    lines.push(`  ${red('this is not your payment')}`);
    for (const mismatch of result.mismatches) {
      lines.push(`  ${red('!')} ${wrap(mismatch, 70, '    ')}`);
    }
  }

  if (result.paid) lines.push(`\n  ${dim('paid')}       ${result.paid.formatted}`);
  if (result.from) lines.push(`  ${dim('from')}       ${result.from}`);
  if (result.signature) lines.push(`  ${dim('signature')}  ${result.signature}`);
  if (result.at) lines.push(`  ${dim('at')}         ${result.at}`);

  lines.push('');
  lines.push(`  ${wrap(result.note, 70, '  ')}`);

  return lines.join('\n');

  function render(value: SettlementResult): string {
    // Two facts, because "settled" and "act on it" are different questions and
    // a merchant polling in a loop needs the second one.
    const level =
      value.level === 'final'
        ? green('final')
        : value.level === 'probabilistic'
          ? yellow('confirmed, not final')
          : value.level === 'pending'
            ? yellow('pending')
            : dim('unpaid');

    const action = value.fulfil
      ? `  ${green('FULFIL NOW')}  ${bold('this is the one call that should ship the order')}`
      : value.alreadyFulfilled
        ? `  ${dim('already fulfilled')}  ${dim(value.alreadyFulfilled.at)}`
        : `  ${dim('do not fulfil')}`;

    return `  ${dim('settlement')} ${level}\n${action}`;
  }
}

/** One line per change, for `pay status --watch`. */
export function renderSettlementLine(result: SettlementResult): string {
  if (result.fulfil) return `${green('paid')}  ${bold('fulfil now')}  ${result.signature ?? ''}`;
  if (result.mismatches.length > 0) return `${red('mismatch')}  ${result.mismatches[0]}`;
  return `${dim(result.level)}  ${dim(result.note.slice(0, 80))}`;
}

/** A table of requests, worst-news-first within each row. */
export function renderIntentList(intents: StoredIntent[]): string {
  const rows = intents.map((intent) => [
    intent.settledAt ? green('paid') : new Date(intent.expiresAt) < new Date() ? dim('expired') : yellow('open'),
    intent.id.slice(0, 12),
    `${intent.amount} ${intent.mint ? shortAddress(intent.mint) : 'SOL'}`,
    shortAddress(intent.to),
    intent.orderId ?? dim('—'),
  ]);

  return table(rows, ['', 'id', 'amount', 'to', 'order']);
}
