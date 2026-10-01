/**
 * Where a node's and a client's keys and counters live between runs.
 *
 * `~/.singularity/lean-link/` unless SINGULARITY_LEAN_HOME says otherwise —
 * beside Singularity's own config, outside any repository, because these files
 * hold HMAC keys. Writes go to a temporary file and are renamed into place, so
 * a crash mid-write leaves the previous state rather than half of the next one:
 * a node that lost its `seen` list would serve a replayed call.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { ClientState } from './client.js';
import type { NodeState, Policy } from './node.js';

export function linkHome(): string {
  return process.env.SINGULARITY_LEAN_HOME || join(homedir(), '.singularity', 'lean-link');
}

/** The lean-worker checkout to stage and build, from LEAN_WORKER_DIR or `<home>/lean-worker`. */
export function workerCheckout(): string {
  return process.env.LEAN_WORKER_DIR || join(linkHome(), 'lean-worker');
}

export function newKey(): string {
  return randomBytes(32).toString('hex');
}

function readJson<T>(path: string, schema: z.ZodType<T>): T | null {
  if (!existsSync(path)) return null;
  return schema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows ignores POSIX modes; the file is still under the user's profile.
  }
}

const key = z.string().regex(/^[0-9a-f]{64}$/);

export const ProjectSchema = z.discriminatedUnion('kind', [
  /** A lean-worker checkout, staged into the layout its imports expect. */
  z.object({ kind: z.literal('lean-worker'), checkout: z.string() }),
  /** An ordinary Lake project that has been built with `lake build`. */
  z.object({ kind: z.literal('lake'), root: z.string() }),
]);
export type Project = z.infer<typeof ProjectSchema>;

const PolicySchema: z.ZodType<Policy> = z.object({
  admittedPeers: z.array(z.string()),
  allowedExes: z.array(z.string()),
  allowExeCalls: z.boolean(),
  maxFuelPerCall: z.number().int().positive(),
  fuelBudget: z.number().int().nonnegative(),
});

const NodeConfigSchema = z.object({
  id: z.string().min(1),
  key,
  policy: PolicySchema,
  clientKeys: z.record(key),
  project: ProjectSchema,
});
export type NodeConfig = z.infer<typeof NodeConfigSchema>;

const NodeCountersSchema = z.object({ seen: z.array(z.string()), fuelUsed: z.number().int().nonnegative() });

const ClientConfigSchema = z.object({
  id: z.string().min(1),
  nodes: z.record(z.object({ url: z.string().url(), callKey: key, verifyKey: key })),
  nextNonce: z.number().int().nonnegative(),
});
export type ClientConfig = z.infer<typeof ClientConfigSchema>;

const paths = () => ({
  node: join(linkHome(), 'node.json'),
  counters: join(linkHome(), 'node-state.json'),
  client: join(linkHome(), 'client.json'),
});

/** Defaults are the safe ones: nobody admitted, no executables, ten minutes a call. */
export function defaultPolicy(): Policy {
  return { admittedPeers: [], allowedExes: [], allowExeCalls: false, maxFuelPerCall: 600, fuelBudget: 36_000 };
}

export function loadNodeConfig(): NodeConfig | null {
  return readJson(paths().node, NodeConfigSchema);
}

export function saveNodeConfig(config: NodeConfig): void {
  writeJson(paths().node, NodeConfigSchema.parse(config));
}

export function loadNodeState(): NodeState | null {
  const config = loadNodeConfig();
  if (!config) return null;
  const counters = readJson(paths().counters, NodeCountersSchema) ?? { seen: [], fuelUsed: 0 };
  return { id: config.id, key: config.key, policy: config.policy, clientKeys: config.clientKeys, ...counters };
}

export function saveNodeCounters(state: NodeState): void {
  writeJson(paths().counters, { seen: state.seen, fuelUsed: state.fuelUsed });
}

export function loadClientConfig(): ClientConfig | null {
  return readJson(paths().client, ClientConfigSchema);
}

export function saveClientConfig(config: ClientConfig): void {
  writeJson(paths().client, ClientConfigSchema.parse(config));
}

export function clientState(config: ClientConfig): ClientState {
  const callKeys: Record<string, string> = {};
  const verifyKeys: Record<string, string> = {};
  for (const [id, node] of Object.entries(config.nodes)) {
    callKeys[id] = node.callKey;
    verifyKeys[id] = node.verifyKey;
  }
  return { id: config.id, callKeys, verifyKeys, nextNonce: config.nextNonce };
}

export const storePaths = paths;
