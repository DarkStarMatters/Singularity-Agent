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

  const from = message.from;
  if (from?.username) return `@${from.username} `;
  if (from?.first_name) return `${from.first_name}, `;

  return '';
}
