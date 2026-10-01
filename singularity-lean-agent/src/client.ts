/**
 * The calling side: lean-worker's `Protocol.Client`, executable.
 *
 * A client accepts an answer only if its tag verifies under the node's key and
 * it names this client, that node, this nonce and exactly the job that was
 * asked — and the Lean kernel accepted the result. Each of those is a separate
 * upstream theorem (`tampered_certificate_rejected`, `stale_nonce_rejected`,
 * `wrong_job_rejected`, `unchecked_result_rejected`), so each is reported here
 * as its own named check instead of folded into one boolean: a caller deciding
 * whether to trust a proof should see which property failed.
 */
import {
  type Call,
  type CallBody,
  type Job,
  type PeerId,
  type Response,
  encodeCertificate,
  tagCallBody,
  verifyTag,
} from './wire.js';

export interface ClientState {
  id: PeerId;
  /** Keys shared with prover nodes, used to authenticate outgoing calls. */
  callKeys: Record<PeerId, string>;
  /** Keys used to verify certificates coming back from those nodes. */
  verifyKeys: Record<PeerId, string>;
  nextNonce: number;
}

function lookup(keys: Record<PeerId, string>, peer: PeerId): string | undefined {
  return Object.hasOwn(keys, peer) ? keys[peer] : undefined;
}

/** `P2P.mkCall`: `null` when the client holds no key for that node. */
export function mkCall(
  client: ClientState,
  server: PeerId,
  job: Job,
  fuel: number,
  argv?: string[],
): { call: Call; client: ClientState } | null {
  const key = lookup(client.callKeys, server);
  if (key === undefined) return null;
  const body: CallBody = { client: client.id, server, nonce: client.nextNonce, job, fuelBudget: fuel };
  const call: Call = { body, auth: tagCallBody(client.id, key, body), ...(argv ? { argv } : {}) };
  return { call, client: { ...client, nextNonce: client.nextNonce + 1 } };
}

export type AcceptCheck =
  | 'certified'
  | 'nodeKeyKnown'
  | 'tagVerifies'
  | 'namesClient'
  | 'namesServer'
  | 'nonceMatches'
  | 'jobMatches'
  | 'kernelChecked';

export interface Acceptance {
  accepted: boolean;
  checks: Record<AcceptCheck, boolean>;
  /** The node's own reason, when it refused the call. */
  rejectedReason?: string;
}

/** `P2P.accepts`, with every conjunct named. */
export function accepts(client: ClientState, call: Call, response: Response): Acceptance {
  const checks: Record<AcceptCheck, boolean> = {
    certified: false,
    nodeKeyKnown: false,
    tagVerifies: false,
    namesClient: false,
    namesServer: false,
    nonceMatches: false,
    jobMatches: false,
    kernelChecked: false,
  };
  if (response.kind === 'rejected') return { accepted: false, checks, rejectedReason: response.reason };

  const { cert, tag } = response;
  const server = call.body.server;
  const key = lookup(client.verifyKeys, server);
  checks.certified = true;
  checks.nodeKeyKnown = key !== undefined;
  checks.tagVerifies = key !== undefined && verifyTag(server, key, encodeCertificate(cert), tag);
  checks.namesClient = cert.client === client.id;
  checks.namesServer = cert.server === server;
  checks.nonceMatches = cert.nonce === call.body.nonce;
  checks.jobMatches = sameJob(cert.job, call.body.job);
  checks.kernelChecked = cert.kernelChecked;

  return { accepted: Object.values(checks).every(Boolean), checks };
}

function sameJob(a: Job, b: Job): boolean {
  switch (a.kind) {
    case 'proveGoal':
      return b.kind === 'proveGoal' && a.module === b.module && a.decl === b.decl && a.sourceDigest === b.sourceDigest;
    case 'checkProof':
      return b.kind === 'checkProof' && a.artifactDigest === b.artifactDigest;
    case 'runExe':
      return b.kind === 'runExe' && a.exe === b.exe && a.argvDigest === b.argvDigest;
  }
}
