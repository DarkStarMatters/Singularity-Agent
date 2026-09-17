/**
 * The one place the running code reads its version from.
 *
 * Kept in step by hand with the four places that also carry it and cannot import
 * it: `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`
 * and the whitepaper's header line. A bump that misses one ships a plugin manifest
 * claiming a version the tool does not report.
 */
export const VERSION = '0.0.7';
