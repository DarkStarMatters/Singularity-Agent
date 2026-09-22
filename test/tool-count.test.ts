import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { TOOLS } from '../src/tools/catalog.js';

/**
 * How many tools there are is written in prose, in four places, in two spellings.
 *
 * `inspect_payment` and `build_payment` were added and every one of those places
 * kept saying eighteen. Nothing failed: the README, the HTTP server's own header
 * comment, the site's drawer heading and the demo terminal's banner all
 * type-check with a wrong number in them, and the site's tools table quietly
 * listed eighteen rows for twenty tools — so the two newest tools, the ones most
 * worth telling somebody about, were the two a visitor could not find.
 *
 * This is the same failure the top of the roadmap is about, in its mildest form:
 * a fact that lives in prose, duplicated, with nothing holding the copies
 * together. The count is derived from the catalogue here so the next tool cannot
 * be added without either updating the copy or turning this red.
 *
 * `docs/` and `announce-*.md` are deliberately not checked. Those are records of
 * what was true on a date, and a report that rewrote itself to stay current
 * would be worth less than one that is allowed to age.
 */

const ROOT = resolve(__dirname, '..');

const WORDS = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen', 'twenty', 'twenty-one', 'twenty-two',
  'twenty-three', 'twenty-four', 'twenty-five',
];

function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

/**
 * Every "<number> tools" claim in a file, normalised to a count.
 *
 * Not every such phrase is a claim about *us*: `api/mcp.ts` describes another
 * server advertising eleven tools, and holding that to our number would be
 * nonsense. A line carrying `tool-count:ignore`, or the line after one, is
 * skipped — an explicit, greppable opt-out rather than a regex clever enough to
 * guess which counts are ours.
 */
function claims(source: string): number[] {
  const found: number[] = [];
  const lines = source.split('\n');

  lines.forEach((line, index) => {
    if (line.includes('tool-count:ignore')) return;
    if (index > 0 && lines[index - 1].includes('tool-count:ignore')) return;

    for (const match of line.matchAll(/([A-Za-z-]+|\d+) tools\b/g)) {
      const token = match[1].toLowerCase();
      const word = WORDS.indexOf(token);
      if (word >= 0) found.push(word);
      else if (/^\d+$/.test(token)) found.push(Number(token));
      // Anything else ("the tools", "eighteen-odd tools") is not a count.
    }
  });

  return found;
}

describe('the number of tools, everywhere it is written down', () => {
  const count = TOOLS.length;

  it('is a plausible count at all', () => {
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(WORDS.length);
  });

  for (const file of ['README.md', 'api/mcp.ts', 'web/index.html']) {
    it(`is what ${file} says it is`, () => {
      const found = claims(read(file));
      expect(found.length, `${file} no longer states a tool count — if that is deliberate, drop it from this list`).toBeGreaterThan(0);
      for (const stated of found) {
        expect(stated, `${file} says ${stated} tools; the catalogue has ${count}`).toBe(count);
      }
    });
  }

  /**
   * The README's own table, which had quietly fallen four tools behind.
   *
   * The site's table was already held row-for-row here and the README's was
   * not, so `chain_liveness`, `inspect_payment`, `build_payment` and
   * `receipt_art` shipped, were documented everywhere else, and were missing
   * from the first place anybody looks. The count line above it stayed right
   * the whole time, which is what made it invisible.
   */
  it('is how many rows the README lists, naming the same tools', () => {
    const readme = read('README.md');
    const section = readme.slice(readme.indexOf('## MCP tools'));
    const table = section.slice(0, section.indexOf('\nEvery tool is annotated'));

    const listed = [...table.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]!);

    expect(new Set(listed).size, 'the README lists the same tool twice').toBe(listed.length);
    expect([...listed].sort()).toEqual([...TOOLS.map((tool) => tool.name)].sort());
  });

  it('is how many rows the site lists, naming the same tools', () => {
    // The heading can be right while the table is short, which is what happened.
    const html = read('web/index.html');
    const drawer = html.slice(html.indexOf('data-drawer="tools"'));
    const table = drawer.slice(0, drawer.indexOf('</table>'));

    const listed = [...table.matchAll(/<tr><td><code>([a-z_]+)<\/code><\/td>/g)].map((m) => m[1]);

    expect(new Set(listed).size, 'the site lists the same tool twice').toBe(listed.length);
    expect([...listed].sort()).toEqual([...TOOLS.map((tool) => tool.name)].sort());
  });
});
