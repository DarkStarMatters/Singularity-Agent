/**
 * Plain-text rendering for elizaOS surfaces.
 *
 * The formatters in `src/telegram/format.ts` are the single place chain data is
 * turned into prose, and duplicating them for Eliza would guarantee the two
 * drift. Instead the HTML they emit is downgraded to plain text here.
 *
 * This is safe only because of the two invariants those formatters hold (see
 * their header): every tag opens and closes on the same line, and every
 * interpolated value is entity-escaped. So a tag strip cannot swallow content,
 * and unescaping afterwards restores exactly the original characters —
 * including a scam token literally named `<b>`.
 */

/** `<a href="https://…">label</a>` — kept as a capture so the URL survives. */
const ANCHOR = /<a href="([^"]*)">([\s\S]*?)<\/a>/g;
const TAG = /<\/?[A-Za-z][^>]*>/g;

/**
 * Entities must be decoded after tags are stripped, never before: decoding
 * first would turn an escaped `&lt;b&gt;` in a token symbol back into a real
 * tag that the strip then eats.
 */
function unescapeEntities(value: string): string {
  return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

export function toPlainText(html: string): string {
  const withLinks = html.replace(ANCHOR, (_match, url: string, label: string) =>
    // A bare URL as its own label reads as "https://… (https://…)" otherwise.
    label.trim() === url.trim() ? label : `${label} (${url})`,
  );

  return unescapeEntities(withLinks.replace(TAG, ''));
}
