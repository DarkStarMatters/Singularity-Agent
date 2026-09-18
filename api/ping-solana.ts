/**
 * Probe 3: the heavy dependency.
 *
 * `@solana/web3.js` is the one package `burn.ts` loads at import time that is
 * large, CommonJS, and published without an `exports` map — the shape most
 * likely to behave differently under a bundler than it does under a plain
 * Node ESM import. It loads correctly here under both; this asks whether it
 * loads there.
 *
 * See `api/ping.ts` for what the three probes are for. Delete all three once
 * the burn endpoint serves.
 */
import { MARKER } from './ping.js';

interface Response {
  status(code: number): Response;
  setHeader(name: string, value: string): void;
  json(body: unknown): void;
}

/** The System Program: a fixed address, so the answer is checkable. */
const SYSTEM_PROGRAM = '11111111111111111111111111111111';

// Bumped so a response proves which deployment answered.

export default async function handler(_req: unknown, res: Response): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');

  // Imported here rather than at module scope so the failure is reportable.
  // A static import that throws takes the whole function down and the only
  // thing left to read is FUNCTION_INVOCATION_FAILED, which is what sent this
  // investigation through six dead hypotheses.
  try {
    const { PublicKey } = await import('@solana/web3.js');
    const key = new PublicKey(SYSTEM_PROGRAM);

    res.status(200).json({
      probe: 'ping-solana',
      imports: '@solana/web3.js',
      roundTripped: key.toBase58() === SYSTEM_PROGRAM,
      node: process.version,
      marker: MARKER,
    });
  } catch (err) {
    res.status(500).json({
      probe: 'ping-solana',
      failed: true,
      node: process.version,
      marker: MARKER,
      name: err instanceof Error ? err.name : typeof err,
      code: (err as { code?: string })?.code,
      message: err instanceof Error ? err.message : String(err),
      // The first frames name the module that actually threw.
      stack: err instanceof Error ? (err.stack ?? '').split('\n').slice(0, 6) : [],
    });
  }
}
