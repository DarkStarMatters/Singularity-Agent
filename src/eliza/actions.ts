/**
 * elizaOS actions for the read-only chain surface.
 *
 * Each action is a thin wrapper: parse the sentence, call the same
 * `src/tools/operations.ts` function the CLI and MCP server call, render with
 * the same formatter the Telegram bot uses. Nothing chain-aware lives here, so
 * a new chain in the registry shows up in Eliza with no change to this file.
 *
 * Two things are worth knowing about how Eliza drives these:
 *
 *   - `validate` runs before the model is asked to choose. Returning false for
 *     a message that lacks the required argument is what stops the agent
 *     picking BALANCE for "how are fees today" and then erroring in front of
 *     the user.
 *   - A handler must not throw. A throw aborts the whole action pipeline; a
 *     failed `ActionResult` lets the agent explain itself and carry on, so
 *     every error is caught and rendered.
 */
import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
} from '@elizaos/core';
import * as ops from '../tools/operations.js';
import {
  formatBalance,
  formatBlock,
  formatChains,
  formatError,
  formatFees,
  formatPortfolio,
  formatResolved,
  formatTransactionSearch,
  formatUnsignedTx,
} from '../telegram/format.js';
import { toPlainText } from './plain.js';
import { parseQuery, parseTransfer, type ParsedQuery } from './parse.js';

export interface ActionRunContext {
  runtime: IAgentRuntime;
  /** The user's message, verbatim. */
  text: string;
  query: ParsedQuery;
  options: HandlerOptions;
}

export interface ActionOutput {
  /** Already rendered as plain text, ready to send. */
  text: string;
  /** The structured result, for actions chained after this one. */
  data?: Record<string, unknown>;
}

interface ActionSpec {
  name: string;
  similes: string[];
  description: string;
  examples: ActionExample[][];
  /** Pure, so it can be tested without a runtime. */
  validate(query: ParsedQuery, text: string): boolean;
  run(ctx: ActionRunContext): Promise<ActionOutput>;
}

export function messageText(message: Memory): string {
  return message.content?.text ?? '';
}

/** Word-boundary match, so "fees" does not fire on "coffees". */
function mentions(text: string, words: string[]): boolean {
  const lower = text.toLowerCase();
  return words.some((word) => new RegExp(`\\b${word}\\b`).test(lower));
}

function defineAction(spec: ActionSpec): Action {
  return {
    name: spec.name,
    similes: spec.similes,
    description: spec.description,
    examples: spec.examples,

    validate: async (_runtime, message) => {
      const text = messageText(message);
      return text ? spec.validate(parseQuery(text), text) : false;
    },

    handler: async (
      runtime: IAgentRuntime,
      message: Memory,
      _state,
      options?: HandlerOptions,
      callback?: HandlerCallback,
    ): Promise<ActionResult> => {
      const text = messageText(message);

      try {
        const output = await spec.run({
          runtime,
          text,
          query: parseQuery(text),
          options: options ?? {},
        });

        await callback?.({ text: output.text, actions: [spec.name] });
        return { success: true, text: output.text, ...(output.data ? { data: output.data } : {}) };
      } catch (err) {
        // `formatError` renders the hint too, which is the part that tells the
        // agent what to try next.
        const rendered = toPlainText(formatError(err));
        await callback?.({ text: rendered, actions: [spec.name] });

        return {
          success: false,
          text: rendered,
          error: err instanceof Error ? err : new Error(String(err)),
        };
      }
    },
  };
}

const BALANCE_WORDS = ['balance', 'balances', 'holding', 'holdings', 'hold', 'own', 'owns', 'have'];
const PORTFOLIO_WORDS = ['portfolio', 'across', 'everywhere', 'net worth'];

function isPortfolioQuestion(query: ParsedQuery, text: string): boolean {
  return mentions(text, PORTFOLIO_WORDS) || query.chains.length > 1;
}

export const balanceAction = defineAction({
  name: 'SINGULARITY_BALANCE',
  similes: ['GET_BALANCE', 'CHECK_BALANCE', 'WALLET_BALANCE', 'TOKEN_BALANCE'],
  description:
    'Look up the native and major-token balances for one address or name on one chain. Use when a single chain is named, or when none is and only one is implied. Requires an address, ENS name, or .sol name in the message.',
  examples: [
    [
      {
        name: '{{user}}',
        content: { text: 'what does 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 hold on base?' },
      },
      {
        name: '{{agent}}',
        content: { text: 'Checking that address on Base.', actions: ['SINGULARITY_BALANCE'] },
      },
    ],
    [
      { name: '{{user}}', content: { text: 'balance of vitalik.eth' } },
      {
        name: '{{agent}}',
        content: { text: 'Looking it up on Ethereum.', actions: ['SINGULARITY_BALANCE'] },
      },
    ],
  ],

  // Portfolio wins when both could match — "holdings across base and arbitrum"
  // is a portfolio question that happens to contain a balance word.
  validate: (query, text) =>
    Boolean(query.subject) && mentions(text, BALANCE_WORDS) && !isPortfolioQuestion(query, text),

  async run({ query }) {
    const result = await ops.getBalance({
      address: query.subject!,
      chain: query.chains[0] ?? 'ethereum',
    });
    return { text: toPlainText(formatBalance(result)), data: { balance: result } };
  },
});

export const portfolioAction = defineAction({
  name: 'SINGULARITY_PORTFOLIO',
  similes: ['GET_PORTFOLIO', 'MULTI_CHAIN_BALANCE', 'CHECK_PORTFOLIO'],
  description:
    'Sweep one address or name across several chains at once and report what it holds on each. Use when more than one chain is named, or when the question is about holdings generally rather than on a named chain.',
  examples: [
    [
      {
        name: '{{user}}',
        content: { text: 'show me vitalik.eth across base, arbitrum and optimism' },
      },
      {
        name: '{{agent}}',
        content: { text: 'Sweeping those three chains.', actions: ['SINGULARITY_PORTFOLIO'] },
      },
    ],
  ],

  validate: (query, text) =>
    Boolean(query.subject) && (isPortfolioQuestion(query, text) || mentions(text, BALANCE_WORDS)),

  async run({ query }) {
    const result = await ops.getPortfolio({
      address: query.subject!,
      ...(query.chains.length ? { chains: query.chains } : {}),
    });
    return { text: toPlainText(formatPortfolio(result)), data: { portfolio: result } };
  },
});

export const transactionAction = defineAction({
  name: 'SINGULARITY_TRANSACTION',
  similes: ['GET_TRANSACTION', 'LOOKUP_TX', 'CHECK_TX', 'TX_STATUS'],
  description:
    'Look up a transaction by hash and report its status, participants, value and fee. Requires a transaction hash in the message.',
  examples: [
    [
      {
        name: '{{user}}',
        content: {
          text: 'did 0x88df016429689c079f3b2f6ad39fa052532c56795b733da78a91ebe6a713944b go through?',
        },
      },
      {
        name: '{{agent}}',
        content: { text: 'Looking that hash up.', actions: ['SINGULARITY_TRANSACTION'] },
      },
    ],
  ],

  validate: (query) => Boolean(query.txHash),

  async run({ query }) {
    const result = await ops.getTransaction({
      hash: query.txHash!,
      ...(query.chains[0] ? { chain: query.chains[0] } : {}),
    });
    return { text: toPlainText(formatTransactionSearch(result)), data: { transaction: result } };
  },
});

export const resolveAction = defineAction({
  name: 'SINGULARITY_RESOLVE',
  similes: ['IDENTIFY_ADDRESS', 'RESOLVE_NAME', 'RESOLVE_ENS'],
  description:
    'Identify what a bare string is — an address, a transaction hash, or a name — and which chains it could belong to. Use when the user asks what something is rather than asking for its balance or status.',
  examples: [
    [
      { name: '{{user}}', content: { text: 'what is bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq?' } },
      { name: '{{agent}}', content: { text: 'Identifying it.', actions: ['SINGULARITY_RESOLVE'] } },
    ],
  ],

  validate: (query, text) =>
    Boolean(query.subject || query.txHash) &&
    mentions(text, ['what', 'whats', 'which', 'identify', 'resolve', 'kind', 'type']),

  async run({ query }) {
    const input = query.subject ?? query.txHash!;
    const result = await ops.resolve(input, query.chains[0]);
    return { text: toPlainText(formatResolved(result)), data: { resolved: result } };
  },
});

export const feesAction = defineAction({
  name: 'SINGULARITY_FEES',
  similes: ['GET_FEES', 'GAS_PRICE', 'CHECK_GAS', 'NETWORK_FEES'],
  description:
    'Report current fee or gas conditions on one chain. Requires a chain to be named in the message.',
  examples: [
    [
      { name: '{{user}}', content: { text: 'how is gas on ethereum right now?' } },
      {
        name: '{{agent}}',
        content: { text: 'Checking current fees.', actions: ['SINGULARITY_FEES'] },
      },
    ],
  ],

  validate: (query, text) =>
    query.chains.length > 0 &&
    mentions(text, ['fee', 'fees', 'gas', 'gwei', 'cost', 'expensive', 'cheap']),

  async run({ query }) {
    const result = await ops.getFees(query.chains[0]!);
    return { text: toPlainText(formatFees(result)), data: { fees: result } };
  },
});

export const blockAction = defineAction({
  name: 'SINGULARITY_BLOCK',
  similes: ['GET_BLOCK', 'LATEST_BLOCK', 'BLOCK_HEIGHT', 'CHAIN_TIP'],
  description:
    'Fetch a block by height, hash, or the chain tip. Requires a chain to be named in the message.',
  examples: [
    [
      { name: '{{user}}', content: { text: 'what is the latest block on solana?' } },
      { name: '{{agent}}', content: { text: 'Fetching the tip.', actions: ['SINGULARITY_BLOCK'] } },
    ],
  ],

  validate: (query, text) =>
    query.chains.length > 0 && mentions(text, ['block', 'blocks', 'height', 'tip', 'slot']),

  async run({ query, text }) {
    // A height is the one numeric argument a block question carries, and
    // `parseQuery` already pulled it out as `amount`.
    const ref = /\b(latest|tip|current)\b/i.test(text) ? 'latest' : query.amount ?? 'latest';
    const result = await ops.getBlock({ chain: query.chains[0]!, ref });
    return { text: toPlainText(formatBlock(result)), data: { block: result } };
  },
});

export const chainsAction = defineAction({
  name: 'SINGULARITY_CHAINS',
  similes: ['LIST_CHAINS', 'SUPPORTED_CHAINS', 'WHAT_CHAINS'],
  description:
    'List the chains this agent can query, optionally filtered. Use when the user asks what is supported.',
  examples: [
    [
      { name: '{{user}}', content: { text: 'which chains do you support?' } },
      {
        name: '{{agent}}',
        content: { text: 'Here is the full list.', actions: ['SINGULARITY_CHAINS'] },
      },
    ],
  ],

  // No address, no hash: this is the one action that answers a bare question.
  validate: (query, text) =>
    !query.subject &&
    !query.txHash &&
    mentions(text, ['chain', 'chains', 'network', 'networks', 'support', 'supported']),

  async run({ query }) {
    const result = ops.listChains(query.chains[0]);
    return { text: toPlainText(formatChains(result)), data: { chains: result } };
  },
});

export const buildTransferAction = defineAction({
  name: 'SINGULARITY_BUILD_TRANSFER',
  similes: ['PREPARE_TRANSFER', 'DRAFT_TRANSACTION', 'BUILD_TX'],
  description:
    'Build an UNSIGNED transfer payload for the user to review and sign in their own wallet. This agent holds no keys and cannot sign or broadcast — the output is a draft, never a sent transaction. Requires a chain, a recipient and an amount.',
  examples: [
    [
      { name: '{{user}}', content: { text: 'prepare a transfer of 0.1 ETH to vitalik.eth on base' } },
      {
        name: '{{agent}}',
        content: {
          text: 'Building an unsigned payload for you to review — I cannot sign or send it.',
          actions: ['SINGULARITY_BUILD_TRANSFER'],
        },
      },
    ],
  ],

  validate: (query, text) =>
    Boolean(query.subject) &&
    query.amount !== undefined &&
    query.chains.length > 0 &&
    mentions(text, ['transfer', 'send', 'pay', 'move', 'prepare', 'draft', 'build']),

  async run({ text }) {
    const transfer = parseTransfer(text);
    const result = await ops.buildTransfer({
      chain: transfer.chains[0]!,
      to: transfer.subject!,
      amount: transfer.amount!,
      ...(transfer.token ? { token: transfer.token } : {}),
    });

    return {
      // The warning block that `formatUnsignedTx` renders is the point of this
      // action; it must reach the user, not be summarized away.
      text: toPlainText(formatUnsignedTx(result)),
      data: { unsignedTransaction: result },
    };
  },
});

export const chainActions: Action[] = [
  balanceAction,
  portfolioAction,
  transactionAction,
  resolveAction,
  feesAction,
  blockAction,
  chainsAction,
  buildTransferAction,
];
