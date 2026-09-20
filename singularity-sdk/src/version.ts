/**
 * The SDK's own version, which is not the agent's.
 *
 * Two numbers in one repository, on purpose. The agent is at v0.2.0 with ten
 * releases behind it; this package is at v0.1.0 with one. Giving them a single
 * version would make the SDK look nine releases more settled than it is, which
 * is a claim about stability that nobody made.
 *
 * Leaving 0.0.x now rather than later is itself a statement: the SDK gained a
 * payment surface, artwork and receipts in this release, and a package with
 * that much API answering to a patch number misleads whoever reads the
 * registry. It is still pre-1.0, which is the part that has not changed.
 *
 * `test/version.test.ts` holds this against `package.json` and the README the
 * same way the agent's does — the lesson there transfers, and so does the test.
 */
export const SDK_VERSION = '0.1.0';
