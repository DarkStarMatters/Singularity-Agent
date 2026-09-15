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
import { COMMANDS, type CommandContext } from './commands.js';
import { esc, formatError } from './format.js';
import { loadConfig, loadEnvFile, ConfigError, type TelegramConfig } from './config.js';
import { TelegramApi, TelegramApiError, type TelegramMessage, type TelegramUpdate } from './api.js';
import { decideEngagement, pingFor } from './engage.js';
import { sanitizeModelHtml } from './html.js';
import { GrokAgent, createAgent } from '../grok/agent.js';
import { GrokClient, loadGrokConfig } from '../grok/client.js';

/** `/name@bot args…` — the `@bot` part is present only in groups. */
const COMMAND_PATTERN = /^\/([A-Za-z0-9_]{1,32})(?:@([A-Za-z0-9_]{1,32}))?(?:\s+([\s\S]*))?$/;

export interface ParsedCommand {
  name: string;
  /** The bot this command was addressed to, when the user said so. */
  addressedTo?: string;
  args: string[];
}

/**
 * Arguments are split on whitespace. No quoting support: every argument this bot
 * takes is an address, hash, chain id, or number, none of which contain spaces.
 */
export function parseCommand(text: string): ParsedCommand | null {
  const match = COMMAND_PATTERN.exec(text.trim());
  if (!match) return null;

  const [, name, addressedTo, rest] = match;
  return {
    name: name!.toLowerCase(),
    ...(addressedTo ? { addressedTo } : {}),
    args: (rest ?? '').split(/\s+/).filter(Boolean),
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
    console.error(
      this.agent
        ? '[singularity-bot] Grok is configured — mentions, replies and DMs get conversational answers.'
        : '[singularity-bot] no XAI_API_KEY — commands only, no conversation.',
    );

    await this.poll();
  }

  stop(): void {
    this.running = false;
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

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    if (!message?.text || message.from?.is_bot) return;
    if (message.date < this.startedAt) return;

    const parsed = parseCommand(message.text);
    const isCommand = Boolean(parsed) && shouldHandle(parsed!, message.chat.type, this.username);

    // A command aimed at another bot is not ours, and neither is it plain
    // conversation we should answer — drop it outright.
    if (parsed && !isCommand) return;

    const engagement = decideEngagement(message, this.username, this.botId, isCommand);
    if (!engagement.engage) return;

    if (!(await this.chatIsAllowed(message))) return;

    if (!this.limiter.take(message.chat.id)) {
      await this.reply(
        message,
        `⏳ Rate limit reached for this chat (${this.config.rateLimitPerMinute}/min). Try again shortly.`,
      );
      return;
    }

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

    // Typing shows up immediately; a tool-calling turn can take several seconds.
    await this.api.sendChatAction(message.chat.id, 'typing').catch(() => undefined);

    let body: string;
    try {
      const speaker = message.from?.username ?? message.from?.first_name;
      const reply = await this.agent.respond(String(message.chat.id), text, speaker);
      body = sanitizeModelHtml(reply.text);
    } catch (err) {
      body = formatError(err);
    }

    await this.reply(message, `${esc(pingFor(message))}${body}`);
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
      ...(this.agent ? { forget: () => this.agent!.forget(String(message.chat.id)) } : {}),
    };

    let text: string;
    try {
      text = await command.run(ctx);
    } catch (err) {
      // An RPC failure is routine on public endpoints; report it in-chat rather
      // than letting it take the poll loop down.
      text = formatError(err);
    }

    await this.reply(message, text);
  }

  private async reply(message: TelegramMessage, text: string): Promise<void> {
    try {
      await this.api.sendMessage({
        chatId: message.chat.id,
        text,
        replyToMessageId: message.message_id,
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
