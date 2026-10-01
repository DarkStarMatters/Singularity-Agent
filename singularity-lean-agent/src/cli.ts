#!/usr/bin/env node
/**
 * `singularity-lean` — everything the MCP tools do, plus the steps that need a
 * person: pairing keys, running a node, and posting to the relay.
 *
 * Output is JSON, because every command's answer is a record a script or an
 * agent will read next.
 */
import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NodeQueue } from './node.js';
import { createNodeServer } from './http.js';
import { EnvelopeSchema, postEnvelope, roomId } from './relay.js';
import { LeanRuntime } from './runtime.js';
import {
  type NodeConfig,
  defaultPolicy,
  loadClientConfig,
  loadNodeConfig,
  loadNodeState,
  newKey,
  saveClientConfig,
  saveNodeConfig,
  saveNodeCounters,
  storePaths,
  workerCheckout,
} from './store.js';
import { TOOLS_BY_NAME, ToolError } from './tools.js';
import { VERSION } from './version.js';
import { runProcess } from './lean.js';
import { UPSTREAM } from './wire.js';

const print = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + '\n');

async function tool(name: string, args: Record<string, unknown>): Promise<void> {
  const t = TOOLS_BY_NAME.get(name)!;
  print(await t.run(args));
}

function fail(err: unknown): never {
  const e = err as ToolError & { hint?: string; code?: string };
  process.stderr.write(`${e.code ? `${e.code}: ` : ''}${e.message}\n${e.hint ? `  ${e.hint}\n` : ''}`);
  process.exit(1);
}

const program = new Command()
  .name('singularity-lean')
  .description('Link Singularity Agent to the lean-worker Lean 4 prover.')
  .version(VERSION);

program.command('doctor').description('Toolchain, checkout, keys and (optionally) relay status.')
  .option('--relay', 'also probe the relay')
  .action((o: { relay?: boolean }) => tool('lean_doctor', { relay: o.relay ?? false }));

program.command('check <file>').description('Compile and kernel-check a Lean file.')
  .option('-d, --decl <name...>', 'declarations whose axioms to report')
  .option('-L, --lean-path <dir...>', 'directories of .olean files the file imports')
  .option('-t, --timeout <seconds>', 'timeout', '300')
  .action((file: string, o: { decl?: string[]; leanPath?: string[]; timeout: string }) =>
    tool('lean_check', { path: file, decls: o.decl, leanPath: o.leanPath, timeoutSeconds: Number(o.timeout) }));

program.command('tasks [checkout]').description("List lean-worker tasks and check their relay keys.")
  .action((checkout?: string) => tool('lean_tasks', { checkout }));

const worker = program.command('worker').description('The lean-worker checkout.');

worker.command('fetch [dir]').description(`Clone lean-worker at the commit this link was checked against (${UPSTREAM.commit.slice(0, 7)}).`)
  .action(async (dir?: string) => {
    const target = resolve(dir ?? workerCheckout());
    const steps: Array<[string, string[], string | undefined]> = [
      ['git', ['clone', UPSTREAM.repo, target], undefined],
      ['git', ['checkout', '--detach', UPSTREAM.commit], target],
    ];
    for (const [cmd, args, cwd] of steps) {
      const r = await runProcess(cmd, args, { timeoutMs: 300_000, ...(cwd ? { cwd } : {}) });
      if (r.exitCode !== 0) fail(new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr.trim()}`));
    }
    print({ checkout: target, commit: UPSTREAM.commit });
  });

worker.command('build [checkout]').description('Stage and build the checkout; report each module from the compiler.')
  .option('-g, --groups <group...>', 'core, protocol, proxy, plugin-context, entry')
  .action((checkout: string | undefined, o: { groups?: string[] }) => tool('lean_worker_build', { checkout, groups: o.groups }));

// --------------------------------------------------------------------------- node

const node = program.command('node').description('Run this machine as a prover node.');

node.command('init <id>').description('Create node keys. Defaults: nobody admitted, no executables.')
  .option('--worker <checkout>', 'serve a lean-worker checkout (default)')
  .option('--lake <root>', 'serve a built Lake project instead')
  .action((id: string, o: { worker?: string; lake?: string }) => {
    if (loadNodeConfig()) fail(new Error(`a node is already configured at ${storePaths().node}; remove it to start over`));
    const project: NodeConfig['project'] = o.lake ? { kind: 'lake', root: resolve(o.lake) } : { kind: 'lean-worker', checkout: resolve(o.worker ?? workerCheckout()) };
    saveNodeConfig({ id, key: newKey(), policy: defaultPolicy(), clientKeys: {}, project });
    print({ node: id, project, config: storePaths().node });
  });

node.command('add-peer <clientId>').description('Admit a client. Prints the two keys to give it, over a channel you trust.')
  .action((clientId: string) => {
    const config = loadNodeConfig() ?? fail(new Error('no node configured; run `node init` first'));
    const callKey = config.clientKeys[clientId] ?? newKey();
    const admittedPeers = config.policy.admittedPeers.includes(clientId) ? config.policy.admittedPeers : [...config.policy.admittedPeers, clientId];
    saveNodeConfig({ ...config, clientKeys: { ...config.clientKeys, [clientId]: callKey }, policy: { ...config.policy, admittedPeers } });
    print({
      admitted: clientId,
      giveToClient: { node: config.id, callKey, verifyKey: config.key },
      note: 'verifyKey is this node\'s MAC key: anyone holding it can verify certificates and could also forge them. Share it only with clients you trust as much as the node.',
    });
  });

node.command('serve').description('Serve lean-link/1 over HTTP.')
  .option('-p, --port <port>', 'port', '8651')
  .option('-H, --host <host>', 'interface to bind', '127.0.0.1')
  .action(async (o: { port: string; host: string }) => {
    const config = loadNodeConfig() ?? fail(new Error('no node configured; run `node init` first'));
    const state = loadNodeState()!;
    const runtime = new LeanRuntime(config.project);
    process.stderr.write(`preparing ${config.project.kind} project…\n`);
    await runtime.prepare((line) => process.stderr.write(`  ${line}\n`));
    const queue = new NodeQueue(state, runtime, saveNodeCounters);
    const server = createNodeServer({ queue, version: VERSION, log: (line) => process.stderr.write(`${new Date().toISOString()} ${line}\n`) });
    server.listen(Number(o.port), o.host, () => process.stderr.write(`node ${config.id} serving lean-link/1 on http://${o.host}:${o.port}\n`));
  });

// --------------------------------------------------------------------------- client

const client = program.command('client').description('Call prover nodes from this machine.');

client.command('init <id>').description('Create the client record.')
  .action((id: string) => {
    if (loadClientConfig()) fail(new Error(`a client is already configured at ${storePaths().client}`));
    saveClientConfig({ id, nodes: {}, nextNonce: 0 });
    print({ client: id, config: storePaths().client });
  });

client.command('add-node <nodeId> <url>').description('Pair with a node, using the keys its operator gave you.')
  .requiredOption('--call-key <hex>', 'key for authenticating calls')
  .requiredOption('--verify-key <hex>', "the node's certificate key")
  .action((nodeId: string, url: string, o: { callKey: string; verifyKey: string }) => {
    const config = loadClientConfig() ?? fail(new Error('no client configured; run `client init` first'));
    saveClientConfig({ ...config, nodes: { ...config.nodes, [nodeId]: { url, callKey: o.callKey, verifyKey: o.verifyKey } } });
    print({ paired: nodeId, url });
  });

program.command('prove <node> <module> <decl>').description('Ask a node to kernel-check a declaration.')
  .requiredOption('-s, --source <path>', 'your copy of the module source (its digest is sent)')
  .option('-f, --fuel <seconds>', 'seconds the node may spend', '300')
  .action((nodeId: string, module: string, decl: string, o: { source: string; fuel: string }) =>
    tool('lean_call', { node: nodeId, job: { kind: 'proveGoal', module, decl, sourcePath: o.source }, fuel: Number(o.fuel) }));

// --------------------------------------------------------------------------- relay

const relay = program.command('relay').description('The Kant zk-relay.');

relay.command('seal <task> <resultFile>').description('Seal a result_format JSON file into an envelope (does not post).')
  .requiredOption('--salt <salt>', 'shared salt')
  .requiredOption('--agent <id>', 'your agent id')
  .option('--room <room>', 'room to address instead of the derived one')
  .action((task: string, file: string, o: { salt: string; agent: string; room?: string }) =>
    tool('lean_relay_seal', { task, salt: o.salt, agent: o.agent, room: o.room, result: JSON.parse(readFileSync(resolve(file), 'utf8')) }));

relay.command('open <envelopeFile>').description('Decrypt an envelope.')
  .requiredOption('--salt <salt>', 'shared salt')
  .action((file: string, o: { salt: string }) => tool('lean_relay_open', { envelope: JSON.parse(readFileSync(resolve(file), 'utf8')), salt: o.salt }));

relay.command('read <room>').description('Read a room, decrypting what the salt opens.')
  .option('--salt <salt>', 'shared salt')
  .action((room: string, o: { salt?: string }) => tool('lean_relay_read', { room, salt: o.salt }));

relay.command('post <envelopeFile>').description('Post a sealed envelope. This publishes it; there is no undo.')
  .option('--room <room>', 'room id (default: derived from --salt and the envelope agent)')
  .option('--salt <salt>', 'shared salt, to derive the room')
  .requiredOption('--yes', 'confirm you mean to publish')
  .action(async (file: string, o: { room?: string; salt?: string }) => {
    const envelope = EnvelopeSchema.parse(JSON.parse(readFileSync(resolve(file), 'utf8')));
    const room = o.room ?? (o.salt ? roomId(o.salt, envelope.agent) : fail(new Error('pass --room, or --salt to derive it')));
    print({ room, relayAnswer: await postEnvelope(room, envelope) });
  });

program.parseAsync().catch(fail);
