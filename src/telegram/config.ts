/**
 * Bot configuration comes from the environment, never from the repo: `.env` is
 * gitignored and `.env.example` documents the shape. Rotating a leaked token is
 * then an edit to one untracked file, with no code change.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Minimal `.env` reader. A dependency for this would be ~20 lines of value and
 * a supply-chain surface on a process that holds a bot token.
 *
 * The real environment always wins, so `TELEGRAM_BOT_TOKEN=… npm run bot` and
 * container-injected secrets both override the file.
 */
export function loadEnvFile(path = resolve(process.cwd(), '.env')): void {
  if (!existsSync(path)) return;

  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (value.length >= 2 && /^(".*"|'.*')$/s.test(value)) value = value.slice(1, -1);

    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

export interface TelegramConfig {
  token: string;
  /** Chat ids the bot will serve. `null` means any chat that adds it. */
  allowedChats: Set<number> | null;
  /** Per-chat command budget per minute. Public RPCs are the real constraint. */
  rateLimitPerMinute: number;
  /** Chains `/portfolio` sweeps when the user names none. */
  defaultChains: string[] | undefined;
  /** Seconds to hold each long-poll open. */
  pollTimeoutSeconds: number;
}

/**
 * A BotFather token is `<numeric bot id>:<35-char secret>`. Validating the shape
 * up front turns "silently never receives updates" into a startup error that
 * names the problem — worth it, because every other credential shape people have
 * lying around (API keys, OAuth tokens) fails this test.
 */
export const BOT_TOKEN_PATTERN = /^\d{6,}:[A-Za-z0-9_-]{30,}$/;

export class ConfigError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): TelegramConfig {
  const token = (env.TELEGRAM_BOT_TOKEN ?? '').trim();

  if (!token) {
    throw new ConfigError(
      'TELEGRAM_BOT_TOKEN is not set.',
      'Create a bot with @BotFather on Telegram, then put the token it gives you in .env as TELEGRAM_BOT_TOKEN=…',
    );
  }
  if (!BOT_TOKEN_PATTERN.test(token)) {
    throw new ConfigError(
      'TELEGRAM_BOT_TOKEN does not look like a Telegram bot token.',
      'Expected "<bot id>:<secret>", e.g. 8123456789:AAH4c… . Keys from other services (X/Twitter, OpenAI, RPC providers) will not work here — this token comes only from @BotFather.',
    );
  }

  return {
    token,
    allowedChats: parseChatAllowlist(env.TELEGRAM_ALLOWED_CHATS),
    rateLimitPerMinute: positiveInt(env.TELEGRAM_RATE_LIMIT_PER_MINUTE, 20),
    defaultChains: parseList(env.TELEGRAM_DEFAULT_CHAINS),
    pollTimeoutSeconds: positiveInt(env.TELEGRAM_POLL_TIMEOUT_SECONDS, 50),
  };
}

/**
 * Group ids are negative (`-100…` for supergroups), so this cannot just take
 * digits. An empty or unset value means "serve any chat".
 */
function parseChatAllowlist(raw: string | undefined): Set<number> | null {
  const items = parseList(raw);
  if (!items) return null;

  const ids = new Set<number>();
  for (const item of items) {
    const id = Number(item);
    if (!Number.isInteger(id)) {
      throw new ConfigError(
        `TELEGRAM_ALLOWED_CHATS contains "${item}", which is not a chat id.`,
        'Chat ids are integers and group ids are negative, e.g. -1001234567890. Add the bot to the group and run /chatid to find it.',
      );
    }
    ids.add(id);
  }
  return ids.size ? ids : null;
}

function parseList(raw: string | undefined): string[] | undefined {
  const items = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length ? items : undefined;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
