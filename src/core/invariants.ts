/**
 * The claims this project makes about its own answers, as code.
 *
 * Five times a result was correct about what it did and wrong about what it
 * claimed: a list cut without saying so, failed reads that came back as `[]`,
 * a hash "not found" on chains that never answered, and two more. None crashed
 * or failed a type check, and a person noticed every one. The roadmap's
 * conclusion was that review does not catch this class, so the claims cannot
 * live only in prose and in the one example test written after each bug.
 *
 * Each claim here is a function that returns violations instead of throwing,
 * so one run can report all of them. There are two kinds:
 *
 * - **Shape checks** (`checkShape`) need nothing but the output. They walk any
 *   value a tool returns and check what every response must hold: a truncated
 *   completeness has its counts, a caveat is not empty, an unsigned payload
 *   says so, a total adds up in one unit.
 * - **Relational checks** compare the output with what the adapters actually
 *   did: which reads failed, which chains answered, how much there was. Only a
 *   caller that knows that can run them, which is why
 *   `test/invariants.property.test.ts` drives every adapter-routed tool through
 *   adapters whose every behaviour it records.
 *
 * A new adapter or a new tool inherits these checks by existing. They are also
 * exported, so an application can run the shape checks on what it receives.
 */
import type { Completeness, CompletenessKind } from './envelope.js';

export type InvariantId =
  | 'cut-says-so'
  | 'failure-is-not-empty'
  | 'searched-means-answered'
  | 'totals-share-units'
  | 'absence-needs-completeness'
  | 'unsigned-says-so';

/** The six claims, in the words the roadmap states them (Phase 7.2). */
export const INVARIANTS: Record<InvariantId, string> = {
  'cut-says-so': 'A list that was cut says so, with both counts.',
  'failure-is-not-empty': 'A failed read never becomes an empty result.',
  'searched-means-answered': 'A chain is never reported as searched unless it answered.',
  'totals-share-units': 'A total exists only where the units are identical.',
  'absence-needs-completeness': 'An absence is never reported as fact without a `completeness` that supports it.',
  'unsigned-says-so': 'Every unsigned payload states that it is unsigned.',
};

export interface Violation {
  invariant: InvariantId;
  /** Where in the output, as a dotted path from the root (`$`). */
  path: string;
  detail: string;
}

const KINDS: readonly CompletenessKind[] = ['exhaustive', 'curated', 'truncated', 'failed'];

/** Stronger claims rank lower. A combined answer may never rank below a part. */
const RANK: Record<CompletenessKind, number> = { exhaustive: 0, curated: 1, truncated: 2, failed: 3 };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isCompleteness(value: unknown): value is Completeness {
  return isRecord(value) && KINDS.includes(value.kind as CompletenessKind) && 'note' in value;
}

const isCount = (value: unknown, min: number): boolean =>
  typeof value === 'number' && Number.isInteger(value) && value >= min;

// ---- Shape checks ---------------------------------------------------------

/**
 * Everything any response must hold, checked anywhere it appears in the value.
 *
 * Walks the whole output rather than known fields, because the bug class is
 * code that put the right thing in a place nobody thought to look.
 */
export function checkShape(value: unknown): Violation[] {
  const violations: Violation[] = [];
  walk(value, '$', violations, new Set());
  return violations;
}

function walk(value: unknown, path: string, out: Violation[], seen: Set<unknown>): void {
  if (typeof value !== 'object' || value === null || seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, `${path}[${index}]`, out, seen));
    return;
  }

  const record = value as Record<string, unknown>;
  if (isCompleteness(record)) checkCompleteness(record, path, out);
  if ('signingHint' in record && 'payload' in record) checkUnsigned(record, path, out);
  if ('chain' in record && 'total' in record && Array.isArray(record.addresses)) checkTotal(record, path, out);

  for (const [key, child] of Object.entries(record)) walk(child, `${path}.${key}`, out, seen);
}

function checkCompleteness(value: Completeness, path: string, out: Violation[]): void {
  if (typeof value.note !== 'string' || !value.note.trim()) {
    out.push({
      invariant: 'absence-needs-completeness',
      path,
      detail: `A \`${value.kind}\` completeness with an empty note: a caveat nobody can read is not a caveat.`,
    });
  }

  if (value.kind !== 'truncated') return;

  if (!isCount(value.shown, 0)) {
    out.push({ invariant: 'cut-says-so', path, detail: `A truncated list without a count of what it shows (shown: ${String(value.shown)}).` });
  }
  // `omitted` may be absent for a page of an unknown total (`completeness.paged`),
  // but a count that is present has to be one: zero omitted is not a cut.
  if (value.omitted !== undefined && !isCount(value.omitted, 1)) {
    out.push({ invariant: 'cut-says-so', path, detail: `A truncated list that omitted ${String(value.omitted)}, which is not a cut.` });
  }
}

function checkUnsigned(value: Record<string, unknown>, path: string, out: Violation[]): void {
  if (value.unsigned !== true) {
    out.push({
      invariant: 'unsigned-says-so',
      path,
      detail: 'A transaction payload without `unsigned: true`. Whether it is signed has to be a field, not something to infer from a hint.',
    });
  }
}

function checkTotal(value: Record<string, unknown>, path: string, out: Violation[]): void {
  const total = value.total as { raw?: unknown; decimals?: unknown; symbol?: unknown } | undefined;
  const parts = value.addresses as Array<{ amount?: { raw?: unknown; decimals?: unknown; symbol?: unknown } }>;
  if (!isRecord(total)) return;

  let sum = 0n;
  for (const [index, part] of parts.entries()) {
    const amount = part.amount;
    if (!isRecord(amount)) continue;
    if (amount.decimals !== total.decimals || amount.symbol !== total.symbol) {
      out.push({
        invariant: 'totals-share-units',
        path: `${path}.addresses[${index}]`,
        detail: `Summed ${String(amount.symbol)} at ${String(amount.decimals)} decimals into a total of ${String(total.symbol)} at ${String(total.decimals)}.`,
      });
    }
    try {
      sum += BigInt(String(amount.raw));
    } catch {
      out.push({ invariant: 'totals-share-units', path: `${path}.addresses[${index}]`, detail: `An amount whose raw value is not an integer: ${String(amount.raw)}.` });
    }
  }

  if (parts.length && String(sum) !== String(total.raw)) {
    out.push({ invariant: 'totals-share-units', path, detail: `The total says ${String(total.raw)} and its parts add up to ${sum}.` });
  }
}

// ---- Relational checks ----------------------------------------------------

/**
 * A result whose source read failed must say it failed.
 *
 * `[]` with anything but `failed` beside it reads as "there is nothing", and
 * when the read failed nobody knows that. This is violation two: an EVM
 * historical scan whose failures came back as an empty list.
 */
export function checkFailedRead(
  readFailed: boolean,
  entries: readonly unknown[],
  reported: Completeness,
  path = '$',
): Violation[] {
  if (!readFailed || reported.kind === 'failed') return [];
  return [
    {
      invariant: 'failure-is-not-empty',
      path,
      detail: `The read failed and the result says \`${reported.kind}\` with ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}.`,
    },
  ];
}

/**
 * A list shorter than its source says how much shorter.
 *
 * Violation one: Solana dust accounts dropped from a balance list that still
 * read as the whole wallet.
 */
export function checkCut(
  available: number,
  returned: number,
  reported: Completeness,
  path = '$',
): Violation[] {
  if (returned >= available || reported.kind === 'failed') return [];
  if (reported.kind !== 'truncated') {
    return [{ invariant: 'cut-says-so', path, detail: `${returned} of ${available} returned, under a \`${reported.kind}\` completeness.` }];
  }
  const violations: Violation[] = [];
  if (reported.shown !== returned) {
    violations.push({ invariant: 'cut-says-so', path, detail: `Says it shows ${String(reported.shown)}; it shows ${returned}.` });
  }
  if (reported.omitted !== undefined && reported.omitted !== available - returned) {
    violations.push({ invariant: 'cut-says-so', path, detail: `Says it omitted ${reported.omitted}; it omitted ${available - returned}.` });
  }
  return violations;
}

/**
 * Passing a result along never strengthens what it claims.
 *
 * A layer that wraps an adapter's `curated` scan may weaken it, never report it
 * as `exhaustive`. A combined answer is no stronger than its weakest part.
 */
export function checkNotStronger(parts: readonly Completeness[], reported: Completeness, path = '$'): Violation[] {
  const weakest = parts.reduce<CompletenessKind | null>(
    (worst, part) => (worst === null || RANK[part.kind] > RANK[worst] ? part.kind : worst),
    null,
  );
  if (weakest === null || RANK[reported.kind] >= RANK[weakest]) return [];
  return [
    {
      invariant: 'absence-needs-completeness',
      path,
      detail: `Reports \`${reported.kind}\` over a part that was only \`${weakest}\`.`,
    },
  ];
}

/** What each chain actually did when it was asked. */
export interface SearchRecord {
  /** Chains that answered: found it, or said it was not there. */
  answered: readonly string[];
  /** Chains whose read failed. Nothing was learned on these. */
  failed: readonly string[];
}

/**
 * A chain is searched only if it answered, and a failed chain is never dropped.
 *
 * Violation four: `getTransaction` dropped the rejected chains, then reported
 * the hash "not found on any of" every chain it had asked.
 */
export function checkSearched(
  record: SearchRecord,
  result: { searched: readonly string[]; unreachable?: ReadonlyArray<{ chain: string }> },
  path = '$',
): Violation[] {
  const violations: Violation[] = [];
  for (const chain of result.searched) {
    if (!record.answered.includes(chain)) {
      violations.push({ invariant: 'searched-means-answered', path: `${path}.searched`, detail: `${chain} is listed as searched and never answered.` });
    }
  }
  const reported = new Set((result.unreachable ?? []).map((u) => u.chain));
  for (const chain of record.failed) {
    if (!reported.has(chain)) {
      violations.push({ invariant: 'searched-means-answered', path: `${path}.unreachable`, detail: `${chain} failed and is not reported as unreachable.` });
    }
  }
  return violations;
}

/**
 * "Not found" is a claim about the chains named in it, all of which answered.
 *
 * Takes the message of a `TX_NOT_FOUND` error, whose list follows "any of:".
 * With nothing answered there is no absence to report at all, and the right
 * error is a different one.
 */
export function checkNotFoundClaim(record: SearchRecord, message: string, path = '$'): Violation[] {
  if (!record.answered.length) {
    return [{ invariant: 'searched-means-answered', path, detail: 'Reported not found when no chain answered, so there was no evidence either way.' }];
  }
  const named = /any of: ([^.]+)\./.exec(message)?.[1]?.split(',').map((s) => s.trim()) ?? [];
  return named
    .filter((chain) => !record.answered.includes(chain))
    .map((chain) => ({ invariant: 'searched-means-answered' as const, path, detail: `Not found on ${chain}, which never answered.` }));
}
