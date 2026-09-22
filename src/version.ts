/**
 * The one place the running code reads its version from.
 *
 * Four other files carry it and cannot import it: `package.json`,
 * `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` and the
 * whitepaper's header line. This used to say they were kept in step by hand,
 * which is the kind of guarantee this repository keeps learning not to write
 * down. `test/version.test.ts` holds all five together now, and the roadmap to
 * having an entry for whatever number this is.
 */
export const VERSION = '0.4.0';
