# Singularity Agent v0.7.1

**Two wrong answers, found by the build rather than by a person, and the build that
will find the next one.**

```bash
npm install singularity-agent
```

Every serious bug this project has shipped had the same shape. The code was right about
what it did and wrong about what it claimed: a list cut without saying so, a failed read
reported as "nothing there", a hash "not found" on chains that never answered. None
crashed, and a person caught every one. This release turns the claims into code, holds
every tool to them under generated failures, and runs that in CI. The first two runs
found two more.

`singularity-sdk` stays at **v0.2.0**. Its peer range now asks for v0.7.1.

---

## Fixed: `inspect_payment` called a real mint missing

With every Solana endpoint down, checking a USDC invoice returned **"No SPL mint
exists"** at USDC's address and a verdict of `unpayable`. That is exactly what it says
about a mint that is really not there. The cause was eight reads in the Solana adapter
that turned a failed call into `null`, and `null` into an absence:

- the mint;
- the payee's account (in the inspection and in both transaction builders);
- the payer's token account;
- the balance a payment simulation starts from;
- the status lookup `verify_burn` uses to tell "not finalized yet" from "does not
  exist".

They now fail over to the next endpoint. When none answers, the verdict is `unproven`
and the reason says the chain could not be read. Every release up to v0.7.0 had this.

## Fixed: `mesh` answered from a scan that failed

Asked for `holdings` while the token scan was failing, `mesh` returned
`verdict: "answered"`. It had counted an empty token list as proof, even though that
list's own completeness said `failed`. A read that says it failed now proves nothing.
The fact goes to `unproven` with the scan's reason, and the verdict is `partial`.

---

## The claims, as code

`src/core/invariants.ts` states six claims, and the package exports the checks for
them:

- A list that was cut says so, with both counts.
- A failed read never becomes an empty result.
- A chain is never reported as searched unless it answered.
- A total exists only where the units are identical.
- An absence is never reported as fact without a completeness that supports it.
- Every unsigned payload states that it is unsigned.

`checkShape(response)` needs nothing but a response, so an application can check what it
receives against the same claims:

```ts
import { checkShape } from 'singularity-agent';

const violations = checkShape(result);
if (violations.length) console.warn(violations);
```

Unsigned payloads now carry **`unsigned: true`** as a required field. Whether a payload
is signed used to be something you inferred from `signingHint`; now it is stated.

## Every tool, against every way a read can fail

Three [fast-check](https://fast-check.dev) suites run all twenty-three tools through
their catalogue entries, as the MCP server calls them. They run against generated EVM
adapters, a faked Solana connection, and a 4-byte directory that anyone can write to. A
read can answer, come back empty, come back cut, time out or say "not here", and every
output is checked against the claims. To prove each property can fail, a bug was put
back by hand and the property had to fail on it. Both fixes above were found this way,
on each suite's first run.

## CI

`.github/workflows/ci.yml` runs on every push to `main` and every pull request:

- the build of the agent and the SDK;
- the three typechecks;
- every vitest suite, on Node 20, 22 and 24, plus Node 22 on Windows;
- quantum-agent's pytest suite.

`.gitattributes` now pins LF line endings, because a Windows checkout had been failing
two tests that CI would pass.

One thing CI cannot do yet is stop a bad change from merging. Commits land directly on
`main`, so a failure is reported after the push. Making it a gate needs branch
protection on GitHub.

---

23 tools, 33 chains, 35 bot commands. Read-only throughout: no keys, no signing, no
broadcasting.
