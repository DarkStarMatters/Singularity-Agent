/**
 * Three probes that answer one question: which layer of the deployment is
 * broken.
 *
 * `/api/burn` returns FUNCTION_INVOCATION_FAILED on every method, including
 * OPTIONS, which parses nothing — the signature of a module that never loads.
 * Locally the same code bundles, imports and answers correctly under a
 * production-only dependency tree, so nothing that can be run from here
 * reproduces it, and the build logs are not readable from here either.
 *
 * So the deployment gets asked directly, by bisection. Each probe adds exactly
 * one thing to the one before it:
 *
 *   /api/ping         nothing at all — does a function in this repo run?
 *   /api/ping-src     one import from ../src — does the TypeScript path that
 *                     reaches outside api/ survive the build?
 *   /api/ping-solana  @solana/web3.js — does the heavy dependency load?
 *
 * The first one that fails names the layer. If all three answer, the fault is
 * specific to `burn.ts`; if none do, no new build has been deployed at all,
 * which is itself the answer.
 *
 * These are temporary. Delete all three once the burn endpoint serves.
 */

/** Bumped by hand so a response proves which commit is actually live. */
export const MARKER = 'probe-1';

interface Response {
  status(code: number): Response;
  setHeader(name: string, value: string): void;
  json(body: unknown): void;
}

export default function handler(_req: unknown, res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    probe: 'ping',
    imports: 'none',
    marker: MARKER,
    node: process.version,
  });
}
