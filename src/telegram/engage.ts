/**
 * Deciding whether the bot is being spoken to.
 *
 * Getting this wrong is the difference between a useful group member and a bot
 * that answers everything anyone says. The rules:
 *
 *   - In a DM, every message is for the bot.
 *   - In a group, only a command, an @mention of this bot, or a reply to one of
 *     the bot's own messages. Everything else is other people's conversation.
 *   - A command or mention addressed to a *different* bot is never ours, even
 *     when the wording would otherwise match.
 *
 * All of it is pure, so the group rules are testable without a network.
 *
 * Note on Telegram privacy mode: with it enabled (the BotFather default) the
 * bot only *receives* commands and replies to its own messages, so @mentions
 * never arrive to be matched. The mention path works either way; it simply has
 * nothing to act on until privacy mode is disabled.
 */
import type { TelegramMessage } from './api.js';

/** Telegram's pseudo-account for anonymous group admins. */
export const GROUP_ANONYMOUS_BOT_ID = 1087968824;

/**
 * Is this a person posting anonymously as the group?
 *
 * Group admins can post under the group's name instead of their own. Telegram
 * represents that as `from` = the `GroupAnonymousBot` pseudo-user, which has
 * `is_bot: true`, plus `sender_chat` = the group itself. There is a real person
 * behind it, so it must not be filtered out with the actual bots.
 */
export function isAnonymousAdmin(message: TelegramMessage): boolean {
  return (
    message.from?.id === GROUP_ANONYMOUS_BOT_ID ||
    message.from?.username === 'GroupAnonymousBot' ||
    // A channel posting into its linked discussion group: also not a bot.
    (message.sender_chat !== undefined && message.from?.is_bot === true)
  );
}

/**
 * Should this sender be ignored as an automated one?
 *
 * Only genuine other bots. Telegram does not deliver one bot's messages to
 * another anyway, so this guard exists for loops involving our own output —
 * and it must not swallow anonymous admins, who are people.
 */
export function isFromAnotherBot(message: TelegramMessage): boolean {
  return message.from?.is_bot === true && !isAnonymousAdmin(message);
}

export type EngagementReason = 'private' | 'mention' | 'reply' | 'command' | null;

export interface Engagement {
  engage: boolean;
  reason: EngagementReason;
  /** The message with the bot's own @handle removed, ready for the model. */
  text: string;
}

/**
 * Reads mentions from Telegram's parsed entities rather than searching the
 * text, so `@Singularity` inside a code block or a URL is not a mention.
 */
export function mentionsBot(message: TelegramMessage, botUsername: string, botId?: number): boolean {
  const text = message.text ?? '';
  const handle = `@${botUsername.toLowerCase()}`;

  return (message.entities ?? []).some((entity) => {
    if (entity.type === 'mention') {
      return text.slice(entity.offset, entity.offset + entity.length).toLowerCase() === handle;
    }
    // A bot with no public username can still be mentioned by display name.
    if (entity.type === 'text_mention') return Boolean(botId) && entity.user?.id === botId;

    return false;
  });
}

/** True when this message is a reply to something the bot itself sent. */
export function repliesToBot(message: TelegramMessage, botId?: number): boolean {
  const parent = message.reply_to_message;
  if (!parent?.from?.is_bot) return false;

  // Without a known id, "some bot" is not good enough in a multi-bot group.
  return botId !== undefined && parent.from.id === botId;
}

/**
 * Strips a leading or trailing `@bot` so the model sees the question rather
 * than the addressing. An @handle in the middle of a sentence is left alone —
 * "ask @bot about base" reads differently without it.
 */
export function stripBotHandle(text: string, botUsername: string): string {
  const handle = botUsername.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text
    .replace(new RegExp(`^\\s*@${handle}\\b[,:]?\\s*`, 'i'), '')
    .replace(new RegExp(`\\s*@${handle}\\s*$`, 'i'), '')
    .trim();
}

export function decideEngagement(
  message: TelegramMessage,
  botUsername: string,
  botId: number | undefined,
  isCommand: boolean,
): Engagement {
  const raw = (message.text ?? '').trim();
  const text = stripBotHandle(raw, botUsername);

  if (isCommand) return { engage: true, reason: 'command', text };
  if (message.chat.type === 'private') return { engage: true, reason: 'private', text: raw };

  if (mentionsBot(message, botUsername, botId)) return { engage: true, reason: 'mention', text };
  if (repliesToBot(message, botId)) return { engage: true, reason: 'reply', text: raw };

  return { engage: false, reason: null, text: raw };
}

/**
 * The @ping that opens a group reply.
 *
 * Telegram threads the reply already, but in a fast-moving group the thread
 * line is easy to miss, so the person is named too. A username is used when
 * there is one — it is a real, tappable link to the person — and the display
 * name otherwise, which is not.
 *
 * DMs get nothing: there is only one other person there.
 */
export function pingFor(message: TelegramMessage): string {
  if (message.chat.type === 'private') return '';

  // An anonymous admin has no account to point at — "@GroupAnonymousBot" would
  // be both wrong and a link to Telegram's own pseudo-account.
  if (isAnonymousAdmin(message)) return '';

  const from = message.from;
  if (from?.username) return `@${from.username} `;
  if (from?.first_name) return `${from.first_name}, `;

  return '';
}
