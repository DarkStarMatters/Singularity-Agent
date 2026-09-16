/**
 * Posting project updates to X, unprompted.
 *
 * An agent that posts about itself on a timer is one bad prompt away from
 * inventing a release that never happened, so the design constraint here is
 * grounding: the model is never asked "what is new with Singularity?". It is
 * handed a set of facts read out of the repository — the real version, the real
 * chain count, real commit subjects — and asked to write one post using only
 * those. Nothing it cannot see is available for it to embellish.
 *
 * The second constraint is not being boring. A bot that posts the same sentence
 * every six hours is worse than one that says nothing, so each post is written
 * from a rotating angle, and the angles used recently are excluded.
 *
 * Posting obeys `X_POSTING_ENABLED` like everything else, so with the switch off
 * this composes updates and logs them, which is how you find out whether the
 * voice is right before it is public.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { allChains } from '../core/registry.js';
import { TOOLS } from '../tools/catalog.js';
import { VERSION } from '../version.js';
import type { GrokAgent } from '../grok/agent.js';
import type { PostResult, XClient } from './client.js';
import { REPLY_LIMIT, fitReply } from './listener.js';

export interface ProjectFacts {
  version: string;
  chainCount: number;
  /** Chain ids grouped by family, so a post can name real chains. */
  byFamily: Record<string, string[]>;
  toolCount: number;
  capabilities: string[];
  /** Recent commit subjects, when running from a git checkout. */
  recentChanges: string[];
  /** Claims from the roadmap's "Shipped" section — what actually exists. */
  shipped: string[];
  /** Headings from the roadmap's later phases — what is planned, not promised. */
  planned: string[];
  /** One entry per supported chain, with the details that make it specific. */
  chains: ChainNote[];
  /** One entry per tool: what it is for, and what it refuses to do. */
  tools: ToolNote[];
  /** The README's "Known limits" — the honest list of what this will not do. */
  limits: Array<{ label: string; detail: string }>;
  /** Real commands from the README's quick tour, with what each is for. */
  recipes: Array<{ purpose: string; command: string }>;
}

export interface ChainNote {
  id: string;
  name: string;
  family: string;
  /** The things about this chain that are worth a post on their own. */
  details: string[];
}

export interface ToolNote {
  name: string;
  title: string;
  description: string;
}

/**
 * The angles a post can be written from.
 *
 * Ordered most practical first, and that ordering is load-bearing: `nextUpdate`
 * prefers the earliest unused angle, so the account leads with things a reader
 * can use and reaches the self-describing ones last.
 *
 * The originals were `coverage`, `capability`, `safety`, `changelog`, `roadmap`,
 * `philosophy` — six ways of talking *about the project*, over facts that never
 * changed. "23 chains across four families" is the same sentence every time it
 * comes round, so six angles meant roughly six posts and the rotation only set
 * the interval at which they repeated. `coverage` and `safety` are gone as
 * angles for exactly that reason: they became `chainnote` (one specific chain,
 * not the count) and `limitation` (one specific thing it refuses to do).
 */
export const UPDATE_ANGLES = [
  'howto',
  'gotcha',
  'chainnote',
  'limitation',
  'capability',
  'changelog',
  'teardown',
  'roadmap',
  'philosophy',
] as const;

export type UpdateAngle = (typeof UPDATE_ANGLES)[number];

const ANGLE_BRIEFS: Record<UpdateAngle, string> = {
  howto:
    'A recipe. Show the exact command from the facts and say in one line what it gives back. Someone should be able to paste it. Do not alter the command.',
  gotcha:
    'A trap this handles for you. Name the specific mistake and what happens instead of a wrong answer. Useful to someone who has hit it, not a boast.',
  chainnote:
    'One concrete thing about this ONE chain — what it is called, what its addresses look like, what it can and cannot enumerate. Do not list other chains, and do not give a total count.',
  limitation:
    'One thing this deliberately will not do, and why that is the right call. State it plainly, as a fact about the tool, not an apology. Do not pair it with a promise to fix it.',
  capability:
    'One tool: what question it answers and what it refuses to do. Concrete, not a feature dump.',
  changelog:
    'What changed recently, using only the listed commit subjects. If the list is empty, do not write about changes at all — return an empty line.',
  teardown:
    'Explain the mechanism behind one shipped guarantee — how it actually works, in one breath. Assume the reader is technical.',
  roadmap:
    'One thing the project has shipped, drawn from the Shipped list. You may mention a planned area, but say plainly that it is planned and not built. Never describe a planned item as if it exists.',
  philosophy:
    'Why a chain-agnostic, read-only tool is the right shape. No numbers unless they appear in the facts.',
};

/**
 * Facts read from the repository, not from the model.
 *
 * Everything here is checkable: the version is the one in package.json, the
 * chains are the ones actually in the registry, the commits are real subjects
 * from the log.
 */
export function collectProjectFacts(repoRoot = process.cwd()): ProjectFacts {
  const chains = allChains();
  const byFamily: Record<string, string[]> = {};

  for (const chain of chains) {
    (byFamily[chain.family] ??= []).push(chain.id);
  }

  const { shipped, planned } = readRoadmap(repoRoot);

  return {
    version: VERSION,
    chainCount: chains.length,
    byFamily,
    toolCount: TOOLS.length,
    capabilities: TOOLS.map((tool) => tool.title),
    recentChanges: recentCommits(repoRoot),
    shipped,
    planned,
    chains: chains.filter((chain) => !chain.testnet).map(chainNote),
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
    })),
    limits: readKnownLimits(repoRoot),
    recipes: readQuickTour(repoRoot),
  };
}

/**
 * What is worth saying about one chain, beyond its existence.
 *
 * A post that says "we support Osmosis" is worth nothing; the reader already
 * assumed it. What is worth reading is the thing that trips people up on that
 * specific chain, and most of those are properties of the family — so they are
 * derived from the registry rather than hand-written per chain, and stay true
 * as chains are added.
 */
function chainNote(chain: ReturnType<typeof allChains>[number]): ChainNote {
  const details = [
    `${chain.name} — id "${chain.id}", native asset ${chain.nativeCurrency.symbol} with ${chain.nativeCurrency.decimals} decimals`,
    `${chain.rpc.length} RPC endpoint(s) configured, tried in order until one answers`,
  ];

  if (chain.aliases?.length) details.push(`also accepted as: ${chain.aliases.join(', ')}`);
  if (chain.chainId !== undefined) details.push(`chain id ${chain.chainId}`);

  switch (chain.family) {
    case 'evm':
      details.push(
        'EVM token holdings cannot be enumerated without an indexer, so a token scan covers a curated list and says so rather than implying the list is everything',
        'addresses are checksummed 0x + 40 hex; a bad checksum is rejected rather than silently accepted',
      );
      break;
    case 'cosmos':
      details.push(
        `bech32 addresses start "${chain.bech32Prefix}1", base denom ${chain.denom}`,
        'one Cosmos key is one account on every Cosmos chain, just re-encoded — paste the wrong prefix and the error hands back the correctly encoded address rather than just refusing',
        'bank balances DO enumerate fully, unlike EVM, so an empty result really does mean the account holds nothing',
      );
      break;
    case 'svm':
      details.push(
        'token accounts are owned by the wallet, so Solana holdings really can be enumerated in full',
        'a wallet can hold several token accounts for one mint; they are summed rather than listed separately, which is what stops double-counting',
        'anyone can airdrop a token account onto any address, so an active wallet accumulates thousands of dust mints',
      );
      break;
    case 'utxo':
      details.push(
        'no token contracts at all — a UTXO chain has no ERC-20 equivalent, and the scan says that rather than returning an empty list that reads as "holds none"',
        'balance is confirmed plus mempool, so a payment that just landed is not invisible',
      );
      break;
  }

  return { id: chain.id, name: chain.name, family: chain.family, details };
}

/**
 * The README's "Known limits" section.
 *
 * The most practical thing this project can post is what it refuses to do, and
 * that list is already written, already accurate, and already maintained — it
 * just never reached the poster.
 */
export function readKnownLimits(repoRoot: string): Array<{ label: string; detail: string }> {
  const text = readRepoFile(join(repoRoot, 'README.md'));
  if (!text) return [];

  const section = text.split(/^## /m).find((part) => part.startsWith('Known limits')) ?? '';

  return [...section.matchAll(/^- \*\*([^*]+)\*\*\s*([\s\S]*?)(?=\n- \*\*|\n\n|$)/gm)]
    .map(([, label, detail]) => ({
      label: label!.replace(/\.$/, '').trim(),
      detail: detail!.replace(/\s+/g, ' ').trim(),
    }))
    .filter((entry) => entry.detail.length > 20)
    .slice(0, 12);
}

/**
 * Real commands from the README's quick tour.
 *
 * A recipe someone can paste is the single most useful thing a tool account can
 * post, and inventing one risks inventing a flag that does not exist. These are
 * copied verbatim from documentation that is kept working.
 */
export function readQuickTour(repoRoot: string): Array<{ purpose: string; command: string }> {
  const text = readRepoFile(join(repoRoot, 'README.md'));
  if (!text) return [];

  const section = text.split(/^## /m).find((part) => part.startsWith('Quick tour')) ?? '';
  const lines = section.split('\n');
  const recipes: Array<{ purpose: string; command: string }> = [];

  for (let i = 0; i < lines.length - 1; i++) {
    const comment = lines[i]!.trim();
    const command = lines[i + 1]!.trim();
    if (!comment.startsWith('# ') || !command.startsWith('singularity ')) continue;
    // A wrapped command continues on the next line; skip rather than post half of one.
    if (command.endsWith('\\')) continue;

    recipes.push({ purpose: comment.slice(2).trim(), command });
  }

  return recipes;
}

function readRepoFile(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * What the project says about itself, read from `roadmap.md`.
 *
 * Commit subjects describe changes; the roadmap describes capabilities, which
 * is what a reader actually wants from a project update. Both are checkable
 * text in the repository rather than anything the model supplies.
 *
 * The distinction between the two lists is the point. "Shipped" is what exists
 * and may be stated flatly; the phase headings are intentions, and the prompt
 * is told to label them as such — an agent announcing a planned feature as a
 * built one is the specific failure this guards against.
 */
export function readRoadmap(repoRoot: string): { shipped: string[]; planned: string[] } {
  const path = join(repoRoot, 'roadmap.md');
  if (!existsSync(path)) return { shipped: [], planned: [] };

  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { shipped: [], planned: [] };
  }

  // Split rather than match: with the `m` flag `$` matches at every line end,
  // so a lazy `[\s\S]*?` looking for `\n## ` or `$` stops at the first line
  // break and captures nothing. Sections are a structural split, not a regex.
  const sections = text.split(/^## /m);
  const shippedSection = sections.find((section) => section.startsWith('Shipped')) ?? '';

  // Bold lead-ins ("**Coverage.** 23 chains across…") are the section's own
  // summary of each area, which is exactly the granularity of one post.
  //
  // The capture runs to the end of the paragraph, not the end of the line.
  // Stopping at the newline handed the model fragments — one ended on a colon,
  // and it obligingly invented the list that was supposed to follow. A fact cut
  // off mid-sentence is an invitation to complete it.
  const shipped = [...shippedSection.matchAll(/\*\*([^*]+)\*\*\s*([\s\S]*?)(?=\n\n|\n\*\*|$)/g)]
    .map(([, label, rest]) =>
      `${label!.replace(/\.$/, '')}: ${rest!.replace(/\s+/g, ' ').trim()}`.trim(),
    )
    .filter((line) => line.length > 12 && !line.endsWith(':'))
    .slice(0, 8);

  const planned = [...text.matchAll(/^### \d+\.\d+ (.+)$/gm)]
    .map((match) => match[1]!.trim())
    // A phase heading marked "— **shipped**" is no longer planned, and posting
    // it as planned would understate what exists. The roadmap started marking
    // headings that way and this list quietly kept calling them future work.
    .filter((heading) => !/shipped|\bnext\b/i.test(heading))
    .slice(0, 10);

  return { shipped, planned };
}

/**
 * Commit subjects, when there is a git checkout to read them from.
 *
 * An installed copy of the package has no `.git`, and that is fine — the
 * changelog angle simply becomes unavailable rather than the whole poster
 * failing. Subjects only: bodies are long and often contain reasoning that
 * reads badly out of context.
 */
export function recentCommits(repoRoot: string, limit = 5): string[] {
  if (!existsSync(join(repoRoot, '.git'))) return [];

  try {
    const output = execFileSync('git', ['log', `-${limit}`, '--format=%s'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    return output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * One post's worth of material: an angle, and the specific thing it is about.
 *
 * The subject is the fix for repetition. Rotating six angles over a fact sheet
 * that never changes yields six posts and then starts again; rotating angles
 * *and* subjects yields one per (chain, tool, limit, recipe, change), which is
 * a space in the hundreds and grows every time a chain or a limit is added.
 */
export interface UpdateBrief {
  angle: UpdateAngle;
  /** Stable id, so "have I already posted this" survives a restart. */
  subject: string;
  /** The only facts this post may use. */
  facts: string[];
}

/**
 * Every post this repository currently supports, one per concrete subject.
 *
 * Built from the repo rather than from a list someone maintains: add a chain
 * and there is a new post about it, write a new Known Limit and there is a post
 * about that. An angle with nothing to say about it contributes nothing, which
 * is why an installed copy with no `.git` simply has no changelog posts instead
 * of failing.
 */
export function updateBriefs(facts: ProjectFacts): UpdateBrief[] {
  const briefs: UpdateBrief[] = [];

  for (const recipe of facts.recipes) {
    briefs.push({
      angle: 'howto',
      subject: `howto:${recipe.command}`,
      facts: [`Purpose: ${recipe.purpose}`, `Command, verbatim: ${recipe.command}`],
    });
  }

  for (const chain of facts.chains) {
    briefs.push({
      angle: 'chainnote',
      subject: `chain:${chain.id}`,
      facts: chain.details,
    });
    // The family quirks are the material a "gotcha" post is made of, and they
    // read differently from the same facts presented as a chain note.
    if (chain.details.length > 3) {
      briefs.push({
        angle: 'gotcha',
        subject: `gotcha:${chain.id}`,
        facts: chain.details.slice(2),
      });
    }
  }

  for (const limit of facts.limits) {
    briefs.push({
      angle: 'limitation',
      subject: `limit:${limit.label}`,
      facts: [`${limit.label}: ${limit.detail}`],
    });
  }

  for (const tool of facts.tools) {
    briefs.push({
      angle: 'capability',
      subject: `tool:${tool.name}`,
      facts: [`Tool "${tool.name}" — ${tool.title}`, tool.description],
    });
  }

  for (const change of facts.recentChanges) {
    briefs.push({
      angle: 'changelog',
      subject: `change:${change}`,
      facts: [`Commit subject: ${change}`],
    });
  }

  for (const item of facts.shipped) {
    briefs.push({ angle: 'teardown', subject: `shipped:${item}`, facts: [item] });
  }

  // One roadmap post per *planned* item, not per shipped one. A roadmap brief
  // built from a shipped item said the same thing as that item's teardown, in
  // slightly different words — near enough to read as repetition and far
  // enough apart to slip past the similarity guard.
  //
  // The shipped list still travels with it as context, and the labels are
  // emphatic on both sides: announcing a planned feature as a built one is the
  // specific way a project update becomes a false claim.
  if (facts.shipped.length) {
    for (const plan of facts.planned) {
      briefs.push({
        angle: 'roadmap',
        subject: `roadmap:${plan}`,
        // One shipped item for contrast, not the whole list. Handing over all
        // four made the model write about whichever one read best and ignore
        // the planned item the post was supposed to be about.
        facts: [
          `Planned — NOT built yet, describe only as planned: ${plan}`,
          `For contrast, shipped — this exists today: ${facts.shipped[0]}`,
        ],
      });
    }
  }

  briefs.push({
    angle: 'philosophy',
    subject: 'philosophy:read-only',
    facts: [
      'It is read-only: it holds no keys and never signs or broadcasts.',
      'It can build an UNSIGNED transfer for someone to sign in their own wallet.',
      `Version ${facts.version}.`,
    ],
  });

  return briefs;
}

/**
 * Pick the next post: an angle that has not run recently, about a subject that
 * has not run recently.
 *
 * Subject beats angle when they conflict. Repeating an angle with something new
 * to say about it is fine; repeating a subject is the thing readers notice.
 */
export function nextUpdate(
  briefs: UpdateBrief[],
  recentAngles: string[] = [],
  recentSubjects: string[] = [],
): UpdateBrief | null {
  if (!briefs.length) return null;

  const fresh = briefs.filter((brief) => !recentSubjects.includes(brief.subject));

  // Everything has been posted at least once. Go round again starting with
  // whatever has waited longest, and let subject recency decide outright —
  // applying the angle preference here would hand back the *most* recently
  // posted subject whenever its angle happened to sort first.
  if (!fresh.length) {
    const oldestFirst = [...briefs].sort(
      (a, b) => recentSubjects.indexOf(b.subject) - recentSubjects.indexOf(a.subject),
    );
    return oldestFirst[0] ?? null;
  }

  // Among fresh subjects, prefer an angle that has not run recently, and break
  // ties by UPDATE_ANGLES order — which is most-practical-first.
  const byAngle = (brief: UpdateBrief): number => {
    const used = recentAngles.indexOf(brief.angle);
    const recency = used === -1 ? -1 : recentAngles.length - used;
    return recency * 100 + UPDATE_ANGLES.indexOf(brief.angle);
  };

  return [...fresh].sort((a, b) => byAngle(a) - byAngle(b))[0] ?? null;
}

export function updatePrompt(
  facts: ProjectFacts,
  brief: UpdateBrief,
  recentPosts: string[] = [],
): string {
  return [
    'Write one post for X about the project below. You are posting as the project itself.',
    '',
    `Angle for this post: ${ANGLE_BRIEFS[brief.angle]}`,
    '',
    'Facts you may use. This is everything you know — anything not here does not exist:',
    ...brief.facts.map((fact) => `  - ${fact}`),
    ...(recentPosts.length
      ? [
          '',
          'You have already posted these. Do not repeat them, reword them, or make the same point again:',
          ...recentPosts.map((post) => `  - ${post}`),
        ]
      : []),
    '',
    'Rules:',
    `- Hard maximum ${REPLY_LIMIT} characters. Count them.`,
    '- Plain text. No hashtags, no emoji, no surrounding quotes, no preamble.',
    '- Do not invent version numbers, dates, user counts, prices, or partnerships.',
    '- Do not say "excited", "thrilled", or "game-changing".',
    '- Do not open with the project name, and do not describe it in general terms.',
    '  Write about the one specific thing above and nothing else.',
    '- State one concrete thing. A real detail from the facts beats an adjective.',
    '- Write ordinary English sentences with ordinary punctuation. Commas where a',
    '  comma belongs. Do not compress a list into a run of words.',
    '- Do not restate a fact back verbatim. Say what it MEANS for someone using',
    '  this: what they can now do, or what mistake it saves them from.',
    '',
    'Return the post text and nothing else.',
  ].join('\n');
}

export interface UpdateSchedule {
  /** Hours between posts. */
  intervalHours: number;
  /** Angles used recently, newest first — excluded from the next choice. */
  recentAngles: UpdateAngle[];
  lastPostedAt?: number;
}

export function isDue(schedule: UpdateSchedule, now: number): boolean {
  if (!schedule.lastPostedAt) return true;
  return now - schedule.lastPostedAt >= schedule.intervalHours * 3_600_000;
}

export interface ComposedUpdate {
  angle: UpdateAngle;
  /** Which specific thing this post was about — persisted so it is not repeated. */
  subject: string;
  text: string;
  result: PostResult;
}

/**
 * Composes and posts one update.
 *
 * The agent is called with a fresh conversation id each time and tools
 * disabled: this is a writing task over facts already gathered, and letting it
 * call chain tools here would spend RPC quota to decorate a post with a gas
 * price nobody asked for.
 */
export async function postUpdate(
  client: XClient,
  agent: GrokAgent,
  facts: ProjectFacts,
  brief: UpdateBrief,
  options: { dryRun?: boolean; now?: () => number; recentPosts?: string[] } = {},
): Promise<ComposedUpdate | null> {
  const stamp = (options.now?.() ?? Date.now()).toString(36);
  const { angle } = brief;

  // Enforced here rather than asked of the caller: `tools` off because this is
  // a writing task over facts already gathered, and `allowEmpty` because an
  // empty completion means "nothing to say". Without the latter the agent's
  // chat fallback ("I could not put an answer together…") would be published.
  const writer = agent.variant({ tools: false, allowEmpty: true });
  const reply = await writer.respond(
    `x-update:${angle}:${stamp}`,
    updatePrompt(facts, brief, options.recentPosts ?? []),
  );

  const text = fitReply(stripQuotes(reply.text));

  // The changelog angle is told to return nothing when there is nothing to
  // report, and an empty post is a refusal to make something up — honour it.
  if (!text || text.length < 20) return null;

  // Last line of defence on repetition: the model was shown what it already
  // said, but a near-identical post is worse than none, so it is dropped
  // rather than published.
  if (isTooSimilar(text, options.recentPosts ?? [])) return null;

  const result = await client.post(text, { ...(options.dryRun ? { dryRun: true } : {}) });
  return { angle, subject: brief.subject, text, result };
}

/**
 * Word-overlap similarity, which is enough here: the failure being caught is a
 * model restating its own last post, not paraphrase in general.
 */
export function isTooSimilar(text: string, previous: string[], threshold = 0.5): boolean {
  const words = (value: string) =>
    new Set(value.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 3));

  const candidate = words(text);
  if (candidate.size === 0) return false;

  return previous.some((post) => {
    const other = words(post);
    if (other.size === 0) return false;

    let shared = 0;
    for (const word of candidate) if (other.has(word)) shared++;

    return shared / Math.min(candidate.size, other.size) >= threshold;
  });
}

function stripQuotes(text: string): string {
  const unwrapped = /^["“']([\s\S]+)["”']$/.exec(text.trim());
  return (unwrapped?.[1] ?? text).trim();
}
