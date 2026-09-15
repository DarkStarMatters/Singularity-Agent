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
import { formatError } from './format.js';
import { loadConfig, loadEnvFile, ConfigError, type TelegramConfig } from './config.js';
import { TelegramApi, TelegramApiError, type TelegramMessage, type TelegramUpdate } from './api.js';

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
  private username = '';
  private offset = 0;
  private running = false;
  /** Messages from before startup are stale; answering a backlog spams the group. */
  private startedAt = 0;

  constructor(private readonly config: TelegramConfig) {
    this.api = new TelegramApi(config.token);
    this.limiter = new RateLimiter(config.rateLimitPerMinute);
  }

  async start(): Promise<void> {
    const me = await this.api.getMe();
    this.username = me.username ?? '';
    this.running = true;
    this.startedAt = Math.floor(Date.now() / 1000);

    const scope = this.config.allowedChats
      ? `${this.config.allowedChats.size} allowlisted chat(s)`
      : 'any chat';
    console.error(`[singularity-bot] connected as @${this.username} — serving ${scope}`);

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
    // Plain group conversation. Not ours.
    if (!parsed) return;
    if (!shouldHandle(parsed, message.chat.type, this.username)) return;

    if (!(await this.chatIsAllowed(message))) return;

    if (!this.limiter.take(message.chat.id)) {
      await this.reply(
        message,
        `⏳ Rate limit reached for this chat (${this.config.rateLimitPerMinute}/min). Try again shortly.`,
      );
      return;
    }

    await this.runCommand(parsed, message);
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
