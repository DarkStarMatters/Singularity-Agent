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
import {
  formatBalance,
  formatBlock,
  formatChains,
  formatFees,
  formatPortfolio,
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
}

export interface Command {
  name: string;
  usage: string;
  summary: string;
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
  chatid,
  help,
];

export const COMMANDS = new Map<string, Command>(
  [...COMMAND_LIST, start].map((command) => [command.name, command]),
);

/** For BotFather's /setcommands, so the group command menu matches reality. */
export function botFatherCommandList(): string {
  return COMMAND_LIST.map((c) => `${c.name} - ${c.summary}`).join('\n');
}
