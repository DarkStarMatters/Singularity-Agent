import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RelayError, readRoom, relayHealth, roomId, seal, taskKey } from '../src/relay.js';
import { readTasks } from '../src/tasks.js';

/**
 * Checked against upstream's own data, not against this implementation: the
 * room ids and keys below are copied from lean-worker's minimal/tasks/*.json at
 * the pinned commit.
 */
const SALT = 'twin-proof-wave-vi-xii-2026-09-17-mike';
const UPSTREAM_KEYS: Record<string, string> = {
  'agent-a-wave-vi': 'cb1adfdc01d14b2f1ce5a26f9d4b2b2886a802fd0c114d48406dcef89c3f97b5',
  'agent-a-wave-vii': '3b99b3d7dedbf5d1529057c99a995781553a3d344d49e6deaa23fe02e4c9dd03',
  'agent-a-wave-viii': '8d10b8dc7db6fed795584063a3177f309d9c450a9f65a9da438fff140a4dae30',
};

describe('relay derivations match upstream task files', () => {
  it('room = SHA256(salt:agent)[:16]', () => {
    expect(roomId(SALT, 'agent-a')).toBe('5ac79509b89fb8b2');
    expect(roomId(SALT, 'agent-b')).toBe('7ace57627265db88');
  });

  it('key = SHA256(task:salt)', () => {
    for (const [task, key] of Object.entries(UPSTREAM_KEYS)) expect(taskKey(task, SALT).toString('hex')).toBe(key);
  });

  it('readTasks recomputes and reports what a task file claims', () => {
    const root = mkdtempSync(join(tmpdir(), 'lw-tasks-'));
    mkdirSync(join(root, 'minimal', 'tasks'), { recursive: true });
    writeFileSync(join(root, 'minimal', 'tasks', 'template.json'), '{"template_version":"1.0"}');
    writeFileSync(
      join(root, 'minimal', 'tasks', 'agent-a.json'),
      JSON.stringify({
        agent_id: 'agent-a',
        shared_salt: SALT,
        room_id: '5ac79509b89fb8b2',
        tasks: [
          { id: 'agent-a-wave-vi', wave: 'VI', enc_key: UPSTREAM_KEYS['agent-a-wave-vi'] },
          { id: 'agent-a-wave-vii', wave: 'VII', enc_key: '00'.repeat(32) },
        ],
      }),
    );
    const [summary] = readTasks(root);
    expect(summary).toMatchObject({ agent: 'agent-a', relay: { room: '5ac79509b89fb8b2', roomDerives: true, publicSalt: true } });
    expect(summary!.tasks.map((t) => t.keyDerives)).toEqual([true, false]);
  });
});

function stubFetch(status: number, body: string): typeof fetch {
  return (async () => new Response(body, { status })) as typeof fetch;
}

describe('relay HTTP', () => {
  it('names Cloudflare 1042 as the relay being down, which is what it answers today', async () => {
    const err = await relayHealth({ fetchImpl: stubFetch(404, 'error code: 1042') }).catch((e: RelayError) => e);
    expect(err).toBeInstanceOf(RelayError);
    expect((err as RelayError).code).toBe('RELAY_DOWN');
  });

  it('names 403 / 1010 as a refusal not to retry', async () => {
    const err = await relayHealth({ fetchImpl: stubFetch(403, 'error code: 1010') }).catch((e: RelayError) => e);
    expect((err as RelayError).code).toBe('RELAY_FORBIDDEN');
  });

  it('reads envelopes from an array or from any array inside an object, and counts the rest', async () => {
    const e = seal('hi', { task: 't', salt: 's', agent: 'a' });
    const asArray = await readRoom('r', { fetchImpl: stubFetch(200, JSON.stringify([e, { junk: 1 }])) });
    expect(asArray).toEqual({ envelopes: [e], unreadable: 1 });
    const wrapped = await readRoom('r', { fetchImpl: stubFetch(200, JSON.stringify({ messages: [e] })) });
    expect(wrapped.envelopes).toEqual([e]);
  });
});
