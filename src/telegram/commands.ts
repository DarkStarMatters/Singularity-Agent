/**
 * Bot commands.
 *
 * Every handler goes through `src/tools/operations.ts` — the same layer the CLI
 * and the MCP server use — so the bot cannot drift from them. A handler returns
 * a rendered string or throws; the runtime turns a throw into a formatted error.
 */
import * as ops from '../tools/operations.js';
import { SingularityError } from '../core/errors.js';
import type { TelegramConfig } from './config.js';
import { runXCommand, type XControl } from './control.js';
import {
  formatBalance,
  formatBlock,
  formatChains,
  formatDecoded,
  formatFees,
  formatHealth,
  formatPortfolio,
  formatReadResult,
  formatResolved,
  formatTransactionSearch,
  formatUnsignedTx,
  esc,
} from './format.js';

export interface CommandContext {
  args: string[];
  chatId: number;
  chatType: 'private' | 'group' | 'supergroup' | 'channel';
  config: TelegramConfig;
  /** Drops this chat's conversational history. Absent when Grok is off. */
  forget?: () => void;
  /**
   * Puts a question to Grok and returns a reply, ready to send.
   *
   * Absent when no xAI key is configured. This is what `/chat` uses, and it
   * matters most in groups: with Telegram privacy mode on, an @mention never
   * reaches the bot, but a command always does.
   */
  converse?: (text: string) => Promise<string>;
  /** The X bot, when it runs in this process. Absent for the bot alone. */
  xControl?: XControl;
  /** Who sent the command, for the approval audit trail. */
  sender?: string;
}

export interface Command {
  name: string;
  usage: string;
  summary: string;
  /**
   * Other names that reach this command.
   *
   * The MCP tools are called `transaction`, `read_contract` and
   * `build_transfer`, and anyone registering a command menu from the tool
   * catalogue gets those names. They resolve here rather than being silently
   * ignored, which is what "the bot does not answer" looked like.
   */
  aliases?: string[];
  run(ctx: CommandContext): Promise<string> | string;
}

/** A missing argument is a user error, not a crash — reuse the hint channel. */
function required(ctx: CommandContext, index: number, name: string, command: Command): string {
  const value = ctx.args[index];
  if (!value) {
    throw new SingularityError(
      'MISSING_ARGUMENT',
      `/${command.name} needs ${name}.`,
      `Usage: ${command.usage}`,
    );
  }
  return value;
}

const chains: Command = {
  name: 'chains',
  usage: '/chains [filter]',
  summary: 'List supported chains',
  run: (ctx) => formatChains(ops.listChains(ctx.args[0])),
};

const resolve: Command = {
  name: 'resolve',
  usage: '/resolve <address|name|tx hash>',
  summary: 'Identify an address, name, or hash',
  async run(ctx) {
    const input = required(ctx, 0, 'something to resolve', resolve);
    return formatResolved(await ops.resolve(input, ctx.args[1]));
  },
};

const balance: Command = {
  name: 'balance',
  usage: '/balance <address> [chain]',
  summary: 'Balances for one address on one chain',
  async run(ctx) {
    const address = required(ctx, 0, 'an address', balance);
    return formatBalance(await ops.getBalance({ address, chain: ctx.args[1] ?? 'ethereum' }));
  },
};

const portfolio: Command = {
  name: 'portfolio',
  usage: '/portfolio <address> [chain,chain,…]',
  summary: 'One address across many chains',
  async run(ctx) {
    const address = required(ctx, 0, 'an address', portfolio);
    const requested = ctx.args[1]?.split(',').map((c) => c.trim()).filter(Boolean);

    return formatPortfolio(
      await ops.getPortfolio({
        address,
        ...(requested?.length ? { chains: requested } : ctx.config.defaultChains ? { chains: ctx.config.defaultChains } : {}),
      }),
    );
  },
};

const tx: Command = {
  name: 'tx',
  aliases: ['transaction'],
  usage: '/tx <hash> [chain]',
  summary: 'Look up a transaction',
  async run(ctx) {
    const hash = required(ctx, 0, 'a transaction hash', tx);
    return formatTransactionSearch(await ops.getTransaction({ hash, chain: ctx.args[1] }));
  },
};

const fees: Command = {
  name: 'fees',
  usage: '/fees <chain>',
  summary: 'Current fee conditions on a chain',
  async run(ctx) {
    const chain = required(ctx, 0, 'a chain', fees);
    return formatFees(await ops.getFees(chain));
  },
};

const block: Command = {
  name: 'block',
  usage: '/block <chain> [height|hash|latest]',
  summary: 'Fetch a block',
  async run(ctx) {
    const chain = required(ctx, 0, 'a chain', block);
    return formatBlock(await ops.getBlock({ chain, ref: ctx.args[1] ?? 'latest' }));
  },
};

const transfer: Command = {
  name: 'transfer',
  aliases: ['build_transfer'],
  usage: '/transfer <chain> <to> <amount> [token] [from]',
  summary: 'Build an UNSIGNED transfer to review',
  async run(ctx) {
    const chain = required(ctx, 0, 'a chain', transfer);
    const to = required(ctx, 1, 'a recipient', transfer);
    const amount = required(ctx, 2, 'an amount', transfer);

    return formatUnsignedTx(
      await ops.buildTransfer({ chain, to, amount, token: ctx.args[3], from: ctx.args[4] }),
    );
  },
};

const decode: Command = {
  name: 'decode',
  usage: '/decode <hex calldata> [abi entry]',
  summary: 'Decode EVM calldata into a function call',
  async run(ctx) {
    const data = required(ctx, 0, 'hex calldata', decode);

    // Everything after the data is one human-readable ABI entry, which contains
    // spaces — so it is rejoined rather than read as separate arguments.
    const abi = ctx.args.slice(1).join(' ').trim();
    return formatDecoded(ops.decode(data, abi ? [abi] : undefined));
  },
};

const read: Command = {
  name: 'read',
  aliases: ['read_contract'],
  usage: '/read <chain> <address> [method] [abi entry]',
  summary: 'Call a view function or read account data',
  async run(ctx) {
    const chain = required(ctx, 0, 'a chain', read);
    const address = required(ctx, 1, 'a contract address', read);

    const abi = ctx.args.slice(3).join(' ').trim();
    const value = await ops.readContract({
      chain,
      address,
      method: ctx.args[2],
      ...(abi ? { abi } : {}),
    });

    return formatReadResult(chain, address, value);
  },
};

const health: Command = {
  name: 'health',
  usage: '/health [chain,chain,…]',
  summary: 'Check which RPC endpoints are reachable',
  async run(ctx) {
    const named = ctx.args[0]?.split(',').map((c) => c.trim()).filter(Boolean);
    return formatHealth(await ops.checkEndpoints(named));
  },
};

const chat: Command = {
  name: 'chat',
  aliases: ['agent', 'ask'],
  usage: '/chat <question>',
  summary: 'Ask a question in plain English',
  async run(ctx) {
    if (!ctx.converse) {
      return 'Conversation is unavailable — no xAI key is configured. The lookup commands still work; try /help.';
    }

    const question = ctx.args.join(' ').trim();
    if (!question) {
      throw new SingularityError(
        'MISSING_ARGUMENT',
        '/chat needs a question.',
        'Usage: /chat what is gas on base right now?',
      );
    }
    return ctx.converse(question);
  },
};

const x: Command = {
  name: 'x',
  usage: '/x [status|pending|post|approve|reject|pause|resume]',
  summary: 'Control the X bot and approve its posts',
  run: (ctx) => runXCommand(ctx.xControl, ctx.args, ctx.sender),
};

const forget: Command = {
  name: 'forget',
  usage: '/forget',
  summary: 'Drop what I remember of this chat',
  run(ctx) {
    if (!ctx.forget) return 'I am not holding any conversation history — no xAI key is configured.';
    ctx.forget();
    return 'Forgotten. This chat starts fresh.';
  },
};

const chatid: Command = {
  name: 'chatid',
  usage: '/chatid',
  summary: 'Show this chat id (for the allowlist)',
  run: (ctx) =>
    [
      `Chat id: <code>${esc(ctx.chatId)}</code>`,
      `Type: ${esc(ctx.chatType)}`,
      '',
      '<i>Add this to TELEGRAM_ALLOWED_CHATS in .env to restrict the bot to this chat.</i>',
    ].join('\n'),
};

const help: Command = {
  name: 'help',
  usage: '/help',
  summary: 'Show this message',
  run(ctx) {
    const lines = [
      '<b>Singularity</b> — read-only blockchain lookups across EVM, Solana, Bitcoin and Cosmos.',
      '',
    ];
    for (const command of COMMAND_LIST) {
      lines.push(`<code>${esc(command.usage)}</code> — ${esc(command.summary)}`);
    }

    lines.push('', '<i>Holds no keys. Cannot sign or broadcast anything.</i>');
    if (ctx.chatType !== 'private') {
      lines.push('<i>In groups, address me directly if another bot shares a command name.</i>');
    }
    return lines.join('\n');
  },
};

const start: Command = {
  name: 'start',
  usage: '/start',
  summary: 'Introduce the bot',
  run: (ctx) => help.run(ctx),
};

/** Order here is the order `/help` lists them. */
const COMMAND_LIST: Command[] = [
  balance,
  portfolio,
  tx,
  resolve,
  fees,
  block,
  chains,
  transfer,
  read,
  decode,
  health,
  chat,
  x,
  forget,
  chatid,
  help,
];

/** Canonical names and aliases both resolve to the same command. */
export const COMMANDS = new Map<string, Command>();

for (const command of [...COMMAND_LIST, start]) {
  COMMANDS.set(command.name, command);
  for (const alias of command.aliases ?? []) COMMANDS.set(alias, command);
}

/** For BotFather's /setcommands, so the group command menu matches reality. */
export function botFatherCommandList(): string {
  return COMMAND_LIST.map((c) => `${c.name} - ${c.summary}`).join('\n');
}

/**
 * The menu the bot registers with Telegram on startup.
 *
 * Generated from the same list the runtime dispatches on, because the two
 * getting out of step is not a cosmetic problem: a menu entry with no command
 * behind it does nothing at all when tapped — no reply, no error, nothing to
 * search the logs for. That is exactly how `/transaction` and `/read_contract`
 * came to be advertised by a bot that only answers `/tx` and `/read`.
 */
export function commandMenu(): Array<{ command: string; description: string }> {
  return COMMAND_LIST.map((command) => ({
    command: command.name,
    description: command.summary,
  }));
}
