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
import { PublicKey } from '@solana/web3.js';
import { MARKER } from './ping.js';

interface Response {
  status(code: number): Response;
  setHeader(name: string, value: string): void;
  json(body: unknown): void;
}

/** The System Program: a fixed address, so the answer is checkable. */
const SYSTEM_PROGRAM = '11111111111111111111111111111111';

export default function handler(_req: unknown, res: Response): void {
  const key = new PublicKey(SYSTEM_PROGRAM);

  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    probe: 'ping-solana',
    imports: '@solana/web3.js',
    roundTripped: key.toBase58() === SYSTEM_PROGRAM,
    marker: MARKER,
  });
}
