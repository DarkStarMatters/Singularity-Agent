/**
 * The prover node: lean-worker's `Protocol.Server`, executable.
 *
 * Every incoming call passes one admission gate before any work happens, and
 * the gate is a line-for-line port of `P2P.admits`: addressed to this node, the
 * caller admitted, the call authenticated under the caller's key, the nonce
 * unseen, the job allowed by policy, the fuel inside both the per-call cap and
 * the remaining budget. `handle` is `P2P.handle`: a rejected call changes no
 * state, an admitted one records its nonce and charges the fuel it asked for.
 *
 * The upstream theorems (`rejected_state_unchanged`, `replay_rejected`,
 * `fuel_invariant`, `certificate_binds_call`, ...) are about that function, so
 * keeping this one the same shape is what lets them say something about the
 * code that runs. `test/node.test.ts` restates each of them as a test.
 *
 * The one deliberate difference: the wire answer to a refused call is the
 * upstream's uniform "not admitted", but `handle` also returns the names of the
 * checks that failed, for the node operator's log. They never go on the wire;
 * telling a stranger which check they failed is telling them what to fix.
 */
import {
  type Call,
  type Certificate,
  type Job,
  type Outcome,
  type PeerId,
  type Response,
  argvDigest,
  encodeCallBody,
  tagCertificate,
  verifyTag,
} from './wire.js';

export interface Policy {
  admittedPeers: PeerId[];
  allowedExes: string[];
  /** Master switch for running executables; proof checking is unaffected. */
  allowExeCalls: boolean;
  maxFuelPerCall: number;
  fuelBudget: number;
}

export interface NodeState {
  id: PeerId;
  /** The node's own key; certificates are tagged with it. */
  key: string;
  policy: Policy;
  /** Keys shared with admitted callers, used to authenticate their calls. */
  clientKeys: Record<PeerId, string>;
  /** `client \u0000 nonce` for every call already served. */
  seen: string[];
  fuelUsed: number;
}

export interface RunResult {
  outcome: Outcome;
  kernelChecked: boolean;
}

/** The back end that actually does the work; `runtime.ts` provides the real one. */
export interface Runtime {
  run(job: Job, fuelSeconds: number, call: Call): Promise<RunResult>;
}

export type GateCheck =
  | 'addressed'
  | 'admitted'
  | 'authenticated'
  | 'fresh'
  | 'jobAllowed'
  | 'argvMatches'
  | 'withinCallCap'
  | 'withinBudget';

export interface Admission {
  admitted: boolean;
  failed: GateCheck[];
}

export function seenKey(client: PeerId, nonce: number): string {
  return `${client}\u0000${nonce}`;
}

export function jobAllowed(policy: Policy, job: Job): boolean {
  if (job.kind !== 'runExe') return true;
  return policy.allowExeCalls && policy.allowedExes.includes(job.exe);
}

export function authenticated(state: NodeState, call: Call): boolean {
  const key = Object.hasOwn(state.clientKeys, call.body.client) ? state.clientKeys[call.body.client] : undefined;
  if (key === undefined) return false;
  return verifyTag(call.body.client, key, encodeCallBody(call.body), call.auth);
}

/**
 * `runExe` names its arguments by digest, as upstream does. The arguments
 * themselves travel beside the tagged body, so the gate checks they are the
 * ones the digest — and therefore the tag — covers.
 */
function argvMatches(call: Call): boolean {
  if (call.body.job.kind !== 'runExe') return call.argv === undefined;
  return call.argv !== undefined && argvDigest(call.argv) === call.body.job.argvDigest;
}

/** `P2P.admits`, with the reasons kept. */
export function admission(state: NodeState, call: Call): Admission {
  const { body } = call;
  const checks: Array<[GateCheck, boolean]> = [
    ['addressed', body.server === state.id],
    ['admitted', state.policy.admittedPeers.includes(body.client)],
    ['authenticated', authenticated(state, call)],
    ['fresh', !state.seen.includes(seenKey(body.client, body.nonce))],
    ['jobAllowed', jobAllowed(state.policy, body.job)],
    ['argvMatches', argvMatches(call)],
    ['withinCallCap', body.fuelBudget <= state.policy.maxFuelPerCall],
    ['withinBudget', state.fuelUsed + body.fuelBudget <= state.policy.fuelBudget],
  ];
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  return { admitted: failed.length === 0, failed };
}

export const NOT_ADMITTED = 'not admitted';

export interface Handled {
  state: NodeState;
  response: Response;
  /** Operator-side only: which gate checks a refused call failed. */
  failed: GateCheck[];
}

/** `P2P.handle`: work happens only behind the gate. */
export async function handle(runtime: Runtime, state: NodeState, call: Call): Promise<Handled> {
  const gate = admission(state, call);
  if (!gate.admitted) {
    return { state, response: { kind: 'rejected', reason: NOT_ADMITTED }, failed: gate.failed };
  }

  const { body } = call;
  // An admitted call is always answered and always charged, as upstream: a
  // back end that throws is a failed outcome, not a way to replay for free.
  const result: RunResult = await runtime.run(body.job, body.fuelBudget, call).catch((err: unknown) => ({
    outcome: { kind: 'failed', reason: `runtime error: ${err instanceof Error ? err.message : String(err)}` },
    kernelChecked: false,
  }));
  const cert: Certificate = {
    server: state.id,
    client: body.client,
    nonce: body.nonce,
    job: body.job,
    outcome: result.outcome,
    kernelChecked: result.kernelChecked,
    fuelUsed: body.fuelBudget,
  };
  const next: NodeState = {
    ...state,
    seen: [seenKey(body.client, body.nonce), ...state.seen],
    fuelUsed: state.fuelUsed + body.fuelBudget,
  };
  return { state: next, response: { kind: 'certified', cert, tag: tagCertificate(state.id, state.key, cert) }, failed: [] };
}

/**
 * Serialises calls into one node.
 *
 * `P2P.handle` is atomic; this one awaits a Lean process in the middle. Without
 * a queue, two copies of one call could both pass the freshness check before
 * either recorded its nonce, which is exactly the replay `replay_rejected`
 * rules out.
 */
export class NodeQueue {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private state: NodeState,
    private readonly runtime: Runtime,
    private readonly persist: (state: NodeState) => void = () => {},
  ) {}

  current(): NodeState {
    return this.state;
  }

  submit(call: Call): Promise<Handled> {
    const run = this.tail.then(async () => {
      const handled = await handle(this.runtime, this.state, call);
      if (handled.state !== this.state) {
        this.state = handled.state;
        this.persist(this.state);
      }
      return handled;
    });
    this.tail = run.catch(() => undefined);
    return run;
  }
}
