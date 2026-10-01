import { describe, expect, it } from 'vitest';
import { accepts, mkCall, type ClientState } from '../src/client.js';
import { NodeQueue, NOT_ADMITTED, admission, handle, type NodeState, type Runtime } from '../src/node.js';
import { type Call, type Certificate, type Job, argvDigest, tagCertificate } from '../src/wire.js';

/**
 * Each test restates one theorem from lean-worker's Protocol.Server or
 * Protocol.Client (named in the test) against the TypeScript port, so the
 * properties upstream proved about the model are checked of the code that runs.
 */
const CLIENT_KEY = '11'.repeat(32);
const NODE_KEY = '22'.repeat(32);
const DIGEST = 'ab'.repeat(32);
const PROVE: Job = { kind: 'proveGoal', module: 'M', decl: 'M.t', sourceDigest: DIGEST };

function node(overrides: Partial<NodeState> = {}): NodeState {
  return {
    id: 'node',
    key: NODE_KEY,
    policy: { admittedPeers: ['alice'], allowedExes: ['tool'], allowExeCalls: true, maxFuelPerCall: 100, fuelBudget: 250 },
    clientKeys: { alice: CLIENT_KEY },
    seen: [],
    fuelUsed: 0,
    ...overrides,
  };
}

const alice: ClientState = { id: 'alice', callKeys: { node: CLIENT_KEY }, verifyKeys: { node: NODE_KEY }, nextNonce: 0 };

const proving: Runtime = { run: async () => ({ outcome: { kind: 'proved', axioms: ['propext'] }, kernelChecked: true }) };

function call(job: Job = PROVE, fuel = 50, from = alice, argv?: string[]): Call {
  return mkCall(from, 'node', job, fuel, argv)!.call;
}

describe('node gate (Protocol.Server)', () => {
  it('certified_implies_admitted / certificate_binds_call', async () => {
    const c = call();
    const { response, state } = await handle(proving, node(), c);
    expect(response.kind).toBe('certified');
    if (response.kind !== 'certified') return;
    expect(response.cert).toMatchObject({ server: 'node', client: 'alice', nonce: 0, job: PROVE, kernelChecked: true, fuelUsed: 50 });
    expect(response.tag).toEqual(tagCertificate('node', NODE_KEY, response.cert));
    expect(state.fuelUsed).toBe(50);
  });

  it('rejected_state_unchanged: a refused call returns the very same state', async () => {
    const s = node();
    const forged = { ...call(), auth: { signer: 'alice', mac: '00'.repeat(32) } };
    const handled = await handle(proving, s, forged);
    expect(handled.state).toBe(s);
    expect(handled.response).toEqual({ kind: 'rejected', reason: NOT_ADMITTED });
    expect(handled.failed).toEqual(['authenticated']);
  });

  it('unlisted_peer_rejected, even with a valid key', async () => {
    const s = node({ policy: { ...node().policy, admittedPeers: [] } });
    expect((await handle(proving, s, call())).failed).toContain('admitted');
  });

  it('no_exe_when_disabled / unlisted_exe_rejected', async () => {
    const exe: Job = { kind: 'runExe', exe: 'tool', argvDigest: argvDigest(['a']) };
    const off = node({ policy: { ...node().policy, allowExeCalls: false } });
    expect((await handle(proving, off, call(exe, 10, alice, ['a']))).failed).toEqual(['jobAllowed']);
    const other: Job = { kind: 'runExe', exe: 'rm', argvDigest: argvDigest(['a']) };
    expect((await handle(proving, node(), call(other, 10, alice, ['a']))).failed).toEqual(['jobAllowed']);
  });

  it('runExe arguments must be the ones the signed digest names', async () => {
    const exe: Job = { kind: 'runExe', exe: 'tool', argvDigest: argvDigest(['a']) };
    const swapped = { ...call(exe, 10, alice, ['a']), argv: ['b'] };
    expect((await handle(proving, node(), swapped)).failed).toEqual(['argvMatches']);
  });

  it('certified_respects_fuel / fuel_invariant', async () => {
    expect((await handle(proving, node(), call(PROVE, 101))).failed).toEqual(['withinCallCap']);
    expect((await handle(proving, node({ fuelUsed: 200 }), call(PROVE, 51))).failed).toEqual(['withinBudget']);
    let s = node();
    let client = alice;
    for (let i = 0; i < 6; i++) {
      const made = mkCall(client, 'node', PROVE, 100)!;
      client = made.client;
      s = (await handle(proving, s, made.call)).state;
      expect(s.fuelUsed).toBeLessThanOrEqual(s.policy.fuelBudget);
    }
    expect(s.fuelUsed).toBe(200);
  });

  it('replay_rejected: the same call a second time is refused and changes nothing', async () => {
    const c = call();
    const first = await handle(proving, node(), c);
    const second = await handle(proving, first.state, c);
    expect(second.response).toEqual({ kind: 'rejected', reason: NOT_ADMITTED });
    expect(second.failed).toEqual(['fresh']);
    expect(second.state).toBe(first.state);
  });

  it('a misaddressed call is refused', () => {
    expect(admission(node({ id: 'other' }), call()).failed).toContain('addressed');
  });

  it('an admitted call whose back end throws is still answered and charged', async () => {
    const broken: Runtime = { run: async () => { throw new Error('boom'); } };
    const { response, state } = await handle(broken, node(), call());
    expect(response.kind === 'certified' && response.cert.outcome).toEqual({ kind: 'failed', reason: 'runtime error: boom' });
    expect(response.kind === 'certified' && response.cert.kernelChecked).toBe(false);
    expect(state.fuelUsed).toBe(50);
  });

  it('serialises concurrent copies of one call, so only one is served', async () => {
    let release!: () => void;
    const slow: Runtime = { run: () => new Promise((r) => (release = () => r({ outcome: { kind: 'proved', axioms: [] }, kernelChecked: true }))) };
    const queue = new NodeQueue(node(), slow);
    const c = call();
    const a = queue.submit(c);
    const b = queue.submit(c);
    await new Promise((r) => setTimeout(r, 10));
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.response.kind).toBe('certified');
    expect(rb.response.kind).toBe('rejected');
    expect(queue.current().seen).toHaveLength(1);
  });
});

describe('client acceptance (Protocol.Client)', () => {
  async function served() {
    const made = mkCall(alice, 'node', PROVE, 50)!;
    const { response } = await handle(proving, node(), made.call);
    if (response.kind !== 'certified') throw new Error('expected a certificate');
    return { call: made.call, client: made.client, response };
  }

  it('accepts an honest certificate, with every check true', async () => {
    const { call: c, client, response } = await served();
    const verdict = accepts(client, c, response);
    expect(verdict.accepted).toBe(true);
    expect(Object.values(verdict.checks).every(Boolean)).toBe(true);
  });

  it('not_accepts_rejected', () => {
    expect(accepts(alice, call(), { kind: 'rejected', reason: NOT_ADMITTED })).toMatchObject({ accepted: false, rejectedReason: NOT_ADMITTED });
  });

  it('tampered_certificate_rejected: any field changed under the same tag', async () => {
    const { call: c, client, response } = await served();
    const variants: Array<Partial<Certificate>> = [
      { outcome: { kind: 'proved', axioms: [] } },
      { fuelUsed: 1 },
      { kernelChecked: true, outcome: { kind: 'proved', axioms: ['sorryAx'] } },
    ];
    for (const v of variants) {
      const verdict = accepts(client, c, { ...response, cert: { ...response.cert, ...v } });
      expect(verdict.accepted).toBe(false);
      expect(verdict.checks.tagVerifies).toBe(false);
    }
  });

  it('accepts_requires_server_key: a relay re-tagging with another key is refused', async () => {
    const { call: c, client, response } = await served();
    const retagged = { ...response, tag: tagCertificate('node', '33'.repeat(32), response.cert) };
    expect(accepts(client, c, retagged).checks.tagVerifies).toBe(false);
  });

  it('stale_nonce_rejected / wrong_job_rejected, even when honestly tagged', async () => {
    const { client, response } = await served();
    const later = mkCall(client, 'node', PROVE, 50)!.call; // nonce 1
    expect(accepts(client, later, response).checks.nonceMatches).toBe(false);
    const otherJob = mkCall(alice, 'node', { kind: 'checkProof', artifactDigest: DIGEST }, 50)!.call;
    expect(accepts(alice, otherJob, response).checks.jobMatches).toBe(false);
  });

  it('unchecked_result_rejected: a well-signed result the kernel did not check', async () => {
    const unchecked: Runtime = { run: async () => ({ outcome: { kind: 'failed', reason: 'x' }, kernelChecked: false }) };
    const made = mkCall(alice, 'node', PROVE, 50)!;
    const { response } = await handle(unchecked, node(), made.call);
    const verdict = accepts(made.client, made.call, response);
    expect(verdict.checks.tagVerifies).toBe(true);
    expect(verdict.checks.kernelChecked).toBe(false);
    expect(verdict.accepted).toBe(false);
  });

  it('mkCall: no key, no call; and the nonce always advances', () => {
    expect(mkCall(alice, 'stranger', PROVE, 1)).toBeNull();
    const made = mkCall(alice, 'node', PROVE, 1)!;
    expect(made.client.nextNonce).toBe(made.call.body.nonce + 1);
  });

  it('a key lookup never reaches Object.prototype', () => {
    const proto: ClientState = { ...alice, callKeys: {} };
    expect(mkCall(proto, 'constructor', PROVE, 1)).toBeNull();
    expect(mkCall(proto, '__proto__', PROVE, 1)).toBeNull();
  });
});
