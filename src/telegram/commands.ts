/**
 * Bot commands.
 *
 * Every handler goes through `src/tools/operations.ts` — the same layer the CLI
 * and the MCP server use — so the bot cannot drift from them. A handler returns
 * a rendered string or throws; the runtime turns a throw into a formatted error.
 */
import * as ops from '../tools/operations.js';
import { burnLink } from '../pay/transaction-request.js';
import { qrMatrix } from '../core/qr.js';
import { qrArtPng } from '../art/raster.js';
import { FileIntentStore, allowedRecipients } from '../pay/file-store.js';
import { createIntent as createPayIntent, settleIntent as settlePayIntent } from '../pay/operations.js';
import { payCaption } from '../pay/notify.js';
import { isExpired } from '../pay/intent.js';
import { chatFromMemo } from './payments.js';
import { SingularityError } from '../core/errors.js';
import type { TelegramConfig } from './config.js';
import { runDraftsCommand, runXCommand, type XControl } from './control.js';
import type { InlineKeyboard } from './api.js';
import {
  formatBalance,
  formatBlock,
  formatChains,
  formatDecoded,
  formatFees,
  formatHistory,
  formatLiveness,
  formatPortfolio,
  formatReadResult,
  formatResolved,
  formatTransactionSearch,
  formatUnsignedTx,
  formatMintAudit,
  formatBurnClaim,
  formatExitReport,
  formatIntentList,
  formatSettlement,
  formatTokenIdentity,
  bold,
  code,
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
  /** True when this chat is the one approval cards are sent to. */
  isControlChat?: boolean;
}

/**
 * What a command hands back.
 *
 * Most return a string. A command that offers a decision — approving a post —
 * returns buttons with it, because a list of ids to retype is a worse
 * interface than a tap for exactly the action you already decided on.
 */
export type CommandResult =
  | string
  | { text: string; keyboard?: InlineKeyboard }
  /**
   * An image, for the one thing a chat message cannot carry: something to
   * point a phone at. A `solana:` link is not scannable as text, so an
   * approval that expects a wallet has to arrive as a picture.
   */
  | { photo: Uint8Array; caption?: string; filename?: string };

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
  run(ctx: CommandContext): Promise<CommandResult> | CommandResult;
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

const history: Command = {
  name: 'history',
  usage: '/history <address> <chain> [limit]',
  summary: 'What an address has been doing',
  async run(ctx) {
    const address = required(ctx, 0, 'an address', history);
    const chain = required(ctx, 1, 'a chain', history);
    const limit = Number(ctx.args[2] ?? 10);

    return formatHistory(
      await ops.getHistory({
        address,
        chain,
        limit: Number.isFinite(limit) ? limit : 10,
      }),
    );
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
    return formatDecoded(await ops.decode(data, abi ? [abi] : undefined));
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

const mint: Command = {
  name: 'mint',
  aliases: ['mint_audit', 'audit'],
  usage: '/mint <mint address> [chain]',
  summary: 'Audit a Solana mint: what it can still do to a holder',
  async run(ctx) {
    const address = required(ctx, 0, 'a mint address', mint);
    return formatMintAudit(await ops.auditMint({ mint: address, chain: ctx.args[1] }));
  },
};

/**
 * What a burn has to say in its memo to be credited to this chat.
 *
 * A burn signature is public the moment it lands, so redemption keyed on the
 * signature alone is first-come-first-served: whoever watches the chain and
 * quotes it first takes the credit. The memo is the only part of the
 * transaction the burner writes and signs, so a claim written there costs a
 * burn of your own to forge.
 *
 * The identifier is the chat, which means exactly what it says: in a direct
 * message that is one person, and in a group it is the group — anybody in the
 * room can redeem a burn carrying it. That is a reasonable thing to want and a
 * terrible thing to assume, so both commands say which they are talking to.
 */
function burnClaim(chatId: number): string {
  return `sngl:${chatId}`;
}

/** Binds a payment to this chat, the way burnClaim binds a burn. */
function payClaim(chatId: number): string {
  return `sngl-pay:${chatId}`;
}

/** One store per process; the file is the shared state, not this object. */
let sharedPayStore: FileIntentStore | undefined;
function payStore(): FileIntentStore {
  sharedPayStore ??= new FileIntentStore();
  return sharedPayStore;
}

/**
 * `--flag value` out of a whitespace-split command line.
 *
 * Deliberately tiny and deliberately not a parser library. Every value this
 * takes is an address, an amount or an id — none contain spaces — so the only
 * thing worth handling is a flag whose value is missing, which reads as the
 * next flag rather than as an argument.
 */
export function flags(args: string[]): { positional: string[]; flag: (name: string) => string | undefined } {
  const named = new Map<string, string>();
  const positional: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }

    const next = args[i + 1];
    // `--to --sender x` means `--to` was given nothing. Treating the following
    // flag as its value is how an address ends up being "--sender".
    if (next === undefined || next.startsWith('--')) continue;

    named.set(arg.slice(2).toLowerCase(), next);
    i += 1;
  }

  return { positional, flag: (name) => named.get(name.toLowerCase()) };
}

const pay: Command = {
  name: 'pay',
  aliases: ['request', 'invoice'],
  usage: '/pay <amount> [--to <recipient>] [--sender <wallet>] [--token <mint>] [--order <id>]',
  summary: 'Create a payment request — a QR somebody can scan to pay you',
  async run(ctx) {
    const { positional, flag } = flags(ctx.args);
    const amount = positional[0];

    if (!amount) {
      throw new SingularityError('MISSING_ARGUMENT', '/pay needs an amount.', `Usage: ${pay.usage}`);
    }

    const mint = flag('token') ?? flag('mint') ?? positional[1];
    const orderId = flag('order') ?? positional[2];
    const sender = flag('sender') ?? flag('from');

    const recipients = allowedRecipients();
    const asked = flag('to');

    /**
     * Where the money goes, and who is allowed to decide.
     *
     * A recipient named in a message is the thing the allowlist was added to
     * prevent: anyone in a group could type `/pay 50 <their own address>` and
     * receive an official-looking QR under this bot's name, which the next
     * person to scan has every reason to trust.
     *
     * So it depends on who is asking. In a DM or the control chat the operator
     * is driving and may name any recipient — the same reasoning that lets
     * `/redeem` exist there and nowhere else. In a group the allowlist still
     * decides, and `--to` may only pick among addresses already configured.
     */
    const operatorDriving = ctx.chatType === 'private' || ctx.isControlChat === true;

    let to: string;
    if (asked) {
      if (!operatorDriving && !recipients.includes(asked)) {
        throw new SingularityError(
          'RECIPIENT_NOT_ALLOWED',
          `This chat cannot send payments to ${asked}.`,
          recipients.length > 0
            ? `In a group, --to may only name an address from SINGULARITY_PAY_RECIPIENTS: ${recipients.join(', ')}. A bot that builds a payment request to whatever address it is handed is a way to get a stranger paid under your name. In a DM or the control chat, any recipient is allowed.`
            : 'Set SINGULARITY_PAY_RECIPIENTS, or run this in a DM or the control chat where you are the one driving.',
        );
      }
      to = asked;
    } else if (recipients.length > 0) {
      to = recipients[0]!;
    } else {
      throw new SingularityError(
        'NO_PAY_RECIPIENTS',
        'No recipient given and none configured.',
        'Pass --to <address>, or set SINGULARITY_PAY_RECIPIENTS to the address you want to be paid at.',
      );
    }

    const created = await createPayIntent(payStore(), process.env.SINGULARITY_PAYMENT_ENDPOINT ?? '', {
      to,
      amount,
      ...(mint ? { mint } : {}),
      ...(orderId ? { orderId } : {}),
      label: orderId ? `Payment ${orderId}` : `Payment of ${amount}`,
      // Binds the payment to this chat, the way /burn binds a claim, so a
      // settlement is credited to whoever asked rather than to whoever quotes
      // the reference first.
      memo: payClaim(ctx.chatId),
    });

    /**
     * What a named sender buys.
     *
     * A transfer request has no sender field — the payer is whoever scans it,
     * and the spec has nowhere to put one. So `--sender` does the thing that is
     * actually useful with that knowledge: it builds the transfer for that
     * wallet now, which reads the chain and fails *here* rather than on the
     * customer's approval screen. A missing token account or a balance short of
     * the amount is the common way a payment dies, and it is worth learning
     * before the QR is in front of anybody.
     *
     * The QR is unchanged either way — it stays scannable by any wallet.
     */
    let senderNote = '';
    if (sender) {
      senderNote = await describeSender(sender, created.intent.chain, to, amount, mint);
    }

    // Seeded by the reference, so this payment's code is this payment's code
    // and no other's. The matrix is identical either way — the art decides how
    // a module is drawn and never which modules there are.
    return {
      photo: qrArtPng(qrMatrix(created.url), created.intent.reference, { scale: 8 }),
      filename: `payment-${created.intent.id.slice(0, 8)}.png`,
      caption: payCaption(created) + senderNote,
    };
  },
};

/**
 * Whether a named wallet can actually complete this payment.
 *
 * The point of `--sender`. A transfer request has no sender field — the payer
 * is whoever scans it — so knowing one in advance is only worth anything if it
 * is used to check, and the check has to be the balance rather than the build.
 *
 * That distinction cost a round of testing. Building the transfer reads the
 * chain and catches a missing token account, but for native SOL it constructs a
 * `SystemProgram.transfer` without looking at what the wallet holds, so an
 * empty account came back clean. A flag that says "checked" while checking
 * nothing is worse than no flag.
 */
async function describeSender(
  sender: string,
  chain: string,
  to: string,
  amount: string,
  mint: string | undefined,
): Promise<string> {
  try {
    const balance = await ops.getBalance({
      address: sender,
      chain,
      includeTokens: Boolean(mint),
      ...(mint ? { tokens: [mint] } : {}),
    });

    const held = mint
      ? balance.tokens.find((entry) => entry.token?.address === mint)?.amount
      : balance.native.amount;

    const lines = ['', `${bold('Sender')} ${code(sender)}`];

    if (!held) {
      // Absent is not zero. For a token it means no account for this mint at
      // all, which fails differently and is worth saying differently.
      lines.push(
        mint
          ? `⚠️ Holds no account for this mint, so it cannot pay in it yet. The first transfer in has to create one, which costs about 0.002 SOL of rent.`
          : `⚠️ Balance could not be read, so nothing here says whether this wallet can pay.`,
      );
      return lines.join('\n');
    }

    const short = Number(held.formatted) < Number(amount);
    lines.push(
      short
        ? `⚠️ Holds ${bold(held.formatted)} ${esc(held.symbol)} and this asks for ${bold(amount)} — short by ${esc(String(Number(amount) - Number(held.formatted)))}.`
        : `Holds ${bold(held.formatted)} ${esc(held.symbol)}, enough for ${esc(amount)}.`,
    );

    if (!mint && !short) {
      // Fees come out of the same balance, and a wallet holding exactly the
      // amount cannot pay it.
      lines.push(`<i>Network fees come out of this too, so an exact balance will not cover it.</i>`);
    }

    return lines.join('\n');
  } catch (err) {
    // Failing to read is an answer, and a different one from failing to afford.
    const message = err instanceof SingularityError ? err.message : String(err);
    return ['', `${bold('Sender')} ${code(sender)}`, `⚠️ ${esc(message)}`].join('\n');
  }
}

const paid: Command = {
  name: 'paid',
  aliases: ['settled', 'pay_status'],
  usage: '/paid <intent id>',
  summary: 'Has a payment request been paid, and is it safe to act on?',
  async run(ctx) {
    const id = required(ctx, 0, 'a payment request id', paid);
    const result = await settlePayIntent(payStore(), id);
    return formatSettlement(result);
  },
};

const payments: Command = {
  name: 'payments',
  aliases: ['paylist', 'requests'],
  usage: '/payments [open|all]',
  summary: 'Payment requests this bot has created',
  async run(ctx) {
    const all = await payStore().all();
    const wantAll = ctx.args[0]?.toLowerCase() === 'all';

    // Only this chat's own requests by default. The memo carries the chat that
    // asked, so a group cannot list what another group is owed — which matters
    // because an amount and a reference together are most of an invoice.
    const mine = all.filter((intent) => chatFromMemo(intent.memo) === ctx.chatId);
    const shown = (wantAll ? mine : mine.filter((i) => !i.settledAt && !isExpired(i))).slice(0, 15);

    if (shown.length === 0) {
      return wantAll
        ? 'No payment requests from this chat yet. <code>/pay &lt;amount&gt;</code> makes one.'
        : 'No open payment requests. <code>/payments all</code> includes settled and expired ones.';
    }

    return formatIntentList(shown, mine.length);
  },
};

const burn: Command = {
  name: 'burn',
  aliases: ['build_burn'],
  usage: '/burn <mint> <amount> [your wallet] [chain]',
  summary: 'Burn tokens — tap to approve in your wallet',
  async run(ctx) {
    const mint = required(ctx, 0, 'a mint address', burn);
    const amount = required(ctx, 1, 'an amount', burn);
    const owner = ctx.args[2];
    const claim = burnClaim(ctx.chatId);
    const whose = ctx.chatType === 'private' ? 'you' : 'this group';

    const endpoint = process.env.SINGULARITY_PAY_ENDPOINT?.trim();

    // The link is the answer wherever one can be made. Handing somebody base64
    // in a chat message asks them to own the signing step *and* to tell two
    // long opaque strings apart — the payload and, minutes later, the
    // signature. Everything below exists because watching that fail is what
    // paid for it.
    if (endpoint && !owner) {
      const link = burnLink(endpoint, { mint, amount, memo: claim, chain: ctx.args[3] });

      // A link in a chat message is tappable on the device reading it and
      // useless to anyone holding a different phone — which is the usual case,
      // since the wallet is rarely on the machine that asked. The QR carries
      // the same link, so one message serves both.
      //
      // The caption keeps the memo explanation rather than trimming to fit:
      // the memo is what decides who can claim the burn, and losing it to a
      // character limit would be losing the point of the message.
      const caption = [
        `${bold('Burn')} ${esc(amount)} — scan it, or tap the link`,
        '',
        link,
        '',
        `Your wallet supplies the address, so there is nothing to type. It shows you the burn and the memo ${code(claim)} before you approve, and nothing happens until you do.`,
        '',
        `<i>${esc(
          `The memo credits this burn to ${whose} when you /redeem the signature your wallet gives back. Burn without one and anyone who sees the signature can claim it first.`,
        )}</i>`,
        '',
        `<i>${esc('Singularity holds no keys and cannot sign.')}</i>`,
      ].join('\n');

      return {
        photo: qrArtPng(qrMatrix(link), link, { scale: 8 }),
        filename: `burn-${amount}.png`,
        caption,
      };
    }

    // Naming a wallet explicitly still produces the raw payload, for anyone
    // signing with their own tooling — and it is the whole flow when no
    // endpoint is configured.
    const built = await ops.buildBurn({
      mint,
      amount,
      owner: required(ctx, 2, 'the wallet holding the tokens', burn),
      memo: claim,
      chain: ctx.args[3],
    });

    const note =
      `\n\nThis burn carries the memo ${code(claim)}, which is what credits it ` +
      `to ${whose} when you ${code('/redeem')} the signature. Burn without it and ` +
      'anyone who sees the signature can claim it first.' +
      (endpoint
        ? ''
        : `\n\n<i>${esc(
            'Set SINGULARITY_PAY_ENDPOINT to a deployed /api/burn and this command hands you a link to tap instead of a string to sign.',
          )}</i>`);

    return formatUnsignedTx(built) + note;
  },
};

const verifyburn: Command = {
  name: 'verifyburn',
  aliases: ['verify_burn'],
  usage: '/verifyburn <signature> [mint] [owner]',
  summary: 'Confirm a burn from its signature',
  async run(ctx) {
    const signature = required(ctx, 0, 'a transaction signature', verifyburn);

    return formatBurnClaim(
      await ops.verifyBurn({ signature, mint: ctx.args[1], owner: ctx.args[2] }),
    );
  },
};

const redeem: Command = {
  name: 'redeem',
  usage: '/redeem <signature> <mint> [purpose]',
  summary: 'Redeem a burn once, and record it as spent',
  async run(ctx) {
    const signature = required(ctx, 0, 'a transaction signature', redeem);
    const mint = required(ctx, 1, 'the mint the burn must be of', redeem);

    return formatBurnClaim(
      await ops.redeemBurn({
        signature,
        mint,
        // Not a parameter. A claimant who can name their own expectation is not
        // a claimant, they are anybody with a signature — so this comes from
        // the chat the command arrived in and nowhere else.
        expectMemo: burnClaim(ctx.chatId),
        purpose: ctx.args.slice(2).join(' ').trim() || undefined,
      }),
    );
  },
};

const identity: Command = {
  name: 'identity',
  aliases: ['token_identity', 'real'],
  usage: '/identity <mint> [fetch]',
  summary: 'What a mint declares, and whether it can change',
  async run(ctx) {
    const mint = required(ctx, 0, 'a mint address', identity);

    // Fetching the linked document is an outbound request to a URL whoever
    // deployed the mint chose, so it stays something asked for by name.
    const shouldFetch = ctx.args[1]?.toLowerCase() === 'fetch';

    return formatTokenIdentity(await ops.tokenIdentity({ mint, fetch: shouldFetch }));
  },
};

const inspect: Command = {
  name: 'inspect',
  aliases: ['inspect_exit', 'exit', 'canisell'],
  usage: '/inspect <mint>',
  summary: 'Before buying: what could stop you selling it again',
  async run(ctx) {
    const mint = required(ctx, 0, 'a mint address', inspect);
    return formatExitReport(await ops.inspectExit({ mint }));
  },
};

/**
 * Is the picture on my receipt the one my payment generates?
 *
 * The check a holder cannot do by eye. A receipt NFT's image is served by a
 * host, and a host can change what it serves; the artwork is derived from the
 * reference, so it can be re-derived here and compared. Everything this needs
 * is already in the payment link, so it reads no chain and fetches nothing.
 */
const receipt: Command = {
  name: 'receipt',
  aliases: ['receipt_art', 'art'],
  usage: '/receipt <reference or receipt uri> [solana: link]',
  summary: 'What a payment receipt looks like, and whether an image is genuine',
  async run(ctx) {
    const subject = required(ctx, 0, 'a payment reference or a receipt uri', receipt);
    const link = ctx.args[1];

    const result = await ops.receiptArt({
      ...(subject.includes('://') ? { uri: subject } : { reference: subject }),
      ...(link ? { link } : {}),
    });

    const lines = [
      `<b>Receipt ${esc(result.reference.slice(0, 8))}</b>`,
      '',
      `Palette   <code>${esc(result.traits.palette)}</code>`,
      `Modules   <code>${esc(result.traits.modules)}</code>`,
      `Finders   <code>${esc(result.traits.finders)}</code>`,
      `Contrast  <code>${result.contrast.inkOnPaper}:1</code> ink, <code>${result.contrast.accentOnPaper}:1</code> accent`,
      '',
      `<i>${esc(result.note)}</i>`,
    ].join('\n');

    // With the link in hand the code itself is the better answer: the picture
    // is the thing being asked about.
    if (link) {
      return {
        photo: qrArtPng(qrMatrix(link), result.reference, { scale: 8 }),
        filename: `receipt-${result.reference.slice(0, 8)}.png`,
        caption: lines,
      };
    }

    return lines;
  },
};

const qr: Command = {
  name: 'qr',
  aliases: ['scan'],
  usage: '/qr <solana: link or text>',
  summary: 'Turn a link into something you can scan with your phone',
  async run(ctx) {
    const text = ctx.args.join(' ').trim();

    if (!text) {
      return `Give me something to encode.

<code>${qr.usage}</code>

A <code>solana:</code> link from /burn is the usual one — paste it here and scan the result in Phantom.`;
    }

    // Level M at eight pixels a module: large enough to scan off a phone
    // screen held at arm's length, small enough that Telegram does not
    // recompress it into mush.
    const matrix = qrMatrix(text);

    return {
      photo: qrArtPng(matrix, text, { scale: 8 }),
      filename: 'singularity-qr.png',
      caption:
        text.startsWith('solana:')
          ? 'Scan with Phantom or any Solana wallet. Check what the approval screen says before you sign — this code is only a link, and the wallet decides what it shows you.'
          : `<code>${esc(text.slice(0, 200))}</code>`,
    };
  },
};

const health: Command = {
  name: 'health',
  aliases: ['chain_liveness', 'liveness'],
  usage: '/health [chain,chain,…]',
  summary: 'Check which chains are serving current state',
  async run(ctx) {
    const named = ctx.args[0]?.split(',').map((c) => c.trim()).filter(Boolean);

    // Reachability was the weaker question and it was the one being asked. A
    // halted chain answers every request it is given, so "reachable" came back
    // green for a chain serving a head block months old.
    return formatLiveness(await ops.checkLiveness(named));
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

const drafts: Command = {
  name: 'drafts',
  aliases: ['queue', 'approve'],
  usage: '/drafts',
  summary: 'Review X posts waiting for approval',
  run: (ctx) => runDraftsCommand(ctx.xControl, ctx.isControlChat === true),
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
  history,
  resolve,
  fees,
  block,
  chains,
  transfer,
  read,
  decode,
  mint,
  identity,
  inspect,
  receipt,
  qr,
  pay,
  paid,
  payments,
  burn,
  verifyburn,
  redeem,
  health,
  chat,
  x,
  drafts,
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
