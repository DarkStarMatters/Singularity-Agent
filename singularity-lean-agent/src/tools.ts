/**
 * The tool catalogue, shared by the MCP server and the CLI's `--json` output.
 *
 * What these tools do on the machine they run on, stated once so no
 * description has to hedge:
 *
 *  - They run the Lean compiler. Elaborating Lean can execute code (`#eval`,
 *    macros), so `lean_check` on a file is as trusting as compiling it
 *    yourself. None of them is annotated read-only.
 *  - They never post to the relay. `lean_relay_seal` returns the envelope and
 *    the command that would post it; sending it is the user's call, through the
 *    CLI's `relay post`.
 *  - `lean_call` is the only one that talks to a prover node, and it spends the
 *    fuel it asks for there.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { accepts } from './client.js';
import { callNode } from './http.js';
import { type CheckResult, checkFile, checkSource, toolchain } from './lean.js';
import {
  DEFAULT_RELAY,
  EnvelopeSchema,
  type TaskResult,
  TaskResultSchema,
  curlCommand,
  open,
  readRoom,
  relayHealth,
  roomId,
  seal,
  sealedWithPublicSalt,
} from './relay.js';
import { clientState, linkHome, loadClientConfig, loadNodeConfig, saveClientConfig, workerCheckout } from './store.js';
import { readTasks } from './tasks.js';
import { VERSION } from './version.js';
import { CallSchema, type Job, LINK_VERSION, ResponseSchema, UPSTREAM, argvDigest, sha256Hex } from './wire.js';
import { buildStage, stageWorker } from './worker.js';

export class ToolError extends Error {
  constructor(readonly code: string, message: string, readonly hint?: string) {
    super(message);
  }
}

export interface ToolAnnotations {
  readOnlyHint: boolean;
  openWorldHint: boolean;
  destructiveHint?: boolean;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  shape: z.ZodRawShape;
  annotations: ToolAnnotations;
  run(args: Record<string, unknown>): Promise<unknown>;
}

function defineTool<S extends z.ZodRawShape>(spec: {
  name: string;
  title: string;
  description: string;
  shape: S;
  annotations: ToolAnnotations;
  run(args: z.infer<z.ZodObject<S>>): Promise<unknown> | unknown;
}): ToolDefinition {
  return { ...spec, run: async (args) => spec.run(args as z.infer<z.ZodObject<S>>) };
}

/** Runs Lean locally: not read-only, not open-world. */
const LOCAL: ToolAnnotations = { readOnlyHint: false, openWorldHint: false, destructiveHint: false };
/** Reads something over the network and changes nothing. */
const NETWORK_READ: ToolAnnotations = { readOnlyHint: true, openWorldHint: true };

/** lean-worker's `result_format`, from a local check — what an agent puts in a relay envelope. */
export function toTaskResult(file: string, check: CheckResult): TaskResult {
  const sorries = check.sorryWarnings;
  const result: TaskResult = {
    compiled: check.compiled,
    theorems_proved: check.compiled ? Math.max(0, check.theorems.length - sorries) : 0,
    sorrys_remaining: sorries,
    warnings: check.warnings.length,
    files_changed: [file],
    theorems_added: [],
    total_theorems: check.theorems.length,
    total_sorrys: sorries,
  };
  const log = [...check.errors, ...check.warnings].map((d) => `${file}:${d.line}:${d.column}: ${d.severity}: ${d.message}`).join('\n');
  if (log) result.log = log.slice(0, 20_000);
  if (!check.compiled) result.error = check.timedOut ? 'timed out' : (check.errors[0]?.message ?? check.stderr ?? 'did not compile');
  return result;
}

const jobArg = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('proveGoal'),
    module: z.string().describe('Module on the node, e.g. "RequestProject.Protocol.Server".'),
    decl: z.string().describe('Fully qualified declaration, e.g. "P2P.replay_rejected".'),
    sourceDigest: z.string().optional().describe('SHA-256 hex of the module source the node must have. Omit and pass `sourcePath` to compute it.'),
    sourcePath: z.string().optional().describe('Local copy of the module source; its digest becomes `sourceDigest`.'),
  }),
  z.object({ kind: z.literal('checkProof'), artifactDigest: z.string().describe('Digest of a proof artifact the node certified earlier.') }),
  z.object({ kind: z.literal('runExe'), exe: z.string(), argv: z.array(z.string()).describe('Arguments; their digest is what the call signs.') }),
]);

export const TOOLS: ToolDefinition[] = [
  defineTool({
    name: 'lean_doctor',
    title: 'Check the Lean link is ready',
    description:
      'Report what the Lean link can do on this machine: the Lean, Lake and elan versions (as the lean-worker checkout would select them), whether a lean-worker checkout is present, whether this machine is configured as a prover node or a client and for which nodes, and — with `relay: true` — whether the Kant zk-relay answers. Call this first when another lean_ tool fails, or before promising a user that a proof can be checked here.',
    shape: { relay: z.boolean().optional().describe('Also probe the relay (one GET).') },
    annotations: NETWORK_READ,
    run: async ({ relay }) => {
      const checkout = workerCheckout();
      const hasCheckout = existsSync(join(checkout, 'minimal'));
      const node = loadNodeConfig();
      const client = loadClientConfig();
      const report: Record<string, unknown> = {
        version: VERSION,
        link: LINK_VERSION,
        upstream: UPSTREAM,
        toolchain: await toolchain(hasCheckout ? join(checkout, 'minimal') : undefined),
        home: linkHome(),
        leanWorker: hasCheckout ? { checkout } : { checkout: null, hint: `Clone ${UPSTREAM.repo} to ${checkout} or set LEAN_WORKER_DIR.` },
        node: node ? { id: node.id, project: node.project, admittedPeers: node.policy.admittedPeers, allowExeCalls: node.policy.allowExeCalls } : null,
        client: client ? { id: client.id, nodes: Object.fromEntries(Object.entries(client.nodes).map(([id, n]) => [id, n.url])) } : null,
      };
      if (relay) {
        report.relay = await relayHealth().then(
          (body) => ({ ok: true, body }),
          (err: Error & { code?: string; hint?: string }) => ({ ok: false, code: err.code, message: err.message, hint: err.hint }),
        );
      }
      return report;
    },
  }),

  defineTool({
    name: 'lean_check',
    title: 'Compile and kernel-check Lean',
    description:
      "Compile a Lean 4 file (or inline source) with the local toolchain and report what the kernel did: errors and warnings with positions, `sorry` uses, and — for each declaration in `decls` — the axioms it depends on. `kernelAccepted` is true only when it compiled with no errors and no requested declaration rests on `sorryAx`; that, not a theorem count, is what 'proved' means. Also returns the result in lean-worker's relay `result_format`, ready for `lean_relay_seal`. Compiling Lean can run code the file contains, so check files you would compile yourself. Imports resolve through `leanPath` (directories of built .olean files); after `lean_worker_build`, pass its `leanPath` to check files importing lean-worker modules.",
    shape: {
      path: z.string().optional().describe('A .lean file. Give this or `source`.'),
      source: z.string().max(1_000_000).optional().describe('Lean source text, checked as a scratch file.'),
      decls: z.array(z.string()).max(64).optional().describe('Declarations whose axioms to report, e.g. ["P2P.replay_rejected"].'),
      leanPath: z.array(z.string()).optional().describe('Directories of .olean files the source imports.'),
      cwd: z.string().optional().describe('Directory to run in; elan picks the toolchain from its lean-toolchain file.'),
      timeoutSeconds: z.number().int().positive().max(3600).optional().describe('Default 300.'),
    },
    annotations: LOCAL,
    run: async ({ path, source, decls, leanPath, cwd, timeoutSeconds }) => {
      if (!path === !source) throw new ToolError('BAD_ARGS', 'Pass exactly one of `path` or `source`.');
      const options = { decls: decls ?? [], timeoutMs: (timeoutSeconds ?? 300) * 1000, ...(leanPath ? { leanPath } : {}), ...(cwd ? { cwd } : {}) };
      const check = path ? await checkFile(resolve(path), options) : await checkSource(source!, options);
      if (check.exitCode === null && !check.timedOut) {
        throw new ToolError('LEAN_NOT_FOUND', 'Lean did not start.', (await toolchain(cwd)).hint ?? check.stderr);
      }
      return { ...check, taskResult: toTaskResult(path ?? 'source.lean', check) };
    },
  }),

  defineTool({
    name: 'lean_worker_build',
    title: 'Build a lean-worker checkout and verify its claims',
    description:
      "Build the lean-worker checkout the way its imports require (staged as `RequestProject.*`, leaf-first, under its pinned toolchain, without Mathlib), and report each module's result from the compiler: ok, failed with errors, or skipped with the reason. This is how to check lean-worker's README claims (theorem counts, zero sorries) against the kernel rather than grep. The default `groups` — core, protocol, proxy — take a few minutes the first time; `plugin-context` adds the 45 plugin contexts. Returns `leanPath` for `lean_check`. Copies the checkout; never modifies it.",
    shape: {
      checkout: z.string().optional().describe('Path to the checkout. Defaults to LEAN_WORKER_DIR or ~/.singularity/lean-link/lean-worker.'),
      groups: z.array(z.enum(['core', 'protocol', 'proxy', 'plugin-context', 'entry'])).optional().describe("Which modules to build. Default: core, protocol, proxy. 'entry' is Main.lean and needs Mathlib, so it is reported as skipped."),
      moduleTimeoutSeconds: z.number().int().positive().max(3600).optional().describe('Per module. Default 600.'),
    },
    annotations: LOCAL,
    run: async ({ checkout, groups, moduleTimeoutSeconds }) => {
      const dir = resolve(checkout ?? workerCheckout());
      const stage = stageWorker(dir, join(linkHome(), 'stage'));
      const report = await buildStage(stage, { groups: groups ?? ['core', 'protocol', 'proxy'], ...(moduleTimeoutSeconds ? { moduleTimeoutSeconds } : {}) });
      return {
        ...report,
        leanPath: [stage.out],
        cwd: stage.dir,
        // Keep the payload readable: passing modules don't need their (empty) error lists.
        modules: report.modules.map((m) => (m.status === 'ok' ? { module: m.module, status: m.status, theorems: m.theorems, sorryWarnings: m.sorryWarnings } : m)),
      };
    },
  }),

  defineTool({
    name: 'lean_tasks',
    title: 'List lean-worker tasks and check their relay keys',
    description:
      "List the agent task files in a lean-worker checkout (minimal/tasks/), with each agent's relay room and tasks, and recompute every room id and task key from the shared salt to check the file's claims. `publicSalt: true` means the salt is committed to the public repository, so anyone can open those envelopes. Reads local files only.",
    shape: { checkout: z.string().optional().describe('Defaults to LEAN_WORKER_DIR or ~/.singularity/lean-link/lean-worker.') },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: ({ checkout }) => readTasks(resolve(checkout ?? workerCheckout())),
  }),

  defineTool({
    name: 'lean_call',
    title: 'Ask a prover node to prove, re-check or run',
    description:
      "Make one certified lean-link/1 call to a lean-worker prover node this machine is paired with, and verify the answer. Jobs: `proveGoal` (the node kernel-checks a declaration in a module whose source digest you name, so you both mean the same text), `checkProof` (re-check an artifact it certified before), `runExe` (only if the node allows it). The answer is accepted only if every check passes — tag verifies under the node's key, names this client, the node, this nonce, the exact job, and `kernelChecked`; `acceptance.checks` names any that failed. Spends up to `fuel` seconds of the node's budget even if the proof fails. Nonces persist, so a call is never replayable.",
    shape: {
      node: z.string().describe('Node id, as paired with `singularity-lean client add-node`.'),
      job: jobArg,
      fuel: z.number().int().positive().max(3600).describe('Seconds the node may spend.'),
    },
    annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false },
    run: async ({ node, job, fuel }) => {
      const config = loadClientConfig();
      if (!config) throw new ToolError('NO_CLIENT', 'This machine is not set up as a lean-link client.', 'Run `singularity-lean client init <id>` and pair with a node.');
      const entry = config.nodes[node];
      if (!entry) throw new ToolError('UNKNOWN_NODE', `Not paired with node "${node}".`, `Paired nodes: ${Object.keys(config.nodes).join(', ') || 'none'}.`);

      let wireJob: Job;
      let argv: string[] | undefined;
      if (job.kind === 'proveGoal') {
        const digest = job.sourceDigest ?? (job.sourcePath ? sha256Hex(readFileSync(resolve(job.sourcePath), 'utf8')) : undefined);
        if (!digest) throw new ToolError('BAD_ARGS', 'proveGoal needs `sourceDigest` or `sourcePath`.');
        wireJob = { kind: 'proveGoal', module: job.module, decl: job.decl, sourceDigest: digest };
      } else if (job.kind === 'checkProof') {
        wireJob = job;
      } else {
        argv = job.argv;
        wireJob = { kind: 'runExe', exe: job.exe, argvDigest: argvDigest(job.argv) };
      }

      const outcome = await callNode({
        client: clientState(config),
        node,
        url: entry.url,
        job: wireJob,
        fuel,
        ...(argv ? { argv } : {}),
        persistNonce: (c) => saveClientConfig({ ...config, nextNonce: c.nextNonce }),
      });
      return { accepted: outcome.acceptance.accepted, acceptance: outcome.acceptance, call: outcome.call, response: outcome.response };
    },
  }),

  defineTool({
    name: 'lean_verify_certificate',
    title: 'Verify a prover certificate offline',
    description:
      "Check a lean-link/1 certificate against the call it answers, using this machine's client keys — for a certificate that arrived some other way than `lean_call` (inside a relay envelope, pasted by a user). Returns the same named checks as `lean_call`. Verifies only; contacts nothing.",
    shape: {
      call: z.unknown().describe('The Call object the certificate answers.'),
      response: z.unknown().describe('The Response object: {kind:"certified", cert, tag} or {kind:"rejected", reason}.'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: ({ call, response }) => {
      const config = loadClientConfig();
      if (!config) throw new ToolError('NO_CLIENT', 'No client keys on this machine to verify with.', 'Run `singularity-lean client init <id>` and pair with the node.');
      const c = CallSchema.safeParse(call);
      const r = ResponseSchema.safeParse(response);
      if (!c.success) throw new ToolError('BAD_CALL', `Not a ${LINK_VERSION} call: ${c.error.issues[0]?.message}`);
      if (!r.success) throw new ToolError('BAD_RESPONSE', `Not a ${LINK_VERSION} response: ${r.error.issues[0]?.message}`);
      // Verification is about the call that was made, under its own client id.
      const state = { ...clientState(config), id: c.data.body.client };
      return accepts(state, c.data, r.data);
    },
  }),

  defineTool({
    name: 'lean_relay_seal',
    title: 'Seal a result into a relay envelope',
    description:
      "Encrypt a task result into a Kant zk-relay envelope exactly as lean-worker's template specifies (AES-256-GCM, key SHA256(task:salt)), and return it with the agent's room id and the curl command that would post it. Does NOT post: posting is broadcasting and is left to the user (`singularity-lean relay post`). `result` is validated against lean-worker's result_format unless `text` is used instead. Warns when the salt is the public one from the repository, because then the envelope is readable by anyone.",
    shape: {
      task: z.string().describe('Task id, e.g. "agent-a-wave-vi". Part of the key.'),
      salt: z.string().describe('Shared salt for this agent group.'),
      agent: z.string().describe('Your agent id; the room is derived from it.'),
      result: z.record(z.unknown()).optional().describe('A result_format object, e.g. `taskResult` from lean_check.'),
      text: z.string().optional().describe('Arbitrary plaintext instead of `result`.'),
      room: z.string().optional().describe(`Post to this room instead of the agent's derived room, e.g. "agent-zoo-public".`),
    },
    annotations: LOCAL,
    run: ({ task, salt, agent, result, text, room }) => {
      if (!result === !text) throw new ToolError('BAD_ARGS', 'Pass exactly one of `result` or `text`.');
      let plaintext = text ?? '';
      if (result) {
        const parsed = TaskResultSchema.safeParse(result);
        if (!parsed.success) throw new ToolError('BAD_RESULT', `Not lean-worker's result_format: ${parsed.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; ')}`);
        plaintext = JSON.stringify(parsed.data);
      }
      const envelope = seal(plaintext, { task, salt, agent });
      const target = room ?? roomId(salt, agent);
      const warnings = sealedWithPublicSalt(salt)
        ? ['This salt is committed to the public lean-worker repository: anyone can derive the key and read this envelope.']
        : [];
      return { envelope, room: target, relay: DEFAULT_RELAY, post: curlCommand(target, envelope), warnings };
    },
  }),

  defineTool({
    name: 'lean_relay_open',
    title: 'Open a relay envelope',
    description:
      "Decrypt a Kant zk-relay envelope with the shared salt (the task id comes from the envelope), and, when the plaintext is lean-worker's result_format, validate it. A wrong salt and a tampered envelope look the same to AES-GCM; either is reported as WRONG_KEY. The `agent` label in an envelope is not authenticated. Local only.",
    shape: { envelope: z.unknown().describe('{encrypted, iv, tag, agent, task, ts}'), salt: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: ({ envelope, salt }) => {
      const parsed = EnvelopeSchema.safeParse(envelope);
      if (!parsed.success) throw new ToolError('BAD_ENVELOPE', `Not a relay envelope: ${parsed.error.issues[0]?.message}`);
      let plaintext: string;
      try {
        plaintext = open(parsed.data, salt);
      } catch (err) {
        throw new ToolError((err as { code?: string }).code ?? 'WRONG_KEY', (err as Error).message);
      }
      let json: unknown = null;
      try {
        json = JSON.parse(plaintext);
      } catch {
        // Plain text is a valid payload.
      }
      const result = json ? TaskResultSchema.safeParse(json) : null;
      return {
        agent: parsed.data.agent,
        task: parsed.data.task,
        ts: parsed.data.ts,
        plaintext,
        ...(result?.success ? { result: result.data } : {}),
        agentAuthenticated: false,
      };
    },
  }),

  defineTool({
    name: 'lean_relay_read',
    title: 'Read a relay room',
    description:
      "Fetch the envelopes in a Kant zk-relay room (one GET) and, given the salt, decrypt the ones it opens. The public break room is \"agent-zoo-public\". The relay's listing format is undocumented, so anything that is not an envelope is counted in `unreadable` rather than guessed at. A Cloudflare 1042 answer means the relay Worker is not deployed; nothing on this side can fix that.",
    shape: {
      room: z.string().describe('Room id, e.g. "agent-zoo-public" or an agent room like "5ac79509b89fb8b2".'),
      salt: z.string().optional().describe('Decrypt envelopes with this shared salt.'),
      relay: z.string().url().optional().describe(`Relay base URL. Default ${DEFAULT_RELAY}.`),
    },
    annotations: NETWORK_READ,
    run: async ({ room, salt, relay }) => {
      let listing;
      try {
        listing = await readRoom(room, relay ? { base: relay } : {});
      } catch (err) {
        const e = err as Error & { code?: string; hint?: string };
        throw new ToolError(e.code ?? 'RELAY_ERROR', e.message, e.hint);
      }
      const envelopes = listing.envelopes.map((envelope) => {
        if (!salt) return { envelope };
        try {
          return { envelope, plaintext: open(envelope, salt) };
        } catch {
          return { envelope, opened: false };
        }
      });
      return { room, count: envelopes.length, unreadable: listing.unreadable, envelopes, ...(listing.raw !== undefined ? { raw: listing.raw } : {}) };
    },
  }),
];

export const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
