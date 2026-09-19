<p align="center">
  <img src="web/assets/lockup.png" alt="Singularity-Agent — agentic blockchain, made practical" width="440">
</p>

# Singularity Agent

A universal CLI and MCP plugin for interacting with blockchains — one interface across
**EVM**, **Solana**, **Bitcoin/UTXO**, and **Cosmos**.

Four chain families normally mean four SDKs, four address formats, four sets of field
names, and four ways to be wrong about decimals. Singularity puts one normalized surface
over all of them, for both a human at a terminal and a model over MCP.

**It is read-only and holds no keys.** It can build unsigned transactions for you to sign
in your own wallet; it cannot sign, and it cannot broadcast.

---

## Install

Nothing to clone and nothing to build:

```bash
npx singularity-agent chains
```

Or install it properly, for `singularity` and `singularity-mcp` on your PATH:

```bash
npm install -g singularity-agent
```

### From source

For working on it, or running an unreleased commit:

```bash
npm install
npm run build
npm link          # provides `singularity` and `singularity-mcp`
```

…or with no build step at all:

```bash
npx tsx src/cli/index.ts chains
```

### As a Claude Code plugin

Build first (`npm install && npm run build`) — the plugin runs the compiled server.

The repo is its own single-plugin marketplace, so installing is two steps. Note that the
marketplace path must be in `./path` or absolute form; a bare `.` is rejected.

```bash
claude plugin marketplace add ./Singularity-Agent   # run from the PARENT directory
claude plugin install singularity-agent@singularity
```

Or the same thing from inside a Claude Code session:

```
/plugin marketplace add ./Singularity-Agent
/plugin install singularity-agent@singularity
```

`/plugin install` takes a `plugin-name@marketplace-name` id, never a filesystem path —
passing a path fails with "Marketplace not found".

Verify with `claude plugin list`. To update after a rebuild, bump `version` in both
`.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`, then
`claude plugin update singularity-agent`.

### As a plain MCP server

The quickest route — no clone, no marketplace, no plugin:

```bash
claude mcp add singularity -- npx -y -p singularity-agent singularity-mcp
```

Or add it to any MCP client's config by hand:

```json
{
  "mcpServers": {
    "singularity": {
      "command": "npx",
      "args": ["-y", "-p", "singularity-agent", "singularity-mcp"]
    }
  }
}
```

Running from a clone instead, point it at the built server:

```bash
claude mcp add singularity -- node /absolute/path/to/Singularity-Agent/dist/mcp/server.js
```

Working inside this repo, the committed `.mcp.json` already does this with a relative
path, so Claude Code offers the server on startup with nothing to configure.

---

## Conversational surfaces

Two long-running bots share one brain. Both use the same agent loop
(`src/grok/agent.ts`), the same persona (`src/grok/persona.ts`), and the same
tool catalogue (`src/tools/catalog.ts`) that MCP exposes — so Grok can answer a
chain question by *calling the tools*, not by guessing at a number.

```bash
npm run agent    # both, with Telegram approving the X bot's posts
npm run bot      # Telegram only
npm run x-bot    # X only, publishing on its own switch
```

### Telegram as the control terminal

`npm run agent` runs both halves in one process, which is what lets Telegram
hold the X bot's posts back. Every reply and every scheduled update is composed
as usual and then sent to the control chat as a card showing the exact text and
its character count, with **Post it** / **Discard** buttons. Nothing reaches X
until someone taps.

```
/drafts       re-send every waiting post as a card you can tap
/x status     what it is doing, what is pending, when it next posts
/x pending    the queue, as text with ids
/x post       draft an update now, without waiting for the timer
/x approve <id> · /x reject <id>     the buttons, as commands
/x pause · /x resume                 stop and restart answering mentions
```

`/drafts` exists because an approval card is a message, and messages scroll
away. `/x pending` tells you what is waiting; `/drafts` puts a fresh, tappable
card for each one at the bottom of the chat, where you are already looking.

Approval turns on when a control chat exists: `TELEGRAM_CONTROL_CHAT`, or the
single allowlisted chat when `TELEGRAM_ALLOWED_CHATS` names exactly one. It
refuses to guess between several, because guessing wrong would send drafts —
and the power to publish — to the wrong room. Set `X_REQUIRE_APPROVAL=false` to
let the bot post on its own switch again.

Approval is a second gate, not a bypass of the first: a draft expires after six
hours rather than being posted late, a decided card is rewritten in place so a
double-tap cannot publish twice, and a publish that fails after approval says
so on the card instead of vanishing.

### Telegram

Every tool the CLI and MCP server expose has a bot command, and a test asserts
that mapping so the three cannot drift:

| Command | | Command | |
| --- | --- | --- | --- |
| `/balance` | one address, one chain | `/read` | call a view function |
| `/portfolio` | one address, many chains | `/decode` | decode EVM calldata |
| `/tx` | look up a transaction | `/transfer` | build an **unsigned** transfer |
| `/resolve` | identify an address or hash | `/health` | which chains are serving current state |
| `/fees` | current gas conditions | `/chains` | what is supported |
| `/block` | fetch a block | `/forget` | drop this chat's history |
| `/mint` | what a mint can do to you | `/identity` | is this the real token |
| `/burn` | build an **unsigned** burn | `/verifyburn` | confirm a burn happened |
| `/redeem` | spend a burn, once | | |

`/burn` posts a `solana:` link when `SINGULARITY_PAY_ENDPOINT` names a deployed
`/api/burn` — tap it, approve in your wallet, done. Your wallet supplies the address, and
the memo that makes the burn redeemable is already inside what you approve. Without that
variable set it falls back to handing you an unsigned payload to sign yourself.

The endpoint only builds burns for the mints in `SINGULARITY_BURN_MINTS` (default: this
project's own). An endpoint that will build a burn of anything is a link worth sending to
strangers.

| Where | When it answers conversationally |
| --- | --- |
| DM | every message |
| Group | a command, an @mention of this bot, or a reply to one of its own messages |

Anything else in a group is other people's conversation and is ignored. Replies
are threaded *and* open with an @ping, because a thread line is easy to miss in
a fast group. `/forget` drops what it remembers of a chat.

Mentions are read from Telegram's parsed entities rather than by searching the
text, so `@YourBot` inside a code block or a URL is not a mention.

> **Privacy mode.** BotFather enables it by default, and while it is on your bot
> only *receives* commands and replies to its own messages — @mentions never
> arrive. For the mention path to do anything, run `/setprivacy` → **Disable**.

Model output is sanitized before sending (`src/telegram/html.ts`): a whitelist
of four tags, http(s) links only, and if the markup does not come out balanced
the whole reply is sent as escaped plain text. Telegram rejects a malformed
message outright, so the failure mode being defended against is the user getting
no reply at all.

### X

The listener polls mentions, answers them in thread, and persists a cursor to
`~/.singularity/x-state.json`. On first run it does **not** answer the existing
timeline — it records where the timeline is and starts from there, so switching
it on never fires a burst of replies at old posts.

Replies obey `X_POSTING_ENABLED` exactly as posts do. Left off, the listener
reads mentions, composes answers and logs them without sending: the honest way
to find out what the agent would say before letting it say it.

#### Unprompted project updates

With `X_UPDATE_INTERVAL_HOURS` set (default 4), the listener also posts about
the project on its own. The risk with an agent that posts about itself on a
timer is obvious — it invents a release that never happened — so the model is
never asked "what is new?". It is handed a fact sheet read out of the
repository (the real version, the real chain registry, real commit subjects)
and told that anything not in it does not exist.

Each post is written from a rotating angle — coverage, capability, safety,
changelog, roadmap, philosophy — and angles used recently are excluded, so six
posts cover six different things before any repeats.

The roadmap angle reads `roadmap.md` and hands the model two clearly separated
lists: what the Shipped section claims exists, and the phase headings that are
only planned. The labelling is emphatic on purpose — an agent announcing a
planned feature as a built one is the specific way a project update becomes a
false claim. That rotation still comes round
within a day, so the last dozen posts are also fed back into the prompt as "do
not say these again", and a post that still overlaps a recent one by more than
60% of its content words is dropped rather than published. The changelog angle is skipped
entirely when there are no commits to report, and a model that returns nothing
posts nothing: an empty completion means "nothing to say", never the chat
fallback. Real output, all five angles, from this repo:

```
[coverage]   Reaches 28 chains: ethereum, base, arbitrum, solana, bitcoin, cosmoshub.
[capability] Get balances across many chains with one request.
[safety]     Singularity reads public chain data only. It builds unsigned transfers
             for you to sign in your own wallet but holds no keys and cannot sign
             or broadcast.
[changelog]  v0.0.2 answers mentions and replies on Telegram and X.
```

The same thing is available on demand through elizaOS as `POST_PROJECT_UPDATE`
("post an update about what chains we support"), sharing the grounding code, so
an agent cannot talk its way past it either.

#### The spam filter

Every reply costs an xAI completion (several, with tool calls) plus one of the
few writes the tier allows. So mentions are screened **before** the model is
called, and the default is silence.

The rule that carries it: a cold mention must be **on topic** — naming a chain,
an asset, an address, or a hash. A question mark does not qualify, because
"can I get a follow back?" is a question with nothing to answer.

That ordering is empirical. Measured against this account's real mentions, a
filter built on account age and follower count let **20 of 25** through: the
accounts farming engagement are years old with six-figure follower counts, and
the genuinely new accounts were the honest ones. Those signals are kept only for
the zero-audience throwaway case, and nothing rests on them. With the on-topic
rule and an engagement-farming phrase list, the same 25 mentions score **0
replies** while genuine questions still pass.

On top of the classifier sit hard caps — `X_MAX_REPLIES_PER_HOUR` and
`X_MAX_REPLIES_PER_AUTHOR_PER_HOUR` — which see the pattern the classifier
cannot: no single account can monopolize the budget, and a coordinated flood
cannot drain it in one poll. Spam is rejected *before* it charges against the
cap, so a flood cannot lock out the real questions arriving in the same window.

Every skip is logged with its reason. Silence you cannot explain is
indistinguishable from a broken bot.

---

## As an elizaOS agent

`singularity-agent/eliza` exports a plugin that gives an [elizaOS](https://elizaos.ai)
agent three things at once: the chain lookups, a gated X posting action, and Grok as
the model behind `runtime.useModel()`.

```ts
// src/index.ts of your elizaOS project
import { singularityPlugin, singularityCharacter } from 'singularity-agent/eliza';

export default {
  agents: [{ character: singularityCharacter, plugins: [singularityPlugin] }],
};
```

`@elizaos/core` is an *optional peer* dependency and is imported for types only — the
plugin is a plain object of functions, so the CLI and the MCP server never pull the
framework in. Install it in the project that runs the agent.

### What it registers

| Action | Fires on |
| --- | --- |
| `SINGULARITY_BALANCE` | an address or name plus at most one chain |
| `SINGULARITY_PORTFOLIO` | an address or name plus several chains, or a general holdings question |
| `SINGULARITY_TRANSACTION` | a transaction hash |
| `SINGULARITY_RESOLVE` | "what is this string" |
| `SINGULARITY_FEES` | a named chain plus a fee/gas word |
| `SINGULARITY_BLOCK` | a named chain plus a block/height word |
| `SINGULARITY_CHAINS` | a bare "what do you support" |
| `SINGULARITY_BUILD_TRANSFER` | a chain, a recipient and an amount — returns an **unsigned** draft |
| `POST_TO_X` | "post", "tweet", "publish" — see the gate below |
| `POST_PROJECT_UPDATE` | "post an update", "announce" — grounded in repo facts |

Two providers run before each reply: `SINGULARITY_CHAINS` tells the model which chain
ids actually exist, and `X_POSTING_STATUS` tells it whether a post will really go out,
so it cannot report a draft as published.

Every action goes through `src/tools/operations.ts`, the same layer the CLI and MCP
server use, so a chain added to the registry appears in the agent with no code change.

### Posting is off by default

Publishing is public and effectively irreversible, so three gates stand in front of it:

1. **Credentials.** Without all four OAuth 1.0a values `POST_TO_X` fails `validate`, so
   the agent is never offered it and cannot promise a post it can't make.
2. **`X_POSTING_ENABLED` must be exactly `"true"`.** Not `1`, not `yes`, not `on`.
   Anything else drafts the post, shows it, and sends nothing.
3. **`dryRun`** in the handler options forces a draft regardless of 1 and 2.

A draft comes back as a *successful* result carrying the text and a reason — drafting is
the designed outcome, not a failure, so the agent reports it instead of retrying.

Text the user wrote themselves is published verbatim: `post: …` or a quoted string skips
the model entirely. Only a described post (`post something about base fees`) is drafted
through Grok, and an over-length draft is reported rather than truncated.

### Grok

The plugin registers `TEXT_SMALL` and `TEXT_LARGE` at priority 100, so an agent that
also loads another model provider still thinks with Grok. Set `XAI_API_KEY`; optionally
point `XAI_SMALL_MODEL` at a cheaper model for the high-frequency calls, leaving
`XAI_MODEL` for the ones that write posts. Credentials are read from the runtime's
settings first (a character's `secrets` block) and fall back to the environment.

---

## Quick tour

```bash
# What is this string? Works for addresses, tx hashes, ENS/SNS names.
singularity resolve vitalik.eth

# Balances on one chain — names and aliases accepted.
singularity balance vitalik.eth --chain ethereum

# The same balances as of a past block, or nothing at all.
singularity balance vitalik.eth --chain ethereum --at-block 19000000

# One address across every chain its format is valid on.
singularity portfolio 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045

# A transaction, searched across chains when you don't say which.
singularity tx 0xc29d74412da1bec4e662a7978c3ef993beed7833219d3362a2abca09700fdaa5

# ...or name the chain to skip the search.
singularity tx <txid> --chain bitcoin

# Fee conditions, normalized to "what a simple transfer costs".
singularity fees --chain bitcoin

# Turn opaque calldata into a function call.
singularity decode 0xa9059cbb000000000000000000000000d8da6bf26964af9d7eed9e03e534\
15d37aa9604500000000000000000000000000000000000000000000000000000000000f4240

# Build an UNSIGNED transfer for your own wallet to sign.
singularity build --chain base --to vitalik.eth --amount 25.5 --token USDC

# What can this mint still do to you? Authorities, extensions, who holds each.
singularity mint 5pTy48gtfzaR8NPUVZTbybVUGpQvFT4JsNHzwQE8pump

# Is this the real one? --fetch also reads the accounts the mint declares.
singularity identity 5pTy48gtfzaR8NPUVZTbybVUGpQvFT4JsNHzwQE8pump --fetch

# Build an UNSIGNED burn. Nothing receives these; they stop existing.
singularity burn --mint <mint> --amount 1000 --owner <your wallet>

# Confirm a burn happened, and that it was the mint you expected.
singularity verify-burn <signature> --mint <mint>

# Which chains are actually producing blocks, not just answering?
singularity doctor
singularity doctor --endpoints          # every endpoint, not only the broken ones
```

Add `--json` to any command for machine-readable output.

---

## MCP tools

| Tool | What it does |
| --- | --- |
| `chains` | List supported chains, with families, ids, aliases, native assets. |
| `resolve` | Identify an address / tx hash / name and which chains it belongs to. |
| `balance` | Native + token balances on one chain, now or `atBlock`, with a `completeness` saying what the list covers. Takes a `budget`. |
| `portfolio` | One address across many chains in parallel. Takes a `budget`, applied per chain. |
| `transaction` | Fetch and normalize a transaction, decoding EVM calldata. |
| `block` | A block by height, hash, or `latest`. |
| `fees` | Current fee conditions, normalized. |
| `read_contract` | EVM view calls, now or `atBlock`; parsed account data on Solana. |
| `decode` | Decode EVM calldata into a signature and arguments. |
| `history` | What an address has been doing, newest first. Takes a `budget` or an exact `limit`. Reports that it has no answer rather than an empty list when an EVM indexer key is missing. |
| `build_transfer` | Build an **unsigned** transfer payload. |
| `mint_audit` | What a Solana mint permits: authorities, Token-2022 extensions, and who holds each power. |
| `token_identity` | What a mint declares, and whether the declaration can be rewritten later. |
| `build_burn` | Build an **unsigned** burn for the holder to sign. |
| `verify_burn` | Confirm a burn from its signature, and check it against a claim. |

Every tool is annotated `readOnlyHint: true`. Errors come back as structured results
carrying a code and a hint, rather than as transport exceptions — so a model can correct
itself instead of stalling.

---

## Building applications — `singularity-sdk`

The CLI and the MCP plugin both ask one question and read one answer. An *application*
is different: it runs for weeks, asks the same question four hundred times an hour, and
eventually has to write. [`singularity-sdk`](singularity-sdk/README.md) is that third
caller — a separate package in this repository, versioned separately.

```bash
npm install singularity-sdk singularity-agent
# or start from a project that already runs:
npx singularity-sdk new my-app --template reader
```

```ts
import { createSingularity } from 'singularity-sdk';

const sdk = createSingularity({ chain: 'ethereum', budget: { maxItems: 8 } });

const balance = await sdk.balance({ address: 'vitalik.eth', includeTokens: true });
balance.tokenCompleteness.kind;   // read this before the list

sdk.watch.balance({ address: 'vitalik.eth' }, ({ value, previous }) => {
  if (previous) alert(`${previous.native.amount.formatted} → ${value.native.amount.formatted}`);
});
```

It adds four things a command line does not need: a configured client with a cache that
only holds what is safe to hold, watch primitives, an agent-tool bridge that derives
Anthropic / OpenAI-style / MCP shapes from this repository's one catalogue, and a
scaffolder.

**It does not add a way to sign.** "No signing, ever" below is still literally true of
everything published here. The SDK defines the *port* a write travels through — a
`Signer` interface your application implements against the browser wallet, KMS, hardware
device or approval queue that already holds your keys — and ships no implementation of
it. There is no keypair loader in that package, and a test scans its source to keep that
true. `build` always works; `write` does not exist as a type until you supply a signer:

```ts
const readOnly = createSingularity({ chain: 'ethereum' });
await readOnly.write.transfer({ to: 'vitalik.eth', amount: '0.1' });
//               ~~~~~~~~
// Property 'transfer' does not exist on type 'SignerRequired'.
```

Full documentation: **[singularity-sdk/README.md](singularity-sdk/README.md)**.

---

## What makes it practical

**It figures out what you pasted.** `resolve` distinguishes an EVM address from a Solana
one, a Bitcoin legacy address from a Solana pubkey (base58check checksum, not shape), and
a tx hash from an account. Where a string is genuinely ambiguous — 64 hex characters is a
valid tx hash on Ethereum, Bitcoin, and Cosmos at once — it says so instead of guessing.

**Cosmos prefixes stop being a trap.** `cosmos1…` and `osmo1…` are the same account,
re-encoded. `resolve` lists the equivalents, and using the wrong one hands you the right
one back:

```
INVALID_ADDRESS  "cosmos1qypqx…lzv7xu" is not a valid address on Osmosis.
That is a "cosmos" address. It is the same account on Osmosis, re-encoded:
osmo1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5helwsw
```

**Amounts are never floats.** Everything is `bigint` end to end, and every balance is
returned as both raw base units and a formatted string. Dust never renders as `0`, and
`parseUnits` refuses to silently drop precision rather than quietly sending the wrong
amount.

**Public RPCs are assumed to be flaky, and so is the chain behind them.** Every endpoint
list fails over in order, and `doctor` asks the question reachability does not: is this
chain still producing blocks? A halted chain answers every request, with the correct chain
id, serving the last block it ever made — so it reads as healthy while every balance taken
from it is historical state with nothing marking it as historical. `doctor` probes each
endpoint separately, which also surfaces the endpoint that answers but lags, and the chain
whose second endpoint quietly stopped working.

**Errors carry hints.** An unknown chain suggests near misses; a rate-limited endpoint
names the env var to override.

---

## Configuration

### RPC endpoints

Public endpoints work out of the box but are heavily rate-limited. Override per chain:

```bash
export SINGULARITY_RPC_ETHEREUM=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
export SINGULARITY_RPC_BASE=https://base-mainnet.g.alchemy.com/v2/YOUR_KEY

# Comma-separated for failover:
export SINGULARITY_RPC_SOLANA=https://primary.example,https://backup.example
```

The variable name is `SINGULARITY_RPC_` + the chain id, uppercased, with `-` → `_`
(so `base-sepolia` becomes `SINGULARITY_RPC_BASE_SEPOLIA`).

### Config file

`~/.singularity/config.json` (or `$SINGULARITY_CONFIG`):

```json
{
  "chains": [
    {
      "id": "my-rollup",
      "name": "My Rollup",
      "family": "evm",
      "chainId": 123456,
      "nativeCurrency": { "name": "Ether", "symbol": "ETH", "decimals": 18 },
      "rpc": ["https://rpc.my-rollup.example"],
      "explorer": "https://explorer.my-rollup.example"
    }
  ],
  "addressBook": {
    "treasury": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    "payroll": { "target": "payroll.eth", "pin": "0x00000000219ab540356cBB839Cbe05303d7705Fa" }
  },
  "portfolioChains": ["ethereum", "base", "solana"]
}
```

Entries whose `id` matches a built-in chain patch it; new ids add a chain. Address-book
names work anywhere an address is accepted:

```bash
singularity balance treasury --chain base
```

**Pinning an alias.** The object form adds a `pin`: the address the alias must come out
as. A pinned alias never yields anything else — a resolution landing elsewhere raises
`ALIAS_PIN_MISMATCH` rather than answering, and a target that resolves to nothing raises
`ALIAS_PIN_UNVERIFIED` rather than falling back to the pin. There is no branch that
reports the new address with a warning attached, because a result carrying the new address
*is* the failure.

Worth pinning when the target is a name: ENS and SNS registrations expire, get
re-registered by whoever watched the drop, and carry address records the current owner can
rewrite. A pin also covers the config file itself, which is why `{ "target": "0x…",
"pin": "0x…" }` with both the same is a reasonable thing to write. Unpinned aliases are
unchanged and still follow their name wherever it points — `resolve` now says which kind
it expanded, either way.

---

## Supported chains

Thirty-two: twenty-eight mainnets and four testnets. Every mainnet answers from at least
two verified endpoints, and a test holds it there.

**EVM** (18) — Ethereum, Base, Arbitrum One, OP Mainnet, Polygon PoS, BNB Smart Chain,
Avalanche C-Chain, Gnosis, Scroll, Linea, ZKsync Era, Blast, Mantle, Mode, Fraxtal, opBNB,
plus Sepolia and Base Sepolia. Any other EVM chain works via the config file.

**Solana** (2) — mainnet-beta, devnet.

**UTXO** (3) — Bitcoin, Litecoin, Bitcoin testnet.

**Cosmos** (9) — Cosmos Hub, Osmosis, Celestia, Injective, dYdX, Sei, Neutron, Stride,
Kava.

Not included, on purpose: **Polygon zkEVM**, whose endpoints answer with a head block
seventy-six days old — a stopped chain returns history wearing a current-state label.
**Dogecoin and Bitcoin Cash**, because the UTXO adapter speaks Esplora and neither has a
public Esplora-compatible endpoint. Both ship when they can meet the same bar as the rest,
or not at all.

---

## Known limits

These are real boundaries, not bugs — worth knowing before you rely on a result.

- **EVM token balances are a curated scan, not an enumeration.** Listing every token an
  EVM address holds requires an indexer. Without one, `balance` checks a list of major
  tokens per chain; pass `tokens` with explicit contract addresses for anything else. The
  output always says so. Solana and Cosmos *can* enumerate, and do.

  This is not a caveat in prose. Every token scan carries a `completeness` —
  `exhaustive`, `curated`, `truncated` (with counts) or `failed` — and there is no way for
  an adapter to return a list without one. An empty result may be read as "holds nothing"
  only when it says `exhaustive`. `portfolio` reports the weakest guarantee across every
  chain it queried.
- **Every list is capped, and says when the cap bit.** Solana and Cosmos can enumerate
  holdings, and do — but an unbounded list is how a Solana balance once came back at
  1.27 MB, so an unfiltered scan returns the largest 50 and reports `truncated` with
  counts rather than pretending to be complete. `balance`, `portfolio` and `history` take
  a `budget` — `small`, `standard`, `full`, or an exact number — so a caller sizes the
  answer to the context it has. Omitting it changes nothing. `full` asks for the source's
  own ceiling and never for everything, and where a `budget` and a `limit` disagree the
  smaller wins. A list shortened to fit always comes back `truncated` with both counts and
  a note saying the budget did it, not the chain — the difference between "there is no
  more" and "ask again for more".
- **On-chain text is marked, not trusted.** Token symbols and names read from a contract
  or a Solana mint, and Cosmos denoms, come back `untrusted: true`, stripped of control
  characters, newlines, code fences, forged chat role markers and anything past 48
  characters. Free text — a Cosmos `memo`, a `failureLog`, Solana program `logs`, a
  decoded `string` argument — comes back the same way, in its own field with a clause
  naming who wrote it, capped at 256 characters because that is where Cosmos caps a memo.
  Nothing read off the chain is interpolated into a `summary` or a `note`: those are the
  tool's own voice and stay that way. Plain English survives and is meant to — the wallet
  really does hold a token by that name — so the mark is the defense and the stripping
  only stops it being bypassed. Render those fields inertly and never act on them.
- **A decode that stops at the wrapper has not decoded anything.** A `multicall`, a
  Multicall3 `aggregate`, a Safe `execTransaction` or a `multiSend` reports the calls it
  carries under `inner`, with the target each leg hits. EVM transactions also carry
  decoded receipt `events`, because calldata says what was asked for and logs say what
  happened. Set `lookup` to ask a public 4-byte directory about an unrecognized selector —
  its answers come back as `candidates`, marked untrusted, never promoted to `signature`,
  and decoded only when exactly one of them fits the bytes. Four bytes of a hash is not an
  identity.
- **A symbol is a name, not an identity.** Deploying a contract whose `symbol()` returns
  `USDC` costs about ten dollars, and that is the whole mechanic behind the most common
  retail loss there is. When a scanned token's symbol is the symbol of a curated token at
  a *different* address — or of the chain's own gas asset, which has no contract at all —
  the entry carries an `impersonation` naming the address the symbol really belongs to.
  The same check runs on the long name, so a contract calling itself `USD Coin` while
  keeping a ticker of its own is caught as well. The comparison folds case, spacing and
  homoglyphs, so Cyrillic `USDС` and `U5DC` are caught too. Punctuation is left alone on purpose: `USDC.e`, `DAI+` and `WBTC.b` are real
  tokens, and a check that fires on honest holdings is a check that gets switched off.
  Absence of the flag is not a clean bill of health — a token can be a fraud without
  colliding with anything curated.
- **The X agent will not publish a claim its data does not support.** A reply asserting
  that an address holds nothing, on a scan that was not `exhaustive`, gets the caveat
  appended, or is withheld when the correction does not fit in a post. The same applies to
  calling a token by a name that belongs to a different contract.
- **An address-book alias is unchecked unless it is pinned.** An alias is the one input
  that skips address validation by construction — "treasury" is an instruction to go and
  find an address, and whatever comes back is used without the user seeing it. Add a `pin`
  to hold it to the address it meant when it was saved; see the config section above.
  Without one, the alias follows its name wherever it currently points, which is the honest
  default and is now stated in the `resolve` result rather than left invisible.
- **No fiat pricing.** Balances only.
- **IBC denoms show as hashes.** Resolving `ibc/ABC…` to its origin asset needs a
  denom-trace lookup per token; the hash is shown rather than a wrong guess, and decimals
  are assumed to be 6.
- **Cosmos fees use a default gas price.** Cosmos gas prices are per-validator, not
  per-chain. Your wallet will usually re-quote.
- **The Bitcoin builder uses largest-first coin selection.** Fewest inputs, lowest fee,
  but not privacy-optimal.
- **No CosmWasm queries.** `read_contract` covers EVM and Solana only.
- **Solana history is pruned** on public RPCs; older signatures need an archival endpoint.
- **`atBlock` is EVM and Cosmos only.** Solana RPC addresses account state by commitment
  rather than by slot, and Esplora has no balance-at-height query, so both families reject
  `atBlock` outright. That is deliberate: a result carrying `atBlock` is always genuinely
  historical, never current state wearing a past label. On EVM and Cosmos the endpoint has
  to be archival, and a pruned one returns `HISTORICAL_STATE_UNAVAILABLE` rather than
  falling back to now.

---

## Development

```bash
npm run typecheck
npm test
npm run dev -- chains        # run the CLI from source
npm run mcp                  # run the MCP server from source
npm run bot                  # run the Telegram bot from source
```

Architecture:

```
src/core/       normalized types, chain registry, formatting, bech32/base58 codecs
src/adapters/   one adapter per family, all implementing ChainAdapter
src/tools/      operations, plus the tool catalogue every model front end reads
src/mcp/        MCP server
src/cli/        CLI and terminal rendering
src/grok/       xAI client, agent loop, persona, conversation memory
src/telegram/   Telegram bot: engagement rules, HTML sanitizing
src/x/          X client, OAuth 1.0a signing, mention listener, spam filter
src/eliza/      elizaOS plugin, character and Grok model handlers
```

`src/tools/catalog.ts` is the single definition of every tool — name,
description and argument schema. The MCP server registers from it, and
`src/grok/tools.ts` converts the same zod shapes into function-calling schemas.
Improving a description improves it everywhere at once, which is the point.

`src/eliza/` compiles in a second pass (`tsconfig.eliza.json`) because `@elizaos/core`
ships declaration files with extensionless imports under `"type": "module"`, which
NodeNext cannot resolve. The rest of the project keeps NodeNext, so missing `.js`
extensions are still caught at build time. `npm run build` and `npm run typecheck` run
both passes.

Adding a chain family means implementing `ChainAdapter` (`src/core/adapter.ts`) and
registering it in `src/adapters/index.ts`. Anything a family genuinely cannot do throws
`UnsupportedOperationError` rather than returning an empty result — a silent `[]` reads as
"no tokens" and gets repeated as fact.

## Documentation site

A beginner-facing guide lives in `web/` — a static, zero-build page deployed on Vercel.
`vercel.json` at the repo root already points at it, so importing this repo into Vercel
needs no further configuration. To preview it locally:

```bash
cd web && python -m http.server 8000
```

## License

MIT
