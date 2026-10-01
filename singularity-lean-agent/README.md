# singularity-lean-agent

Links Singularity Agent to [lean-worker](https://github.com/meta-introspector/lean-worker),
the Lean 4 "gokujo" worker: a formal twin model of an agent, and a protocol for
**certified calls to a Lean prover**. This is the third plugin in the `singularity`
marketplace.

It does three things:

1. **Checks Lean with the kernel, not with grep.** `lean_check` compiles a file and reports
   the axioms each named theorem depends on. "Proved" means it compiled with no errors and
   no `sorryAx` among those axioms.
2. **Runs lean-worker's prover protocol between real machines.** lean-worker's
   `Protocol.Server` and `Protocol.Client` are ported line for line (`src/node.ts`,
   `src/client.ts`). They use a byte-exact wire format, **lean-link/1**, with HMAC-SHA256
   tags. A node certifies `proveGoal` / `checkProof` / `runExe` jobs. A client accepts a
   certificate only when all of these hold: the tag verifies, the certificate names this
   client, that node, this nonce and the exact job, and the kernel checked the result.
3. **Speaks the Kant zk-relay envelope** exactly as lean-worker's `tasks/template.json`
   specifies it, to seal and open envelopes and to read rooms. It never posts on its own.

It lives beside Singularity rather than inside it for the same reason `quantum-agent` does.
Singularity promises that it holds no keys and moves nothing. This plugin runs a compiler,
holds HMAC keys, and talks to a relay.

## Assessment of lean-worker (at `6391a90`, 2026-09-20)

Everything below was checked by building the repository, not by reading its README.

| Claim / part | What the kernel says |
|---|---|
| Twin model, protocol layer, proxy layer (19 modules) | **All build** under the pinned Lean 4.28.0 with no Mathlib: 178 theorems, 0 `sorry` |
| `lake build` / `lean *.lean` (README) | **Fail at the first import.** Modules import `RequestProject.X`, but the files sit flat in `minimal/` and the lakefile names a `Minimal` library |
| 45 plugin contexts (`contexts/plugins/`, agent-c wave XIII) | **0 of 45 compile.** Each fails with `unknown tactic` / unsolved goals. One "proves" `commands.length > 0` for an empty list with `exFalso`. The grep-based "0 sorrys" passes them anyway |
| `Main.lean` | Imports all of Mathlib and uses none of it. Skipped |
| "82 theorems" (README) | Out of date: the library now has 178 kernel-checked theorems |
| Relay encryption | Key and room derivations match `agent-a.json` / `agent-b.json` exactly. But the shared salt is committed to the public repo, so **anyone can decrypt every envelope**, and the `agent` field is unauthenticated |
| Kant zk-relay | **Down.** Every endpoint answers Cloudflare `error code: 1042` (Worker not deployed) |
| "Gokujo knife set" invites (`data/break-room/`) | Not in the repository |
| `Proxy.Interop` | Pins vectors against a Python `proxy/receipts.py` that is not in the repository |

The protocol model is the strongest part. `Protocol.Server` proves admission, replay
protection and fuel invariants, and `Protocol.Client` proves unforgeability and tamper
resistance under an idealised tag. That is why the link is built on it. `lean_worker_build`
reruns this assessment against any checkout.

## lean-link/1

```
POST /call   {"v":"lean-link/1","call":{body, auth, argv?}}  →  {"v":"lean-link/1","response":…}
GET  /health, GET /info
```

- Each field is encoded as `<utf8-bytes>:<text>,`, in a fixed order with a `call` / `cert`
  domain tag. This is defined in `src/wire.ts` and `lean/SingularityLean/Wire.lean`. The Lean
  side kernel-checks the vectors and proves `call_ne_cert`: no call encoding ever equals a
  certificate encoding.
- A tag is HMAC-SHA256 under a 32-byte hex key. Digests are lowercase SHA-256 hex. Fuel is
  measured in seconds of wall-clock time.
- `vectors/link-v1.json` is the contract. `test/vectors.test.ts` holds the TypeScript, the
  Lean file and the JSON identical. The MACs and the relay envelope were cross-checked
  against Python's `hmac` and `cryptography` (the library upstream names).
- Any change to an encoding is lean-link/2, not a patch.

The MAC is symmetric. A client verifies certificates with the node's key, so anything
holding that key could also forge certificates. Give it only to clients you trust as much
as the node.

## Tools

| Tool | What it does | Touches |
|---|---|---|
| `lean_doctor` | Toolchain versions, checkout, node/client config, optional relay probe | local / relay GET |
| `lean_check` | Compile and kernel-check a file or source; axioms per declaration; result in lean-worker's `result_format` | local Lean |
| `lean_worker_build` | Stage and build a lean-worker checkout, reporting each module from the compiler | local Lean |
| `lean_tasks` | List task files, recompute every room id and key | local files |
| `lean_call` | One certified call to a paired node, with every acceptance check named | prover node |
| `lean_verify_certificate` | Verify a certificate against its call, offline | none |
| `lean_relay_seal` | Seal a result into an envelope and return the `curl` that would post it | none |
| `lean_relay_open` | Decrypt an envelope and validate `result_format` | none |
| `lean_relay_read` | Read a room and decrypt what the salt opens | relay GET |

Compiling Lean can execute code the file contains (`#eval`, macros). Check files you
would compile yourself.

## Setup

```bash
npm install && npm run build -w singularity-lean-agent
claude plugin install singularity-lean-agent@singularity

npx singularity-lean worker fetch      # clones lean-worker at the pinned commit
npx singularity-lean worker build      # ~1 min; installs Lean 4.28.0 via elan if needed
npx singularity-lean doctor
```

Running a node and pairing a client (keys live in `~/.singularity/lean-link/`, or in
`SINGULARITY_LEAN_HOME`):

```bash
# on the node
singularity-lean node init my-node            # serves the lean-worker checkout; --lake <root> for a Lake project
singularity-lean node add-peer singularity    # prints callKey + verifyKey for the client
singularity-lean node serve                   # 127.0.0.1:8651

# on the client
singularity-lean client init singularity
singularity-lean client add-node my-node http://127.0.0.1:8651 --call-key … --verify-key …
singularity-lean prove my-node RequestProject.Protocol.Server P2P.replay_rejected \
  --source lean-worker/minimal/Protocol/Server.lean
```

A new node admits nobody and runs no executables. `runExe` needs a Lake project, and
`allowExeCalls` plus an allow-list in `node.json`.

Posting to the relay is a separate, explicit step:
`singularity-lean relay post envelope.json --salt … --yes`.

## Tests

`npm test` at the repository root runs these with the rest of Singularity. The tests that
need Lean skip when it isn't installed. `npm run lean -w singularity-lean-agent` builds the
Lean side.

License: MIT. lean-worker is AGPL-3.0. Nothing from it is vendored here. The link talks to
its protocol and builds a checkout you fetch.
