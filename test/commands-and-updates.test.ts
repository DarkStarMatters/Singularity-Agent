import { describe, it, expect } from 'vitest';
import { COMMANDS, botFatherCommandList } from '../src/telegram/commands.js';
import { TOOLS } from '../src/tools/catalog.js';
import { formatDecoded, formatHealth, formatReadResult } from '../src/telegram/format.js';
import {
  UPDATE_ANGLES,
  collectProjectFacts,
  factSheet,
  isDue,
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
