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
}

/**
 * The angles a post can be written from.
 *
 * Each names the facts it may use, so the prompt stays narrow — a post about
 * chain coverage cannot wander into claims about safety guarantees.
 */
export const UPDATE_ANGLES = [
  'coverage',
  'capability',
  'safety',
  'changelog',
  'roadmap',
  'philosophy',
] as const;

export type UpdateAngle = (typeof UPDATE_ANGLES)[number];

const ANGLE_BRIEFS: Record<UpdateAngle, string> = {
  coverage:
    'What chains it reaches. Name real chain ids from the list and the number of them. Do not claim a chain that is not listed.',
  capability:
    'One specific thing it can do, drawn from the capability list. Concrete, not a feature dump.',
  safety:
    'That it is read-only and holds no keys: it can build an unsigned transfer for someone to sign themselves, and cannot sign or broadcast. Say why that is the right default.',
  changelog:
    'What changed recently, using only the listed commit subjects. If the list is empty, do not write about changes at all — pick nothing and return an empty line.',
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
  };
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
  const shipped = [...shippedSection.matchAll(/\*\*([^*]+)\*\*\s*([^\n]*)/g)]
    .map(([, label, rest]) => `${label!.replace(/\.$/, '')}: ${rest!.trim()}`.trim())
    .filter((line) => line.length > 12)
    .slice(0, 8);

  const planned = [...text.matchAll(/^### \d+\.\d+ (.+)$/gm)]
    .map((match) => match[1]!.trim())
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

/** Renders the facts the chosen angle is allowed to use, and nothing else. */
export function factSheet(facts: ProjectFacts, angle: UpdateAngle): string {
  const lines = [`Version: ${facts.version}`];

  if (angle === 'coverage' || angle === 'philosophy') {
    lines.push(`Chains supported: ${facts.chainCount}`);
    for (const [family, ids] of Object.entries(facts.byFamily)) {
      lines.push(`  ${family} (${ids.length}): ${ids.slice(0, 12).join(', ')}`);
    }
  }

  if (angle === 'capability') {
    lines.push(`Tools (${facts.toolCount}):`);
    for (const capability of facts.capabilities) lines.push(`  - ${capability}`);
  }

  if (angle === 'changelog') {
    lines.push(
      facts.recentChanges.length
        ? `Recent commits:\n${facts.recentChanges.map((c) => `  - ${c}`).join('\n')}`
        : 'Recent commits: none available.',
    );
  }

  if (angle === 'roadmap') {
    if (facts.shipped.length) {
      lines.push('Shipped — this exists today:');
      for (const item of facts.shipped) lines.push(`  - ${item}`);
    }
    // Labelled emphatically because announcing a planned feature as a built
    // one is the specific way a project update becomes a false claim.
    if (facts.planned.length) {
      lines.push('Planned — NOT built yet, and must be described only as planned:');
      for (const item of facts.planned) lines.push(`  - ${item}`);
    }
  }

  return lines.join('\n');
}

export function updatePrompt(
  facts: ProjectFacts,
  angle: UpdateAngle,
  recentPosts: string[] = [],
): string {
  return [
    'Write one post for X about the project below. You are posting as the project itself.',
    '',
    `Angle for this post: ${ANGLE_BRIEFS[angle]}`,
    '',
    'Facts you may use. This is everything you know — anything not here does not exist:',
    factSheet(facts, angle),
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
    '- State one concrete thing. A real number from the facts beats an adjective.',
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

/**
 * Picks the least recently used angle, so five posts cover five different
 * things before any repeats.
 */
export function nextAngle(recent: UpdateAngle[], facts: ProjectFacts): UpdateAngle {
  const usable = UPDATE_ANGLES.filter((angle) => {
    // Nothing to say about a changelog with no commits in it.
    if (angle === 'changelog') return facts.recentChanges.length > 0;
    // Nor about a roadmap that could not be read (an installed package has none).
    if (angle === 'roadmap') return facts.shipped.length > 0 || facts.planned.length > 0;

    return true;
  });

  const unused = usable.filter((angle) => !recent.includes(angle));
  if (unused.length) return unused[0]!;

  // All used: take the one used longest ago.
  const oldestFirst = [...usable].sort(
    (a, b) => recent.lastIndexOf(b) - recent.lastIndexOf(a),
  );
  return oldestFirst[0]!;
}

export function isDue(schedule: UpdateSchedule, now: number): boolean {
  if (!schedule.lastPostedAt) return true;
  return now - schedule.lastPostedAt >= schedule.intervalHours * 3_600_000;
}

export interface ComposedUpdate {
  angle: UpdateAngle;
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
  angle: UpdateAngle,
  options: { dryRun?: boolean; now?: () => number; recentPosts?: string[] } = {},
): Promise<ComposedUpdate | null> {
  const stamp = (options.now?.() ?? Date.now()).toString(36);

  // Enforced here rather than asked of the caller: `tools` off because this is
  // a writing task over facts already gathered, and `allowEmpty` because an
  // empty completion means "nothing to say". Without the latter the agent's
  // chat fallback ("I could not put an answer together…") would be published.
  const writer = agent.variant({ tools: false, allowEmpty: true });
  const reply = await writer.respond(
    `x-update:${angle}:${stamp}`,
    updatePrompt(facts, angle, options.recentPosts ?? []),
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
  return { angle, text, result };
}

/**
 * Word-overlap similarity, which is enough here: the failure being caught is a
 * model restating its own last post, not paraphrase in general.
 */
export function isTooSimilar(text: string, previous: string[], threshold = 0.6): boolean {
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
