/**
 * The last check before the agent says something in public.
 *
 * A wrong answer in a terminal is a wrong answer. A wrong answer posted to X is
 * permanent, public, and attributed to whoever runs this. So the same rule the
 * approval flow applies to publishing — never report a post as published when it
 * was not — applies here to the data: **never assert completeness the evidence
 * does not support.**
 *
 * The specific sentence this exists to stop is "that wallet is empty," composed
 * from a curated nine-token scan of a chain with no indexer. The model is told
 * about the caveat, and usually honours it. Usually is not a guarantee, and a
 * guarantee is the whole product.
 *
 * Note what this deliberately does *not* do. It does not judge whether the
 * answer is correct, or good, or on-topic. It checks one thing, mechanically:
 * whether the reply claims something is absent while the evidence behind it only
 * ever looked at a subset. Everything else is the model's job.
 */
import { supportsAbsenceClaim, type Completeness } from '../core/envelope.js';
import { weakest } from '../core/envelope.js';
import type { ToolRun } from '../grok/tools.js';

/** What the tool calls behind a reply collectively support. */
export interface Evidence {
  /** The weakest completeness across every tool result, or null if none said. */
  completeness: Completeness | null;
  /** Any result carried text authored on-chain. */
  untrusted: boolean;
}

export function evidenceFrom(runs: ToolRun[]): Evidence {
  const found = runs
    .map((run) => run.completeness)
    .filter((value): value is Completeness => Boolean(value));

  return {
    completeness: weakest(found),
    untrusted: runs.some((run) => run.untrusted),
  };
}

/**
 * Claims that something is not there.
 *
 * Only absence claims are checked, because absence is the only thing a partial
 * scan can get *categorically* wrong. If the scan found 5 USDC, 5 USDC is
 * there — a curated list is incomplete, not inaccurate. It is the leap from
 * "found nothing" to "there is nothing" that the data cannot support, and that
 * leap always reads as one of these.
 *
 * The one carve-out is custody: "holds no keys" is this project's single most
 * repeated sentence, it is about the tool rather than a wallet, and no token
 * scan has any bearing on whether it is true.
 */
const ABSENCE_CLAIM =
  /\b(?:holds? (?:no|nothing|none)(?! (?:keys?|seed|seeds|secrets?|custody))|has (?:no|nothing|none)\b|no tokens?\b|no holdings?\b|nothing (?:in|at|there|held)|is empty|are empty|wallet is empty|empty wallet|zero (?:tokens?|holdings?|balance)|doesn'?t hold|does not hold|isn'?t holding|no other tokens?|only (?:holds?|has))/i;

/**
 * Claims the list is the whole list.
 *
 * The subtler cousin: not "there is nothing" but "this is everything". Same
 * failure, and a truncated scan is the case that produces it.
 */
const TOTALITY_CLAIM =
  /\b(?:all (?:of )?(?:its|their|your|the) (?:tokens?|holdings?|assets?)|every token|entire portfolio|complete (?:list|picture)|full holdings?|that'?s everything|in total across)/i;

export type ReviewVerdict =
  | { publish: true; text: string; caveated: boolean }
  | { publish: false; reason: string };

/**
 * Decide whether a composed reply may go out as written.
 *
 * Where the claim is unsupported but the caveat fits in the remaining
 * characters, the caveat is appended rather than the reply dropped — going
 * silent on someone who asked a real question is its own failure, and the one
 * the X filter was just fixed for. Only when the truth will not fit does the
 * reply get held back.
 */
export function reviewReply(text: string, evidence: Evidence, limit: number): ReviewVerdict {
  // Match against straight apostrophes only. Models and people both write
  // curly ones constantly, and "doesn’t hold any" slipping past a pattern
  // spelled with ' is exactly the kind of near-miss this gate cannot afford.
  const normalized = text.replace(/[\u2018\u2019]/g, "'");
  const claim = ABSENCE_CLAIM.test(normalized) || TOTALITY_CLAIM.test(normalized);

  // Nothing was claimed about absence or totality, or the evidence is good
  // enough to claim it. Either way there is nothing here to catch.
  if (!claim || supportsAbsenceClaim(evidence.completeness)) {
    return { publish: true, text, caveated: false };
  }

  const completeness = evidence.completeness;
  if (!completeness) {
    // An absence claim with no enumerable evidence behind it at all. The model
    // is talking about something this gate has no view of — a question about
    // the project, say — so there is nothing to check it against.
    return { publish: true, text, caveated: false };
  }

  const caveat = caveatFor(completeness);
  const separator = /[.!?…]$/.test(text.trim()) ? ' ' : '. ';
  const combined = `${text.trim()}${separator}${caveat}`;

  if (combined.length <= limit) return { publish: true, text: combined, caveated: true };

  return {
    publish: false,
    reason: `The reply claims something is absent, but the scan behind it was ${completeness.kind} (${completeness.note}) — and the correction does not fit in ${limit} characters.`,
  };
}

/** The shortest honest sentence that repairs each kind of overclaim. */
function caveatFor(completeness: Completeness): string {
  switch (completeness.kind) {
    case 'curated':
      return 'Caveat: that was a scan of major tokens only, not a full enumeration.';
    case 'truncated':
      return `Caveat: ${completeness.omitted ?? 'some'} more were held than shown.`;
    case 'failed':
      return 'Caveat: the token scan failed, so this is not evidence of an empty wallet.';
    default:
      return 'Caveat: that scan was not exhaustive.';
  }
}
