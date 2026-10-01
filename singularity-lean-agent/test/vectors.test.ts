import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VECTORS_PATH, vectors } from '../scripts/write-vectors.js';
import { EnvelopeError, open, seal } from '../src/relay.js';

/**
 * lean-link/1 is three copies of one definition — src/wire.ts, the Lean file,
 * and the JSON vectors — and this is what holds them together.
 */
const ROOT = join(__dirname, '..');
const file = JSON.parse(readFileSync(VECTORS_PATH, 'utf8'));
const lean = readFileSync(join(ROOT, 'lean', 'SingularityLean', 'Wire.lean'), 'utf8');

/** The string literal each `-- vector: <name>` example in Wire.lean states. */
function leanVector(name: string): string {
  const at = lean.indexOf(`-- vector: ${name}\n`);
  expect(at, `Wire.lean has no "-- vector: ${name}" example`).toBeGreaterThanOrEqual(0);
  const literal = /=\s*"((?:[^"\\]|\\.)*)"/.exec(lean.slice(at))!;
  return JSON.parse(`"${literal[1]}"`) as string;
}

describe('lean-link/1 vectors', () => {
  it('vectors/link-v1.json is exactly what src/ produces today', () => {
    expect(file).toEqual(JSON.parse(JSON.stringify(vectors())));
  });

  it('the Lean file pins the same encodings, so a Lean-native node interoperates', () => {
    expect(leanVector('call')).toBe(file.call.encoding);
    expect(leanVector('certificate')).toBe(file.certificate.encoding);
    expect(leanVector('failedCertificate')).toBe(file.failedCertificate.encoding);
    expect(leanVector('argv')).toBe(file.argv.encoding);
  });

  it('the Lean file names the same source digest', () => {
    expect(lean).toContain(`def sourceDigest : String := "${file.source.digest}"`);
  });

  it('the relay vector reproduces upstream\'s committed key and room for agent-a', () => {
    // From lean-worker minimal/tasks/agent-a.json at the pinned commit.
    expect(file.relay.key).toBe('cb1adfdc01d14b2f1ce5a26f9d4b2b2886a802fd0c114d48406dcef89c3f97b5');
    expect(file.relay.room).toBe('5ac79509b89fb8b2');
  });

  it('opens its own envelope, and refuses it under the wrong salt or with one bit flipped', () => {
    const { envelope, salt, plaintext } = file.relay;
    expect(open(envelope, salt)).toBe(plaintext);
    expect(() => open(envelope, 'not-the-salt')).toThrow(EnvelopeError);
    const flipped = { ...envelope, tag: (envelope.tag[0] === '0' ? '1' : '0') + envelope.tag.slice(1) };
    expect(() => open(flipped, salt)).toThrow(/does not decrypt/);
  });

  it('a fresh seal round-trips and uses a new IV each time', () => {
    const a = seal('x', { task: 't', salt: 's', agent: 'a' });
    const b = seal('x', { task: 't', salt: 's', agent: 'a' });
    expect(a.iv).not.toBe(b.iv);
    expect(open(a, 's')).toBe('x');
  });
});
