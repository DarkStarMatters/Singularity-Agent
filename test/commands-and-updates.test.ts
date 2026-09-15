import { describe, it, expect } from 'vitest';
import { COMMANDS, botFatherCommandList, commandMenu } from '../src/telegram/commands.js';
import { TOOLS } from '../src/tools/catalog.js';
import { formatDecoded, formatHealth, formatReadResult } from '../src/telegram/format.js';
import {
  UPDATE_ANGLES,
  collectProjectFacts,
  factSheet,
  isDue,
  isTooSimilar,
  nextAngle,
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
  build_transfer: 'transfer',
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
    for (const name of ['health', 'forget', 'chatid', 'help', 'start']) {
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
};

describe('project update grounding', () => {
  it('reads real facts out of the repository', () => {
    const facts = collectProjectFacts();

    expect(facts.chainCount).toBeGreaterThan(0);
    expect(facts.toolCount).toBe(TOOLS.length);
    expect(facts.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('only shows the angle the facts it may use', () => {
    // A coverage post must not be handed the commit log to embellish with.
    expect(factSheet(FACTS, 'coverage')).toContain('ethereum');
    expect(factSheet(FACTS, 'coverage')).not.toContain('Fix Solana block lookups');
    expect(factSheet(FACTS, 'changelog')).toContain('Fix Solana block lookups');
  });

  it('tells the model that anything outside the facts does not exist', () => {
    const prompt = updatePrompt(FACTS, 'coverage');

    expect(prompt).toContain('anything not here does not exist');
    expect(prompt).toContain('Do not invent');
    expect(prompt).toContain(String(REPLY_LIMIT));
  });

  it('rotates through every angle before repeating one', () => {
    const used: string[] = [];
    for (let i = 0; i < UPDATE_ANGLES.length; i++) {
      used.unshift(nextAngle(used as never, FACTS));
    }

    expect(new Set(used).size).toBe(UPDATE_ANGLES.length);
  });

  it('never picks the changelog angle with no commits to report', () => {
    const noCommits = { ...FACTS, recentChanges: [] };

    for (let i = 0; i < 10; i++) {
      expect(nextAngle(UPDATE_ANGLES.slice(0, i) as never, noCommits)).not.toBe('changelog');
    }
  });

  it('never picks the roadmap angle when the roadmap could not be read', () => {
    // An installed copy of the package ships no roadmap.md.
    const noRoadmap = { ...FACTS, shipped: [], planned: [] };

    for (let i = 0; i < 10; i++) {
      expect(nextAngle(UPDATE_ANGLES.slice(0, i) as never, noRoadmap)).not.toBe('roadmap');
    }
  });

  it('separates what is shipped from what is only planned', () => {
    const sheet = factSheet(FACTS, 'roadmap');

    // An agent announcing a planned feature as a built one is the specific
    // failure this labelling exists to prevent.
    expect(sheet).toContain('exists today');
    expect(sheet).toContain('NOT built yet');
    expect(sheet.indexOf('Coverage: 3 chains')).toBeLessThan(sheet.indexOf('Historical state'));
  });

  it('keeps the roadmap out of angles that should not cite it', () => {
    expect(factSheet(FACTS, 'coverage')).not.toContain('Historical state');
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
    const update = await postUpdate(client, agent, FACTS, 'coverage');

    expect(update?.result.published).toBe(true);
    expect(posted).toEqual(['Singularity reads 3 chains across two families.']);
  });

  it('strips quotes a model wrapped the post in', async () => {
    const { client, agent } = updateHarness('"Singularity reads 3 chains across two families."');
    const update = await postUpdate(client, agent, FACTS, 'coverage');

    expect(update?.text.startsWith('"')).toBe(false);
  });

  it('posts nothing when the model declines to invent something', async () => {
    // The changelog angle is told to return nothing if it has nothing.
    const { client, agent, posted } = updateHarness('');
    const update = await postUpdate(client, agent, FACTS, 'changelog');

    expect(update).toBeNull();
    expect(posted).toEqual([]);
  });

  it('trims an over-long post rather than letting X reject it', async () => {
    const { client, agent } = updateHarness('word '.repeat(200));
    const update = await postUpdate(client, agent, FACTS, 'philosophy');

    expect(update!.text.length).toBeLessThanOrEqual(REPLY_LIMIT);
  });

  it('shows the model what it already posted', () => {
    const prompt = updatePrompt(FACTS, 'coverage', ['Reaches 23 chains across four families.']);

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

    const update = await postUpdate(client, agent, FACTS, 'coverage', {
      recentPosts: [previous],
    });

    expect(update).toBeNull();
    expect(posted).toEqual([]);
  });

  it('still posts something genuinely different', async () => {
    const { client, agent } = updateHarness('Holds no keys and cannot broadcast a transaction.');

    const update = await postUpdate(client, agent, FACTS, 'safety', {
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
    const update = await postUpdate(dryClient, agent, FACTS, 'coverage', { dryRun: true });

    expect(update?.result.published).toBe(false);
  });
});
