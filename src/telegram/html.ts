/**
 * Making model output safe for Telegram's HTML parse mode.
 *
 * The formatters in `format.ts` produce HTML we wrote and can trust. This file
 * handles the other case: prose written by Grok, which may contain a stray `<`,
 * an unclosed `<b>`, a tag we never allowed, or a `javascript:` link.
 *
 * Telegram rejects the *entire message* with a 400 for malformed HTML, so the
 * failure mode of getting this wrong is not ugly formatting — it is the user
 * getting no reply at all. Hence the fallback: if the whitelisted markup does
 * not come out perfectly balanced, the whole reply is sent as escaped plain
 * text instead. Losing the bold is better than losing the answer.
 */

/** Telegram supports more, but these are the four the model is told to use. */
const ALLOWED_TAGS = ['b', 'i', 'code', 'a'] as const;

function escapeAll(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Only http(s). A `javascript:` or `data:` href is dropped, link text kept. */
function safeHref(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

/**
 * Checks that the restored tags nest correctly — `<b><i>x</i></b>`, never
 * `<b><i>x</b></i>`, which Telegram also rejects.
 */
function isBalanced(html: string): boolean {
  const stack: string[] = [];
  const tag = /<(\/?)(b|i|code|a)(?: [^>]*)?>/g;

  for (let match = tag.exec(html); match; match = tag.exec(html)) {
    const [, closing, name] = match;
    if (closing) {
      if (stack.pop() !== name) return false;
    } else {
      stack.push(name!);
    }
  }
  return stack.length === 0;
}

export function sanitizeModelHtml(text: string): string {
  const escaped = escapeAll(text);

  // Put back only the whitelisted tags, from their escaped forms.
  const opens = ALLOWED_TAGS.filter((t) => t !== 'a').join('|');
  let restored = escaped
    .replace(new RegExp(`&lt;(${opens})&gt;`, 'gi'), (_m, name: string) => `<${name.toLowerCase()}>`)
    .replace(
      new RegExp(`&lt;/(${opens}|a)&gt;`, 'gi'),
      (_m, name: string) => `</${name.toLowerCase()}>`,
    );

  restored = restored.replace(
    /&lt;a href=(?:&quot;|")([^"&]*)(?:&quot;|")&gt;/gi,
    (match, rawHref: string) => {
      // The href was escaped along with everything else; undo that to parse it.
      const href = safeHref(rawHref.replace(/&amp;/g, '&'));
      return href ? `<a href="${href.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">` : match;
    },
  );

  // An `<a>` that never got a valid href leaves a dangling `</a>` behind.
  return isBalanced(restored) ? restored : escaped;
}
