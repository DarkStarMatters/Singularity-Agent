/**
 * The SDK's own version, which is not the agent's.
 *
 * Two numbers in one repository, on purpose. The agent is at v0.1.0 with nine
 * releases behind it; this package is at v0.0.1 and has shipped nothing. Giving
 * them one version would make the SDK look nine releases more settled than it
 * is, which is a claim about stability that nobody made.
 *
 * `test/version.test.ts` holds this against `package.json` and the README the
 * same way the agent's does — the lesson there transfers, and so does the test.
 */
export const SDK_VERSION = '0.0.1';
