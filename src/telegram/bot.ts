/**
 * The bot runtime: long-poll, dispatch, reply.
 *
 * Group behaviour is the design centre here, and groups differ from DMs in ways
 * that are easy to get wrong:
 *
 *   - Commands arrive as `/balance@YourBot …` when several bots share a group.
 *     A command addressed to a *different* bot must be ignored silently.
 *   - Everything else in a group is other people's conversation. The bot never
 *     answers it, and with BotFather privacy mode on it never even sees it.
 *   - Replies are threaded to the triggering message, or an answer in a busy
 *     group is unattributable.
 *   - One person can spam a command and exhaust shared public RPC quota, so the
 *     budget is per chat, not per user.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { COMMANDS, commandMenu, type CommandContext, type CommandResult } from './commands.js';
import { PaymentWatcher } from './payments.js';
import { FileIntentStore } from '../pay/file-store.js';
import { esc, formatError } from './format.js';
import { loadConfig, loadEnvFile, ConfigError, type TelegramConfig } from './config.js';
import {
  TelegramApi,
  TelegramApiError,
  type InlineKeyboard,
  type TelegramMessage,
  type TelegramUpdate,
} from './api.js';
import { decideEngagement, isAnonymousAdmin, isFromAnotherBot, pingFor } from './engage.js';
import { sanitizeModelHtml } from './html.js';
import { GrokAgent, createAgent } from '../grok/agent.js';
import { GrokClient, loadGrokConfig } from '../grok/client.js';
import { decisionFrom } from './approvals.js';
import type { XControl } from './control.js';

/** `/name@bot args…` — the `@bot` part is present only in groups. */
const COMMAND_PATTERN = /^\/([A-Za-z0-9_]{1,32})(?:@([A-Za-z0-9_]{1,32}))?(?:\s+([\s\S]*))?$/;

export interface ParsedCommand {
  name: string;
  /** The bot this command was addressed to, when the user said so. */
  addressedTo?: string;
  args: string[];
}

/**
 * Opening quote to its closing partner.
 *
 * The curly pairs are not decoration. Every phone keyboard on both major
 * platforms substitutes typographic quotes as you type, so a user asked to
 * send `/nft #1 "Genesis Mesh"` will in practice send `/nft #1 “Genesis Mesh”`
 * — and a parser that only knows the straight pair would take that as two
 * arguments with stray characters glued to them. Refusing to handle the quotes
 * people can actually type is not strictness, it is a bug with a rationale.
 */
const QUOTE_PAIRS = new Map<string, string>([
  ['"', '"'],
  ["'", "'"],
  ['“', '”'],
  ['”', '”'],
  ['‘', '’'],
  ['’', '’'],
  ['«', '»'],
]);

/**
 * Split a command's tail into arguments, respecting quotes.
 *
 * This used to be `split(/\s+/)`, with a comment explaining that every
 * argument the bot takes is an address, hash, chain id or number and none of
 * those contain spaces. That was true until `/nft` needed a series name, which
 * is prose and is the thing a person names rather than pastes.
 *
 * An unterminated quote takes the rest of the line rather than being an error.
 * A user who opened a quote and forgot to close it meant everything after it,
 * and the alternative — rejecting the command — throws away input over
 * punctuation.
 */
export function tokenizeArgs(rest: string): string[] {
  const args: string[] = [];
  let at = 0;

  while (at < rest.length) {
    if (/\s/.test(rest[at]!)) {
      at += 1;
      continue;
    }

    const closer = QUOTE_PAIRS.get(rest[at]!);
    if (closer) {
      const end = rest.indexOf(closer, at + 1);
      if (end === -1) {
        const tail = rest.slice(at + 1).trim();
        if (tail) args.push(tail);
        break;
      }
      // An empty quoted string is pushed: the user typed something, and a
      // command that wanted a name should say the name was empty rather than
      // report the argument missing.
      args.push(rest.slice(at + 1, end));
      at = end + 1;
      continue;
    }

    let end = at;
    while (end < rest.length && !/\s/.test(rest[end]!)) end += 1;
    args.push(rest.slice(at, end));
    at = end;
  }

  return args;
}

export function parseCommand(text: string): ParsedCommand | null {
  const match = COMMAND_PATTERN.exec(text.trim());
  if (!match) return null;

  const [, name, addressedTo, rest] = match;
  return {
    name: name!.toLowerCase(),
    ...(addressedTo ? { addressedTo } : {}),
    args: tokenizeArgs(rest ?? ''),
  };
}

/**
 * Should this message be handled at all?
 *
 * Split out from the runtime because it is pure and carries most of the group
 * rules — the parts worth testing without a network.
 */
export function shouldHandle(
  parsed: ParsedCommand,
  chatType: string,
  botUsername: string,
): boolean {
  if (!COMMANDS.has(parsed.name)) return false;

  // `/balance@OtherBot` in a shared group is not ours to answer.
  if (parsed.addressedTo && parsed.addressedTo.toLowerCase() !== botUsername.toLowerCase()) {
    return false;
  }
  return true;
}

/** Sliding-window budget per chat. */
class RateLimiter {
  private readonly hits = new Map<number, number[]>();

  constructor(private readonly perMinute: number) {}

  take(chatId: number, now = Date.now()): boolean {
    const cutoff = now - 60_000;
    const recent = (this.hits.get(chatId) ?? []).filter((t) => t > cutoff);

    if (recent.length >= this.perMinute) {
      this.hits.set(chatId, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(chatId, recent);
    return true;
  }
}

export class SingularityBot {
  private readonly api: TelegramApi;
  private readonly limiter: RateLimiter;
  /** Null when no xAI key is configured: commands still work, chat does not. */
  private readonly agent: GrokAgent | null;
  private username = '';
  /** Needed to recognize replies to our own messages in a multi-bot group. */
  private botId: number | undefined;
  private offset = 0;
  private running = false;
  /** Messages from before startup are stale; answering a backlog spams the group. */
  private startedAt = 0;
  /** TELEGRAM_DEBUG=true logs every update and why it was or was not handled. */
  private readonly debug = process.env.TELEGRAM_DEBUG?.trim().toLowerCase() === 'true';

  /** Set when the X bot shares this process; drives `/x` and the buttons. */
  xControl: XControl | undefined;
  /** The chat approval cards are sent to, so `/drafts` can say where they went. */
  controlChatId: number | undefined;

  /**
   * Watches open payment requests and announces the ones that land.
   *
   * Null until a payment endpoint is configured, because a bot that cannot
   * create a payment request has nothing to watch for.
   */
  private payments: PaymentWatcher | null = null;

  constructor(private readonly config: TelegramConfig) {
    this.api = new TelegramApi(config.token);
    this.limiter = new RateLimiter(config.rateLimitPerMinute);

    const grok = loadGrokConfig();
    this.agent = grok ? createAgent(new GrokClient(grok), 'telegram') : null;
  }

  async start(): Promise<void> {
    const me = await this.api.getMe();
    this.username = me.username ?? '';
    this.botId = me.id;
    this.running = true;
    this.startedAt = Math.floor(Date.now() / 1000);

    const scope = this.config.allowedChats
      ? `${this.config.allowedChats.size} allowlisted chat(s)`
      : 'any chat';
    console.error(`[singularity-bot] connected as @${this.username} — serving ${scope}`);
    if (this.debug) {
      console.error('[singularity-bot] TELEGRAM_DEBUG is on — every update will be logged with the reason it was or was not handled.');
    }
    console.error(
      this.agent
        ? '[singularity-bot] Grok is configured — mentions, replies and DMs get conversational answers.'
        : '[singularity-bot] no XAI_API_KEY — commands only, no conversation.',
    );

    // Published from the runtime's own command list, so the "/" menu can never
    // advertise something that is not there.
    try {
      await this.api.setMyCommands(commandMenu());
      console.error(`[singularity-bot] published ${commandMenu().length} commands to the menu.`);
    } catch (err) {
      console.error(`[singularity-bot] could not publish the command menu: ${(err as Error).message}`);
    }

    this.startPaymentWatcher();

    await this.poll();
  }

  /**
   * Begin sweeping for settled payments, where payments are configured at all.
   *
   * Silent when they are not: most deployments never take a payment, and a
   * warning about an unset variable they have no use for is noise on every
   * startup.
   */
  private startPaymentWatcher(): void {
    if (!process.env.SINGULARITY_PAYMENT_ENDPOINT?.trim()) return;

    this.payments = new PaymentWatcher(this.api, new FileIntentStore(), {
      ...(this.controlChatId !== undefined ? { fallbackChatId: this.controlChatId } : {}),
    });

    this.payments.start();
    console.error(
      '[singularity-bot] watching open payment requests — a settled payment is announced in the chat that asked for it.',
    );
  }

  stop(): void {
    this.running = false;
    this.payments?.stop();
  }

  private async poll(): Promise<void> {
    let backoffMs = 1_000;

    while (this.running) {
      try {
        const updates = await this.api.getUpdates(this.offset, this.config.pollTimeoutSeconds);
        backoffMs = 1_000;

        for (const update of updates) {
          // Advance the offset before handling: a handler that throws must never
          // cause the same update to be redelivered forever.
          this.offset = update.update_id + 1;
          await this.handleUpdate(update).catch((err) => {
            console.error('[singularity-bot] handler error:', (err as Error).message);
          });
        }
      } catch (err) {
        if (!this.running) break;

        // 429 tells us exactly how long to wait; anything else gets backoff.
        const retryAfter = err instanceof TelegramApiError ? err.retryAfterSeconds : undefined;
        const waitMs = retryAfter ? retryAfter * 1_000 : backoffMs;

        console.error(`[singularity-bot] poll failed: ${(err as Error).message} — retrying in ${waitMs}ms`);
        await sleep(waitMs);
        backoffMs = Math.min(backoffMs * 2, 60_000);
      }
    }
  }

  /**
   * Why a message was ignored.
   *
   * The bot drops most of what it sees, silently and correctly — but that makes
   * "it is not replying" impossible to diagnose from outside, because a message
   * that never arrived and a message that arrived and was dropped look
   * identical. With TELEGRAM_DEBUG=true every update is logged with the reason,
   * which turns that into a one-line answer.
   */
  private trace(message: TelegramMessage, outcome: string): void {
    if (!this.debug) return;

    console.error(
      `[singularity-bot] ${outcome} | chat ${message.chat.id} (${message.chat.type}` +
        `${message.chat.title ? ` "${message.chat.title}"` : ''}) | from ` +
        `${message.from?.username ?? message.from?.first_name ?? '?'} | ` +
        `${JSON.stringify((message.text ?? '').slice(0, 60))}`,
    );
  }

  /**
   * The bot being added to or removed from a chat.
   *
   * Always logged, not only in debug: this is the single most useful line in
   * the log when a group goes quiet, because it distinguishes "nobody has
   * spoken" from "the bot is not in that chat at all" — which look identical
   * from inside Telegram.
   */
  private noteMembershipChange(event: NonNullable<TelegramUpdate['my_chat_member']>): void {
    const status = event.new_chat_member?.status ?? 'unknown';
    const chat = event.chat;
    const title = chat.title ? ` "${chat.title}"` : '';

    console.error(
      `[singularity-bot] membership change: now "${status}" in ${chat.type} ${chat.id}${title}` +
        (event.from?.username ? ` (by @${event.from.username})` : ''),
    );

    if (chat.type !== 'private' && (status === 'member' || status === 'administrator')) {
      console.error(
        `[singularity-bot] add ${chat.id} to TELEGRAM_ALLOWED_CHATS to restrict the bot to this chat.`,
      );
      if (status === 'member' && chat.type !== 'channel') {
        console.error(
          '[singularity-bot] note: with BotFather privacy mode ON, only commands and replies to my own messages reach me here. /setprivacy → Disable, then re-add me, to see @mentions.',
        );
      }
    }
  }

  /**
   * An approval button was tapped.
   *
   * Answered before anything slow happens: until the callback is answered the
   * tapper sees a spinner, and publishing to X takes a moment.
   */
  private async handleCallback(query: NonNullable<TelegramUpdate['callback_query']>): Promise<void> {
    const decision = query.data ? decisionFrom(query.data) : null;

    if (!decision || !this.xControl) {
      await this.api.answerCallbackQuery(query.id, 'That button is no longer active.');
      return;
    }

    await this.api.answerCallbackQuery(
      query.id,
      decision.approve ? 'Posting…' : 'Discarded.',
    );

    const by = query.from.username ?? query.from.first_name;
    // The gate rewrites its own card, so nothing is sent from here.
    await (decision.approve
      ? this.xControl.approve(decision.id, by)
      : this.xControl.reject(decision.id, by));
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.callback_query) {
      await this.handleCallback(update.callback_query);
      return;
    }
    if (update.my_chat_member) {
      this.noteMembershipChange(update.my_chat_member);
      return;
    }

    // A channel post is a separate update type carrying the same shape. Only
    // commands are answered there — a channel has no conversation to join.
    const message = update.message ?? update.channel_post;

    if (!message?.text || message.from?.is_bot) {
      if (this.debug && update.message) this.trace(update.message, 'IGNORED (no text, or from a bot)');
      return;
    }
    if (message.date < this.startedAt) {
      this.trace(message, 'IGNORED (sent before startup)');
      return;
    }

    const parsed = parseCommand(message.text);
    const isCommand = Boolean(parsed) && shouldHandle(parsed!, message.chat.type, this.username);

    // A command aimed at another bot is not ours, and neither is it plain
    // conversation we should answer — drop it outright.
    if (parsed && !isCommand) {
      this.trace(
        message,
        parsed.addressedTo && parsed.addressedTo.toLowerCase() !== this.username.toLowerCase()
          ? `IGNORED (addressed to @${parsed.addressedTo})`
          : `IGNORED (no such command: /${parsed.name})`,
      );
      return;
    }

    const engagement = decideEngagement(message, this.username, this.botId, isCommand);
    if (!engagement.engage) {
      this.trace(message, 'IGNORED (not addressed to me — no command, mention or reply)');
      return;
    }

    if (!(await this.chatIsAllowed(message))) {
      this.trace(message, 'IGNORED (chat not on TELEGRAM_ALLOWED_CHATS)');
      return;
    }

    if (!this.limiter.take(message.chat.id)) {
      this.trace(message, 'RATE LIMITED');
      await this.reply(
        message,
        `⏳ Rate limit reached for this chat (${this.config.rateLimitPerMinute}/min). Try again shortly.`,
      );
      return;
    }

    this.trace(message, `HANDLING (${engagement.reason})`);

    if (isCommand) {
      await this.runCommand(parsed!, message);
      return;
    }
    await this.converse(message, engagement.text);
  }

  /**
   * A free-text turn: Grok answers, calling chain tools as it needs them.
   *
   * The conversation key is the chat, not the user. A group thread reads as one
   * conversation to the people in it, so it should to the model too — and
   * `name` on each turn is what keeps the speakers apart.
   */
  private async converse(message: TelegramMessage, text: string): Promise<void> {
    if (!this.agent) {
      await this.reply(
        message,
        'I can only run commands right now — no xAI key is configured for conversation. Try /help.',
      );
      return;
    }
    if (!text) return;

    const body = await this.agentReply(message, text);
    await this.reply(message, `${esc(pingFor(message))}${body}`);
  }

  /**
   * One turn with Grok, rendered safe for Telegram.
   *
   * Shared by the mention/DM path and the `/chat` command so the two cannot
   * answer differently — and so an RPC or model failure comes back as a
   * formatted error rather than taking the poll loop down.
   */
  private async agentReply(message: TelegramMessage, text: string): Promise<string> {
    if (!this.agent) {
      return 'Conversation is unavailable — no xAI key is configured. Try /help.';
    }

    // Typing shows up immediately; a tool-calling turn can take several seconds.
    await this.api.sendChatAction(message.chat.id, 'typing').catch(() => undefined);

    try {
      const speaker = isAnonymousAdmin(message)
        ? 'admin'
        : message.from?.username ?? message.from?.first_name;
      const reply = await this.agent.respond(String(message.chat.id), text, speaker);
      return sanitizeModelHtml(reply.text);
    } catch (err) {
      return formatError(err);
    }
  }

  /**
   * An unlisted chat gets one explanation and then the bot leaves, rather than
   * sitting silently in a group where people think it is broken.
   */
  private async chatIsAllowed(message: TelegramMessage): Promise<boolean> {
    const allowed = this.config.allowedChats;
    if (!allowed || allowed.has(message.chat.id)) return true;

    await this.reply(
      message,
      'This bot is restricted to specific chats and this one is not on the list. Leaving.',
    ).catch(() => undefined);
    await this.api.leaveChat(message.chat.id).catch(() => undefined);

    console.error(`[singularity-bot] left unlisted chat ${message.chat.id}`);
    return false;
  }

  private async runCommand(parsed: ParsedCommand, message: TelegramMessage): Promise<void> {
    const command = COMMANDS.get(parsed.name)!;
    const ctx: CommandContext = {
      args: parsed.args,
      chatId: message.chat.id,
      chatType: message.chat.type,
      config: this.config,
      ...(this.xControl ? { xControl: this.xControl } : {}),
      ...(this.controlChatId !== undefined && message.chat.id === this.controlChatId
        ? { isControlChat: true }
        : {}),
      ...(message.from?.username ?? message.from?.first_name
        ? { sender: message.from?.username ?? message.from?.first_name }
        : {}),
      ...(this.agent
        ? {
            forget: () => this.agent!.forget(String(message.chat.id)),
            converse: (text: string) => this.agentReply(message, text),
          }
        : {}),
    };

    let result: CommandResult;
    try {
      result = await command.run(ctx);
    } catch (err) {
      // An RPC failure is routine on public endpoints; report it in-chat rather
      // than letting it take the poll loop down.
      result = formatError(err);
    }

    // A photo goes out as a photo. Telegram has no way to put an image inside
    // a text message, and a QR is the one reply here that has to be looked at
    // through a camera rather than read.
    // Artwork goes out as a file, so the bytes a collector receives are the
    // bytes that were drawn and the image stays checkable against its metadata.
    if (typeof result === 'object' && 'document' in result) {
      await this.api.sendDocument({
        chatId: message.chat.id,
        document: result.document,
        filename: result.filename,
        replyToMessageId: message.message_id,
        ...(result.caption ? { caption: result.caption } : {}),
      });
      return;
    }

    if (typeof result === 'object' && 'photo' in result) {
      await this.api.sendPhoto({
        chatId: message.chat.id,
        photo: result.photo,
        replyToMessageId: message.message_id,
        ...(result.caption ? { caption: result.caption } : {}),
        ...(result.filename ? { filename: result.filename } : {}),
      });
      return;
    }

    const { text, keyboard } = typeof result === 'string' ? { text: result, keyboard: undefined } : result;
    await this.reply(message, text, keyboard);
  }

  private async reply(
    message: TelegramMessage,
    text: string,
    keyboard?: InlineKeyboard,
  ): Promise<void> {
    try {
      await this.api.sendMessage({
        chatId: message.chat.id,
        text,
        replyToMessageId: message.message_id,
        ...(keyboard?.length ? { keyboard } : {}),
      });
    } catch (err) {
      console.error(`[singularity-bot] send failed in ${message.chat.id}: ${(err as Error).message}`);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function main(): Promise<void> {
  loadEnvFile();

  let config: TelegramConfig;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`\n${err.message}`);
      if (err.hint) console.error(`\n${err.hint}\n`);
      process.exit(1);
    }
    throw err;
  }

  const bot = new SingularityBot(config);

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      console.error('\n[singularity-bot] shutting down');
      bot.stop();
      // The in-flight long poll holds the process open; do not wait for it.
      process.exit(0);
    });
  }

  await bot.start();
}

// Only auto-start when executed directly, so tests can import the bot freely.
// Comparing real paths rather than URLs keeps this correct on Windows (same
// reasoning as src/mcp/server.ts).
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((err) => {
    console.error(`[singularity-bot] fatal: ${(err as Error).message}`);
    process.exit(1);
  });
}
