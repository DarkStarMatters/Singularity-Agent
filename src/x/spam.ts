/**
 * Deciding which mentions are worth answering.
 *
 * This runs *before* the model does, and that ordering is the whole point. A
 * reply costs an xAI completion (with tool calls, several) plus one of a small
 * number of writes the X tier allows per window. A mentions timeline full of
 * engagement bots would burn both on an audience of nobody.
 *
 * The rule that actually does the work is the last one: a cold mention must be
 * **on topic** — it must name something this agent can look up or talk about. A
 * question mark is not enough, because "can I get a follow back?" is a question
 * and there is nothing to answer.
 *
 * "On topic" is deliberately wider than "names a chain". The commonest genuine
 * mention a project account gets is a question about the project itself — what
 * it does, whether it is open source, how to install it — and an agent that
 * drops those while happily answering balance lookups reads as broken. So the
 * vocabulary covers three things: the chain registry (derived from it, not
 * hand-copied, so a chain added in Phase 3 teaches the filter for free), the
 * project's own subject matter, and a direct question put to the agent about
 * itself.
 *
 * That ordering was arrived at empirically. Measured against a real mentions
 * timeline, filters built on account age and follower count let ~80% of spam
 * through: the accounts farming engagement are years old with six-figure
 * follower counts, and the genuinely new accounts were the honest ones. Those
 * signals are kept only for the narrow case they do catch — a zero-follower
 * throwaway — and nothing rests on them.
 *
 * Every rejection carries a reason, and the listener logs it. Silence you
 * cannot explain is indistinguishable from a broken bot.
 */
import { detect } from '../core/detect.js';
import { allChains } from '../core/registry.js';
import { WELL_KNOWN_TOKENS } from '../core/tokens.js';
import type { Mention } from './client.js';

export interface SpamVerdict {
  /** True when the mention should not reach the model. */
  skip: boolean;
  reason?: string;
}

export interface SpamOptions {
  /** Accounts younger than this are treated as throwaways. */
  minAccountAgeDays?: number;
  /** Below this follower count, an account has to look especially genuine. */
  minFollowers?: number;
  /** A mention tagging more accounts than this is a broadcast, not a question. */
  maxHandles?: number;
  maxHashtags?: number;
  maxLinks?: number;
  now?: () => number;
}

/**
 * Phrases from the scam genres that dominate crypto mentions. Matched on word
 * boundaries against lowercased text.
 *
 * These are not "rude words" — each one names a specific fraud that targets
 * exactly this audience, and there is no legitimate question that needs the bot
 * to engage with one.
 */
const SCAM_PHRASES = [
  'dm me',
  'dm for',
  'send me a dm',
  'sending me a quick dm',
  'message me',
  'send me your',
  'seed phrase',
  'private key',
  'recovery expert',
  'recover your',
  'lost funds',
  'wallet drained',
  'hacked wallet',
  'contact the expert',
  'whatsapp',
  'telegram me',
  'double your',
  'guaranteed profit',
  'guaranteed returns',
  'free mint',
  'claim your',
  'claim now',
  'airdrop is live',
  'connect your wallet',
  'verify your wallet',
  'giveaway',
  'first 100',
  'presale',
  'x100',
  '100x gem',
  'financial freedom',
  'trading signals',
  'copy my trades',
  'investment opportunity',
];

/**
 * Engagement farming: the dominant genre in a crypto project's mentions, and
 * the one nothing else catches. These accounts are old, well-followed, and
 * fluent — they simply have nothing to say. Every phrase here is an opener
 * whose only purpose is to start a DM, and none of them contains a question
 * this agent could answer.
 */
const FARMING_PHRASES = [
  "let's connect",
  'lets connect',
  "let's talk",
  "let's discuss",
  "let's make moves",
  "let's go to moon",
  'love to connect',
  'would love to discuss',
  'reach out anytime',
  'feel free to reach out',
  'got you covered',
  'follow back',
  'follow me',
  'followback',
  'collaboration',
  'collaborations',
  'promotion',
  'great project',
  'great execution',
  'strong project',
  'solid project',
  'impressive work',
  'amazing community',
  'strong vision',
  'compelling vision',
  'shows promise',
  'looks promising',
  'moving nicely',
  'deserves more attention',
  'caught my eye',
  'strong impression',
  'to the moon',
  'push it',
];

/**
 * Words naming something this agent can actually look up.
 *
 * Matching is on word boundaries, so plurals are listed explicitly — `\bchain\b`
 * does not match "chains", and "which chains do you support?" is exactly the
 * kind of question that must get through.
 */
const TOPIC_WORDS = [
  'balance',
  'balances',
  'wallet',
  'wallets',
  'address',
  'addresses',
  'transaction',
  'transactions',
  'tx',
  'hash',
  'gas',
  'fee',
  'fees',
  'gwei',
  'block',
  'blocks',
  'chain',
  'chains',
  'token',
  'tokens',
  'holdings',
  'portfolio',
  'ens',
  'contract',
  'contracts',
  'transfer',
  'explorer',
  'nft',
  'defi',
  'staking',
  'bridge',
  'mainnet',
  'testnet',
  'rpc',
  'node',
  'endpoint',
  'archive',
  'decimals',
  'decode',
  'calldata',
  'swap',
  'validator',
  'ibc',
  'denom',
  'seed',
  'custody',
  'sign',
  'signing',
  'unsigned',
];

/**
 * Things the agent can talk about that are not chain data.
 *
 * A project account's mentions are mostly questions *about the project*, and
 * before this list existed every one of them was dropped as "nothing this agent
 * can look up" — which is exactly backwards, since the agent can answer them
 * from its own README.
 */
const PROJECT_WORDS = [
  'singularity',
  'mcp',
  'cli',
  'sdk',
  'api',
  'repo',
  'repository',
  'github',
  'npm',
  'install',
  'setup',
  'docs',
  'documentation',
  'readme',
  'roadmap',
  'whitepaper',
  'license',
  'open source',
  'opensource',
  'source code',
  'plugin',
  'tool',
  'tools',
  'tooling',
  'agent',
  'agents',
  'bot',
  'claude',
  'eliza',
  'elizaos',
  'grok',
  'llm',
  'model',
  'prompt',
  'injection',
  'rate limit',
  'rate limits',
  'uptime',
  'roadmap',
  'plans',
  'planned',
  'feature',
  'features',
  'support',
  'supports',
  'supported',
];

/**
 * Chain vocabulary, derived from the registry rather than hand-copied.
 *
 * The hand-written list this replaced named twelve chains out of twenty-three,
 * so "does it support avalanche?" was filtered as off-topic by the agent that
 * supports Avalanche. Deriving it means a chain added in Phase 3 teaches the
 * filter on the same commit.
 */
let chainVocabulary: string[] | null = null;

/**
 * Words too generic to carry a chain's identity. "Smart" and "one" arrive from
 * "BNB Smart Chain" and "Arbitrum One"; "era" and "main" are real aliases that
 * are also ordinary English, and matching them would let anything through.
 */
const AMBIGUOUS = new Set(['smart', 'one', 'era', 'main', 'pos', 'test', 'hub', 'wrapped', 'coin']);

function chainWords(): string[] {
  if (chainVocabulary) return chainVocabulary;

  const words = new Set<string>();
  const add = (value: string | undefined): void => {
    for (const part of (value ?? '').toLowerCase().split(/[\s-]+/)) {
      // Two characters is not a name — "l1" and "op" match far more prose than
      // they do questions about a chain.
      if (part.length > 2 && !AMBIGUOUS.has(part)) words.add(part);
    }
  };

  for (const chain of allChains()) {
    add(chain.id);
    add(chain.name);
    add(chain.nativeCurrency.symbol);
    add(chain.nativeCurrency.name);
    for (const alias of chain.aliases ?? []) add(alias);
  }
  for (const tokens of Object.values(WELL_KNOWN_TOKENS)) {
    for (const token of tokens) add(token.symbol);
  }

  chainVocabulary = [...words];
  return chainVocabulary;
}

/** Test seam: the registry can be reloaded with custom chains. */
export function resetSpamVocabulary(): void {
  chainVocabulary = null;
}

const HANDLE = /@[A-Za-z0-9_]{1,15}/g;
const HASHTAG = /#[\w]+/g;
const LINK = /https?:\/\/\S+/g;
/** Emoji and pictographs, which spam leans on far harder than people do. */
const PICTOGRAPH = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu;

function countOf(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

function mentionsAny(text: string, phrases: string[]): string | null {
  for (const phrase of phrases) {
    // Word boundaries, so "pump" does not fire inside "pumpkin".
    if (new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text)) {
      return phrase;
    }
  }
  return null;
}

/**
 * Does this text name something concrete the agent handles?
 *
 * "Substantive" as opposed to merely being addressed at the agent: this is the
 * signal strong enough to override an engagement-farming phrase, so it has to
 * be about a subject, not about tone.
 *
 * Detection is reused rather than guessed at: `detect()` already knows every
 * address, name and hash format on every supported family, so a mention
 * carrying a bare address counts even with no keyword in it.
 */
export function hasSubstance(text: string): boolean {
  const lower = text.toLowerCase();
  if (mentionsAny(lower, TOPIC_WORDS)) return true;
  if (mentionsAny(lower, PROJECT_WORDS)) return true;
  if (mentionsAny(lower, chainWords())) return true;

  return text
    .split(/[\s,;:()[\]{}"'`]+/)
    .map((word) => word.replace(/[.?!]+$/, ''))
    .filter((word) => word.length > 6)
    .some((word) => {
      const kind = detect(word).kind;
      return kind === 'address' || kind === 'tx' || kind === 'name';
    });
}

/** Opens a question even without a question mark — people drop them constantly. */
const INTERROGATIVE =
  /^(what|whats|how|hows|why|when|where|which|who|whose|can|could|do|does|did|is|isnt|are|was|were|will|would|should|any|got|have|has|tell|explain)\b/i;

export function isQuestion(text: string): boolean {
  return text.includes('?') || INTERROGATIVE.test(text.trim());
}

/** A question whose subject is the agent or the thing it is part of. */
const SELF_REFERENCE =
  /\b(you|your|yours|yourself|this|these|it|its|singularity|the bot|the agent|the project|the tool)\b/i;

/**
 * "What can you do?" has no chain in it and is still the most answerable
 * question there is. So a direct question *about the agent* counts as on
 * topic — but only as the weaker signal: it never overrides a farming phrase,
 * or "do you follow back?" would talk its way straight through.
 */
export function asksAboutTheAgent(text: string): boolean {
  return isQuestion(text) && SELF_REFERENCE.test(text);
}

/**
 * The full on-topic test: something concrete, or a question put to the agent.
 */
export function isOnTopic(text: string): boolean {
  return hasSubstance(text) || asksAboutTheAgent(text);
}

/**
 * `isFollowUp` means the agent has already replied in this thread — not merely
 * that the mention is a reply to something. Every reply to one of the agent's
 * own posts is "a reply", and treating that as a reason to relax the filter is
 * exactly how engagement bots get answered: they all reply to posts.
 *
 * A genuine follow-up skips only the on-topic test, because "and on arbitrum?"
 * is a fair question once a conversation is underway. Everything else — scams,
 * farming, broadcasts — still applies.
 */
export function classifyMention(
  mention: Mention,
  options: SpamOptions & { isFollowUp?: boolean } = {},
): SpamVerdict {
  const {
    minAccountAgeDays = 7,
    minFollowers = 10,
    maxHandles = 3,
    maxHashtags = 2,
    maxLinks = 1,
    now = Date.now,
  } = options;

  const raw = mention.text ?? '';
  const lower = raw.toLowerCase();
  // What is left once the addressing is removed is the actual message.
  const body = raw.replace(HANDLE, '').replace(LINK, '').trim();
  // What was *said*, for the topic tests: handles gone, links kept. The
  // agent's own handle is in every mention by definition, so matching topic
  // words against the raw text made the account's own name — and anything
  // else in a handle — read as substance, which passed everything.
  const said = raw.replace(HANDLE, ' ').trim();

  const scam = mentionsAny(lower, SCAM_PHRASES);
  if (scam) return { skip: true, reason: `scam phrase: "${scam}"` };

  // Farming phrases are openers, not questions — but a real question often
  // arrives wearing one ("great project, how do you handle rate limits?"), and
  // killing those was filtering out the people worth answering. The phrase only
  // decides when there is no substantive question attached to it.
  const farming = mentionsAny(lower, FARMING_PHRASES);
  if (farming && !(isQuestion(said) && hasSubstance(said))) {
    return { skip: true, reason: `engagement farming: "${farming}"` };
  }

  if (body.length < 3) return { skip: true, reason: 'no message beyond the handles' };

  const handles = countOf(raw, HANDLE);
  if (handles > maxHandles) {
    return { skip: true, reason: `tags ${handles} accounts — a broadcast, not a question` };
  }

  const hashtags = countOf(raw, HASHTAG);
  if (hashtags > maxHashtags) return { skip: true, reason: `${hashtags} hashtags` };

  const links = countOf(raw, LINK);
  if (links > maxLinks) return { skip: true, reason: `${links} links` };

  // A link plus almost no words is an advert with a fig leaf.
  if (links > 0 && body.length < 40) {
    return { skip: true, reason: 'a link with no real question attached' };
  }

  const pictographs = countOf(raw, PICTOGRAPH);
  if (pictographs > 4 || (pictographs > 0 && body.replace(PICTOGRAPH, '').trim().length < 10)) {
    return { skip: true, reason: 'mostly emoji' };
  }

  if (isShouting(body)) return { skip: true, reason: 'all caps' };

  const age = accountAgeDays(mention.authorCreatedAt, now());
  const followers = mention.authorFollowers;

  // A brand-new account with no audience, mentioning a bot, is a throwaway far
  // more often than it is a person. Only applied when X actually sent the
  // metrics — absent data is not evidence.
  if (age !== null && age < minAccountAgeDays && (followers ?? 0) < minFollowers) {
    return {
      skip: true,
      reason: `account is ${Math.floor(age)}d old with ${followers ?? 0} followers`,
    };
  }

  if (options.isFollowUp) return { skip: false };

  // The positive test, and the one that carries the filter.
  //
  // A question mark deliberately does not qualify on its own: "can I get a
  // follow back?" is a question with nothing in it to answer, and questions
  // like it are most of what arrives.
  if (!isOnTopic(said)) {
    return {
      skip: true,
      reason:
        'nothing this agent can answer — no chain, asset, address, hash, or question about the project',
    };
  }

  return { skip: false };
}

function isShouting(text: string): boolean {
  const letters = text.replace(/[^A-Za-z]/g, '');
  if (letters.length < 12) return false;

  const upper = letters.replace(/[^A-Z]/g, '').length;
  return upper / letters.length > 0.8;
}

function accountAgeDays(createdAt: string | undefined, now: number): number | null {
  if (!createdAt) return null;

  const created = Date.parse(createdAt);
  return Number.isNaN(created) ? null : (now - created) / 86_400_000;
}

/**
 * Hard spending limits, independent of whether a mention looks genuine.
 *
 * The classifier judges mentions one at a time and cannot see a pattern; this
 * sees the pattern and nothing else. A single account cannot monopolize the
 * budget, and a coordinated flood cannot drain it in one poll — whatever any
 * individual message looks like.
 */
export class ReplyBudget {
  private readonly perAuthor = new Map<string, number[]>();
  private readonly all: number[] = [];

  constructor(
    private readonly maxPerHour = 12,
    private readonly maxPerAuthorPerHour = 3,
  ) {}

  /** Checks and consumes in one step, so a caller cannot forget to record. */
  take(authorId: string, now = Date.now()): SpamVerdict {
    const cutoff = now - 3_600_000;
    prune(this.all, cutoff);

    const mine = this.perAuthor.get(authorId) ?? [];
    prune(mine, cutoff);
    this.perAuthor.set(authorId, mine);

    if (this.all.length >= this.maxPerHour) {
      return { skip: true, reason: `hourly reply budget spent (${this.maxPerHour}/h)` };
    }
    if (mine.length >= this.maxPerAuthorPerHour) {
      return {
        skip: true,
        reason: `already replied ${mine.length}× to this account in the last hour`,
      };
    }

    this.all.push(now);
    mine.push(now);
    return { skip: false };
  }

  get spentThisHour(): number {
    return this.all.length;
  }
}

function prune(times: number[], cutoff: number): void {
  while (times.length && times[0]! <= cutoff) times.shift();
}
