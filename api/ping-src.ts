/**
 * Probe 2: one import that reaches outside `api/`.
 *
 * `../src/core/errors.js` has no dependencies of its own, so this isolates a
 * single question — whether the build carries a TypeScript file from outside
 * the function's own directory, imported by the `.js` specifier that
 * TypeScript requires and that only some toolchains rewrite.
 *
 * See `api/ping.ts` for what the three probes are for. Delete all three once
 * the burn endpoint serves.
 */
import { SingularityError } from '../src/core/errors.js';
import { MARKER } from './ping.js';

interface Response {
  status(code: number): Response;
  setHeader(name: string, value: string): void;
  json(body: unknown): void;
}

export default function handler(_req: unknown, res: Response): void {
  // Constructed rather than merely imported: a tree-shaken import proves less
  // than a value that had to exist at runtime.
  const err = new SingularityError('PROBE', 'The import resolved.', 'Nothing is wrong here.');

  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    probe: 'ping-src',
    imports: '../src/core/errors.js',
    resolved: err.code === 'PROBE',
    marker: MARKER,
  });
}
