/**
 * The SDK's own version, which is not the agent's.
 *
 * Two numbers in one repository, on purpose. The agent is at v0.5.0 with twelve
 * releases behind it; this package is at v0.2.0 with two. Giving them a single
 * version would make the SDK look ten releases more settled than it is, which
 * is a claim about stability that nobody made.
 *
 * That first sentence went stale the moment the agent shipped v0.4.0 and
 * nothing noticed, which is this repository's oldest failure in its smallest
 * form: a fact living in prose, duplicated, with nothing holding the copies
 * together. `test/version.test.ts` in the root package holds it now.
 *
 * The minor bump rather than a patch is the same argument as last time:
 * `portfolio` widened from one address to a set, and an API that grew a new
 * shape answering to a patch number misleads whoever reads the registry. The
 * change is additive — `address` still works — so nothing published against
 * v0.1.0 breaks. It is still pre-1.0, which is the part that has not changed.
 *
 * `test/version.test.ts` holds this against `package.json` and the README the
 * same way the agent's does — the lesson there transfers, and so does the test.
 */
export const SDK_VERSION = '0.2.0';
