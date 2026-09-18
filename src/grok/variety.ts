/**
 * Stopping the agent from saying the same thing the same way.
 *
 * The scheduled poster already rotates subjects and angles, so it does not
 * repeat itself. Conversation had none of that: `respond` starts every thread
 * cold with an identical system prompt, so two people asking similar questions
 * a week apart get near-identical sentences, and one person watching the
 * account sees a bot with four replies in it. Nothing in the loop knew what had
 * already been said out loud.
 *
 * This is that memory. It holds the last N replies actually sent, tells the
 * model about them before it writes, and checks the draft afterwards — because
 * an instruction not to repeat is a request, and a check is an answer.
 *
 * **The caveats are allowed to repeat, and that is deliberate.** A completeness
 * note is a required disclosure, not a stylistic choice: "EVM token coverage is
 * a curated list" has to be said every time it is true, and an agent that varied
 * it for freshness would be trading honesty for texture. So the thresholds here
 * are set high enough that two replies sharing a caveat do not collide on that
 * alone, and the retry instruction says in as many words to keep the disclosure
 * and vary everything else. Variety is a property of the prose around the
 * facts, never of the facts or the warnings.
 */

/**
 * Words too common to carry a voice.
 *
 * Without this, any two English sentences overlap enough to look alike, and the
 * check fires on everything — which is the same as not having it.
 */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'do', 'does',
  'for', 'from', 'has', 'have', 'how', 'i', 'in', 'is', 'it', 'its',
  'of', 'on', 'or', 'so', 'that', 'the', 'their', 'them', 'then',
  'there', 'these', 'they', 'this', 'to', 'was', 'were', 'what', 'when',
  'which', 'who', 'will', 'with', 'you', 'your',
]);

/**
 * A word, or a number that may carry a decimal point.
 *
 * Matching tokens directly beats stripping punctuation and splitting: the only
 * punctuation worth keeping is the point inside a figure, and a strip-then-split
 * pass needs a placeholder to protect it. Placeholders in a text pipeline are
 * how a control character ends up living in a source file.
 */
const TOKEN = /[a-z]+|\d+(?:[.,]\d+)*/g;

/**
 * Lowercase, drop URLs and punctuation, keep the figures intact.
 *
 * "4.2" survives as one token because it is one number, and two balance replies
 * differing only in the figure are genuinely different answers — collapse them
 * to "4" and "2" and the second one looks like a repeat of the first.
 */
export function normalize(text: string): string {
  const cleaned = text.toLowerCase().replace(/https?:\/\/\S+/g, ' ');
  return (cleaned.match(TOKEN) ?? []).join(' ');
}

/**
 * The words that make this reply this reply.
 *
 * Numbers are kept. Two balance answers differing only in the figure are
 * genuinely different answers, and stripping the digits would collapse them
 * into the same sentence and suppress the second one.
 */
export function contentTokens(text: string): string[] {
  return normalize(text)
    .split(' ')
    .filter((word) => {
      if (!word) return false;
      // A bare digit is a real token; a bare letter is noise.
      if (/\d/.test(word)) return true;
      return word.length > 1 && !STOPWORDS.has(word);
    });
}

/** Overlap of content words, 0 to 1. */
export function similarity(a: string, b: string): number {
  const left = new Set(contentTokens(a));
  const right = new Set(contentTokens(b));
  if (!left.size || !right.size) return 0;

  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;

  return shared / (left.size + right.size - shared);
}

/**
 * The first few content words, which is what a reader actually recognizes.
 *
 * Openings repeat far more visibly than bodies. "Short answer, no" twice in a
 * row reads as a script even when everything after it differs, so this is
 * checked separately and on a tighter threshold than overall overlap.
 */
export function opening(text: string, words = 3): string {
  return contentTokens(text).slice(0, words).join(' ');
}

export interface Collision {
  repeats: boolean;
  /** Which stored reply it collided with. Absent when nothing collided. */
  against?: string;
  /** 'opening' or 'overlap' — they need different advice to fix. */
  kind?: 'opening' | 'overlap';
  score?: number;
}

/** Overlap above this counts as the same reply reworded. */
export const OVERLAP_LIMIT = 0.62;

/**
 * Replies shorter than this are exempt.
 *
 * Six content words, not eight: a typical chat reply is one or two sentences,
 * and a floor set above that exempts exactly the replies most likely to be
 * formulaic.
 *
 * "No, it cannot sign." is the correct answer to a question that gets asked
 * constantly, and there is no obligation to find a fresh way to say it. Forcing
 * variety onto a short factual denial produces worse answers, not better ones.
 */
export const MIN_TOKENS_TO_JUDGE = 6;

export class RecentVoice {
  private readonly said: string[] = [];

  constructor(private readonly limit = 12) {}

  /** Newest first. */
  recent(count = this.limit): string[] {
    return this.said.slice(0, count);
  }

  remember(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;

    this.said.unshift(trimmed);
    if (this.said.length > this.limit) this.said.length = this.limit;
  }

  forget(): void {
    this.said.length = 0;
  }

  /** Does this draft repeat something already said? */
  collides(candidate: string): Collision {
    const tokens = contentTokens(candidate);
    if (tokens.length < MIN_TOKENS_TO_JUDGE) return { repeats: false };

    const head = opening(candidate);

    for (const previous of this.said) {
      if (contentTokens(previous).length < MIN_TOKENS_TO_JUDGE) continue;

      if (head && opening(previous) === head) {
        return { repeats: true, against: previous, kind: 'opening' };
      }

      const score = similarity(candidate, previous);
      if (score >= OVERLAP_LIMIT) {
        return { repeats: true, against: previous, kind: 'overlap', score };
      }
    }

    return { repeats: false };
  }
}

/**
 * What the model is told before it writes.
 *
 * Given to it up front because a first draft that does not repeat costs one
 * request, and catching a repeat afterwards costs two.
 */
export function varietyNote(recent: string[]): string[] {
  if (!recent.length) return [];

  return [
    '',
    'You have recently said the following. Do not reuse their opening words, their sentence shape, or their phrasing:',
    ...recent.map((line) => `  - ${line}`),
    'Say the same true things differently. Required caveats and completeness notes stay exactly as they are — vary the prose around them, never the disclosure itself.',
  ];
}

/** The nudge after a draft came back too close to something already said. */
export function retryNote(collision: Collision): string {
  const shared =
    collision.kind === 'opening'
      ? 'It opens with the same words as a reply you already sent.'
      : 'It is the same reply reworded.';

  return [
    `That draft repeats you. ${shared}`,
    collision.against ? `The one it repeats: "${collision.against}"` : '',
    'Write it again. Same facts, same caveats, different sentences — start somewhere else and do not reach for the phrasing you just used.',
  ]
    .filter(Boolean)
    .join(' ');
}
