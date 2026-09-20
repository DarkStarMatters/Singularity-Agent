import { describe, it, expect } from 'vitest';
import { COMMANDS, botFatherCommandList, commandMenu } from '../src/telegram/commands.js';
import { TOOLS } from '../src/tools/catalog.js';
import { formatDecoded, formatHealth, formatReadResult } from '../src/telegram/format.js';
import {
  UPDATE_ANGLES,
  collectProjectFacts,
  updateBriefs,
  isDue,
  isTooSimilar,
  nextUpdate,
  postUpdate,
  updatePrompt,
  type ProjectFacts,
} from '../src/x/updates.js';
import { GrokAgent } from '../src/grok/agent.js';
import { REPLY_LIMIT } from '../src/x/listener.js';
import type { AssistantMessage, GrokClient } from '../src/grok/client.js';
import type { XClient } from '../src/x/client.js';

/**
 * The bot, the CLI and MCP are supposed to expose the same capabilities. This
 * is the guard that keeps them that way: a tool added to the catalogue without
 * a bot command fails here rather than being noticed months later.
 */
const TOOL_TO_COMMAND: Record<string, string> = {
  chains: 'chains',
  resolve: 'resolve',
  balance: 'balance',
  portfolio: 'portfolio',
  transaction: 'tx',
  block: 'block',
  fees: 'fees',
  read_contract: 'read',
  decode: 'decode',
  history: 'history',
  mint_audit: 'mint',
  build_transfer: 'transfer',
  build_burn: 'burn',
  verify_burn: 'verifyburn',
  token_identity: 'identity',
  chain_liveness: 'health',
  inspect_exit: 'inspect',
};

describe('telegram command surface', () => {
  it('has a command for every tool in the catalogue', () => {
    for (const tool of TOOLS) {
      const command = TOOL_TO_COMMAND[tool.name];
      expect(command, `no bot command mapped for tool "${tool.name}"`).toBeTruthy();
      expect(COMMANDS.has(command!), `/${command} is missing from the bot`).toBe(true);
    }
  });

  it('also exposes the bot-only commands', () => {
    // `pay`, `paid` and `qr` are deliberately bot-only. A payment request
    // generator is not something a model should reach for mid-sentence, and a
    // QR is a rendering rather than a chain read.
    for (const name of ['health', 'forget', 'chatid', 'help', 'start', 'pay', 'paid', 'payments', 'qr']) {
      expect(COMMANDS.has(name), `/${name} is missing`).toBe(true);
    }
  });

  it('gives every command a usage line that starts with its own name', () => {
    for (const [name, command] of COMMANDS) {
      if (name === 'start') continue;
      expect(command.usage.startsWith(`/${command.name}`)).toBe(true);
      expect(command.summary.length).toBeGreaterThan(8);
    }
  });

  it('produces a BotFather list covering every listed command', () => {
    const lines = botFatherCommandList().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(13);

    for (const line of lines) expect(line).toMatch(/^[a-z]+ - .+/);
  });

  it('publishes a menu where every entry is actually dispatchable', () => {
    // A menu entry with no command behind it does nothing when tapped — no
    // reply, no error. This is the guard for that whole class of bug.
    for (const entry of commandMenu()) {
      expect(COMMANDS.has(entry.command), `/${entry.command} is advertised but not handled`).toBe(
        true,
      );
    }
  });

  it('answers the MCP tool names as aliases', () => {
    // A menu registered from the tool catalogue uses these names, and a bot
    // that silently ignores them looks broken.
    expect(COMMANDS.get('transaction')).toBe(COMMANDS.get('tx'));
    expect(COMMANDS.get('read_contract')).toBe(COMMANDS.get('read'));
    expect(COMMANDS.get('build_transfer')).toBe(COMMANDS.get('transfer'));
  });

  it('routes every catalogue tool name straight to a command', () => {
    for (const tool of TOOLS) {
      expect(COMMANDS.has(tool.name), `tool "${tool.name}" is not reachable as a command`).toBe(
        true,
      );
    }
  });

  it('reports a missing argument as a usage hint, not a crash', async () => {
    const ctx = {
      args: [],
      chatId: 1,
      chatType: 'private' as const,
      config: {} as never,
    };

    await expect(COMMANDS.get('read')!.run(ctx)).rejects.toMatchObject({
      code: 'MISSING_ARGUMENT',
    });
  });

  it('sends /chat to the model and returns what it said', async () => {
    const ctx = {
      args: ['what', 'is', 'gas', 'on', 'base?'],
      chatId: 1,
      chatType: 'private' as const,
      config: {} as never,
      converse: async (text: string) => `answered: ${text}`,
    };

    expect(await COMMANDS.get('chat')!.run(ctx)).toBe('answered: what is gas on base?');
  });

  it('says why /chat is unavailable rather than staying silent', async () => {
    const ctx = { args: ['hello'], chatId: 1, chatType: 'private' as const, config: {} as never };
    expect(await COMMANDS.get('chat')!.run(ctx)).toMatch(/no xAI key/i);
  });

  it('asks for a question when /chat is sent bare', async () => {
    const ctx = {
      args: [],
      chatId: 1,
      chatType: 'private' as const,
      config: {} as never,
      converse: async () => 'never reached',
    };

    await expect(COMMANDS.get('chat')!.run(ctx)).rejects.toMatchObject({
      code: 'MISSING_ARGUMENT',
    });
  });

  it('decodes calldata through the bot command', async () => {
    const ctx = {
      args: [
        '0xa9059cbb000000000000000000000000d8da6bf26964af9d7eed9e03e53415d37aa96045' +
          '00000000000000000000000000000000000000000000000000000000000f4240',
      ],
      chatId: 1,
      chatType: 'private' as const,
      config: {} as never,
    };

    const rendered = await COMMANDS.get('decode')!.run(ctx);
    expect(rendered).toContain('transfer');
  });
});

describe('new formatters', () => {
  it('renders a decoded call with its arguments', () => {
    const out = formatDecoded({
      signature: 'transfer(address,uint256)',
      name: 'transfer',
      selector: '0xa9059cbb',
      args: [{ name: 'to', type: 'address', value: '0xabc' }],
    });

    expect(out).toContain('transfer(address,uint256)');
    expect(out).toContain('to');
  });

  it('says so plainly when a call is not recognized', () => {
    expect(formatDecoded({ selector: '0x12345678', note: 'Unknown selector.' })).toContain(
      'Unknown selector.',
    );
  });

  it('escapes a hostile value rather than rendering it as markup', () => {
    expect(formatReadResult('base', '0xabc', '<b>evil</b>')).toContain('&lt;b&gt;');
  });

  it('puts failures before the wall of green ticks', () => {
    const out = formatHealth([
      { chain: 'base', ok: true, ms: 40 },
      { chain: 'solana', ok: false, ms: 900, error: 'timeout' },
    ]);

    expect(out.indexOf('solana')).toBeLessThan(out.indexOf('base'));
    expect(out).toContain('1/2 reachable');
  });
});

const FACTS: ProjectFacts = {
  version: '0.0.2',
  chainCount: 3,
  byFamily: { evm: ['ethereum', 'base'], svm: ['solana'] },
  toolCount: 10,
  capabilities: ['Get balances on one chain', 'Look up a transaction'],
  recentChanges: ['Fix Solana block lookups', 'Add the spam filter'],
  shipped: ['Coverage: 3 chains across two families'],
  planned: ['Historical state', 'Transaction history'],
  chains: [
    { id: 'ethereum', name: 'Ethereum', family: 'evm', details: ['a', 'b', 'c', 'd'] },
    { id: 'solana', name: 'Solana', family: 'svm', details: ['e', 'f', 'g', 'h'] },
  ],
  tools: [
    { name: 'balance', title: 'Get balances on one chain', description: 'Native and token balances.' },
  ],
  limits: [{ label: 'No fiat pricing', detail: 'Balances only, because pricing needs an oracle.' }],
  recipes: [
    { purpose: 'Balances on one chain', command: 'singularity balance vitalik.eth --chain ethereum' },
  ],
};

/** The first brief for an angle, for tests that care about one angle's shape. */
function briefFor(angle: string) {
  const found = updateBriefs(FACTS).find((brief) => brief.angle === angle);
  if (!found) throw new Error(`no brief for angle ${angle}`);
  return found;
}

describe('project update grounding', () => {
  it('reads real facts out of the repository', () => {
    const facts = collectProjectFacts();

    expect(facts.chainCount).toBeGreaterThan(0);
    expect(facts.toolCount).toBe(TOOLS.length);
    expect(facts.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('gives each post only the facts about its own subject', () => {
    // A post about one chain must not be handed the commit log to embellish
    // with, nor the other chains to turn back into a coverage boast.
    const chain = updateBriefs(FACTS).find((b) => b.subject === 'chain:ethereum')!;

    expect(chain.facts.join(' ')).not.toContain('Fix Solana block lookups');
    expect(chain.facts.join(' ')).not.toContain('solana');
    expect(briefFor('changelog').facts.join(' ')).toContain('Fix Solana block lookups');
  });

  it('builds one post per concrete subject, not per angle', () => {
    const briefs = updateBriefs(FACTS);
    const subjects = new Set(briefs.map((b) => b.subject));

    // Every subject is distinct, and there are far more of them than angles —
    // which is the whole fix: rotating angles over unchanging facts gives one
    // post per angle, rotating subjects gives one per chain, tool and limit.
    expect(subjects.size).toBe(briefs.length);
    expect(briefs.length).toBeGreaterThan(UPDATE_ANGLES.length);
  });

  it('grows the post space when the project grows', () => {
    const before = updateBriefs(FACTS).length;
    const after = updateBriefs({
      ...FACTS,
      limits: [
        ...FACTS.limits,
        { label: 'No CosmWasm', detail: 'read_contract covers EVM and Solana only.' },
      ],
    }).length;

    // Add a Known Limit to the README and there is a new post about it, with
    // nobody maintaining a list of things to say.
    expect(after).toBe(before + 1);
  });

  it('reads the real README for limits and runnable recipes', () => {
    const facts = collectProjectFacts();

    expect(facts.limits.length).toBeGreaterThan(3);
    expect(facts.recipes.length).toBeGreaterThan(3);
    // A recipe must be pasteable, so it is copied verbatim from documentation
    // that is kept working rather than invented by the model.
    for (const recipe of facts.recipes) {
      expect(recipe.command.startsWith('singularity ')).toBe(true);
      expect(recipe.command.endsWith(String.fromCharCode(92))).toBe(false);
    }
  });

  it('tells the model that anything outside the facts does not exist', () => {
    const prompt = updatePrompt(FACTS, briefFor('chainnote'));

    // The wording of this moved when the style rules were stripped out to stop
    // every post reading the same. The guarantee did not: the facts are the
    // facts, nothing may be invented, and X counts characters. Those three are
    // the product rather than the prose, and they survive a rewrite of the
    // voice around them.
    expect(prompt).toContain('Nothing outside this list exists');
    expect(prompt).toContain('Do not invent');
    expect(prompt).toContain(String(REPLY_LIMIT));
  });

  it('never repeats a subject until every other one has had a turn', () => {
    // The actual complaint this fixes: the account said the same few things
    // over and over. Walk the whole space and nothing may come round twice.
    const briefs = updateBriefs(FACTS);
    const subjects: string[] = [];
    const angles: string[] = [];

    for (let i = 0; i < briefs.length; i++) {
      const next = nextUpdate(briefs, angles, subjects);
      if (!next) throw new Error('ran out of material early');
      subjects.unshift(next.subject);
      angles.unshift(next.angle);
    }

    expect(new Set(subjects).size).toBe(briefs.length);
  });

  it('leads with the practical angles rather than talking about itself', () => {
    const first = nextUpdate(updateBriefs(FACTS), [], []);

    // `philosophy` and `roadmap` are the least useful things to post, so they
    // sort last; a reader should meet a command or a gotcha first.
    expect(['howto', 'gotcha', 'chainnote', 'limitation']).toContain(first?.angle);
  });

  it('keeps going once everything has been posted, oldest subject first', () => {
    const briefs = updateBriefs(FACTS);
    const allSubjects = briefs.map((b) => b.subject);

    // Exhausted rather than stuck: it must not go silent, and it must not
    // pick the thing it posted most recently.
    const next = nextUpdate(briefs, [], allSubjects);
    expect(next).not.toBeNull();
    expect(next!.subject).not.toBe(allSubjects[0]);
  });

  it('has no changelog posts with no commits to report', () => {
    const noCommits = { ...FACTS, recentChanges: [] };
    expect(updateBriefs(noCommits).some((b) => b.angle === 'changelog')).toBe(false);
  });

  it('has no roadmap posts when the roadmap could not be read', () => {
    // An installed copy of the package ships no roadmap.md.
    const noRoadmap = { ...FACTS, shipped: [], planned: [] };
    expect(updateBriefs(noRoadmap).some((b) => b.angle === 'roadmap')).toBe(false);
  });

  it('separates what is shipped from what is only planned', () => {
    const sheet = briefFor('roadmap').facts.join('\n');

    // An agent announcing a planned feature as a built one is the specific
    // failure this labelling exists to prevent.
    expect(sheet).toContain('exists today');
    expect(sheet).toContain('NOT built yet');
    // Both are present and both are labelled; the order between them is not
    // the guarantee, the labels are.
    expect(sheet).toContain('Coverage: 3 chains');
    expect(sheet).toContain('Historical state');
  });

  it('keeps the roadmap out of posts that should not cite it', () => {
    expect(briefFor('chainnote').facts.join(' ')).not.toContain('Historical state');
    expect(briefFor('howto').facts.join(' ')).not.toContain('Historical state');
  });

  it('is due immediately, then not again until the interval passes', () => {
    const schedule = { intervalHours: 6, recentAngles: [] };

    expect(isDue(schedule, 1_000)).toBe(true);
    expect(isDue({ ...schedule, lastPostedAt: 1_000 }, 1_000 + 3_600_000)).toBe(false);
    expect(isDue({ ...schedule, lastPostedAt: 1_000 }, 1_000 + 6 * 3_600_000)).toBe(true);
  });
});

function updateHarness(reply: string): { client: XClient; agent: GrokAgent; posted: string[] } {
  const posted: string[] = [];

  const grok = {
    async complete(): Promise<AssistantMessage> {
      return { content: reply, toolCalls: [] };
    },
  } as unknown as GrokClient;

  const client = {
    async post(text: string) {
      posted.push(text);
      return { published: true, text, id: '1', url: 'https://x.com/i/web/status/1' };
    },
  } as unknown as XClient;

  return { client, agent: new GrokAgent(grok, { system: 'sys', tools: false }), posted };
}

describe('posting a project update', () => {
  it('publishes the composed post', async () => {
    const { client, agent, posted } = updateHarness('Singularity reads 3 chains across two families.');
    const update = await postUpdate(client, agent, FACTS, briefFor('chainnote'));

    expect(update?.result.published).toBe(true);
    expect(posted).toEqual(['Singularity reads 3 chains across two families.']);
  });

  it('strips quotes a model wrapped the post in', async () => {
    const { client, agent } = updateHarness('"Singularity reads 3 chains across two families."');
    const update = await postUpdate(client, agent, FACTS, briefFor('chainnote'));

    expect(update?.text.startsWith('"')).toBe(false);
  });

  it('posts nothing when the model declines to invent something', async () => {
    // The changelog angle is told to return nothing if it has nothing.
    const { client, agent, posted } = updateHarness('');
    const update = await postUpdate(client, agent, FACTS, briefFor('changelog'));

    expect(update).toBeNull();
    expect(posted).toEqual([]);
  });

  it('trims an over-long post rather than letting X reject it', async () => {
    const { client, agent } = updateHarness('word '.repeat(200));
    const update = await postUpdate(client, agent, FACTS, briefFor('philosophy'));

    expect(update!.text.length).toBeLessThanOrEqual(REPLY_LIMIT);
  });

  it('shows the model what it already posted', () => {
    const prompt = updatePrompt(FACTS, briefFor('chainnote'), [
      'Reaches 23 chains across four families.',
    ]);

    expect(prompt).toContain('already posted these');
    expect(prompt).toContain('Reaches 23 chains across four families.');
  });

  it('drops a post that restates a recent one', async () => {
    // At one post an hour the five angles come round in five hours, so this is
    // the guard that stops the second lap reading like the first.
    const previous = 'Singularity reaches 23 chains across EVM, Solana, Bitcoin and Cosmos.';
    const { client, agent, posted } = updateHarness(
      'Singularity reaches 23 chains across Solana, Bitcoin, Cosmos and EVM.',
    );

    const update = await postUpdate(client, agent, FACTS, briefFor('chainnote'), {
      recentPosts: [previous],
    });

    expect(update).toBeNull();
    expect(posted).toEqual([]);
  });

  it('still posts something genuinely different', async () => {
    const { client, agent } = updateHarness('Holds no keys and cannot broadcast a transaction.');

    const update = await postUpdate(client, agent, FACTS, briefFor('philosophy'), {
      recentPosts: ['Reaches 23 chains across EVM, Solana, Bitcoin and Cosmos.'],
    });

    expect(update).not.toBeNull();
  });

  it('measures similarity on shared content words', () => {
    expect(isTooSimilar('gas on base is cheap today', ['gas on base is cheap today'])).toBe(true);
    expect(isTooSimilar('builds unsigned transfers only', ['reaches 23 chains'])).toBe(false);
  });

  it('honours a dry run', async () => {
    const dryClient = {
      async post(text: string, options: { dryRun?: boolean }) {
        return { published: false, text, reason: options.dryRun ? 'Dry run requested.' : 'off' };
      },
    } as unknown as XClient;

    const { agent } = updateHarness('Singularity reads 3 chains across two families.');
    const update = await postUpdate(dryClient, agent, FACTS, briefFor('chainnote'), { dryRun: true });

    expect(update?.result.published).toBe(false);
  });
});
