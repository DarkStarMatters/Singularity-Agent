import type {
  DecodedCall,
  FeeEstimate,
  NormalizedBlock,
  NormalizedTx,
  ResolvedIdentity,
  UnsignedTx,
} from '../core/types.js';
import type { BalanceResult, ChainSummary, PortfolioResult } from '../tools/operations.js';

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
          bold(t.amount.formatted),
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

export function renderBlock(block: NormalizedBlock): string {
  const lines = [
    heading(`${block.chain} block ${block.number}`),
    `  ${bold('Hash')}        ${block.hash}`,
    `  ${bold('Txs')}         ${block.txCount}`,
  ];
  if (block.timestamp) lines.push(`  ${bold('Time')}        ${block.timestamp}`);
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
    `  ${bold('Payload')}`,
    indent(JSON.stringify(tx.payload, null, 2), 4),
    '',
    `  ${bold('How to sign')}`,
    `    ${tx.signingHint}`,
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
