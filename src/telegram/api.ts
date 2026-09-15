/**
 * A thin Telegram Bot API client over `fetch`.
 *
 * The bot needs five methods out of a ~100-method API, and this process holds a
 * bot token, so a framework would be mostly attack surface. Long polling is used
 * rather than webhooks so the bot runs anywhere without a public URL or TLS.
 */

const API_ROOT = 'https://api.telegram.org';

/** Telegram truncates anything longer; we cut it ourselves so the tail is ours. */
export const MAX_MESSAGE_LENGTH = 4096;

export interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  username?: string;
  first_name?: string;
}

/**
 * A span Telegram has already parsed out of the text. `mention` is `@username`;
 * `text_mention` is a user with no username, carrying the account instead.
 * Using these rather than searching the text ourselves is what keeps
 * "@Singularity" in a code block or a URL from reading as an address.
 */
export interface TelegramEntity {
  type: string;
  offset: number;
  length: number;
  user?: TelegramUser;
}

export interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  /**
   * Set when a message is sent on behalf of a chat rather than a person: an
   * anonymous group admin, or a channel posting into its discussion group.
   *
   * For an anonymous admin Telegram puts the pseudo-user `GroupAnonymousBot`
   * in `from` — with `is_bot: true` — and the real group here. A naive
   * "ignore bots" check therefore discards messages from human admins.
   */
  sender_chat?: TelegramChat;
  date: number;
  text?: string;
  entities?: TelegramEntity[];
  /** Present when this message replies to another — including one of ours. */
  reply_to_message?: TelegramMessage;
  new_chat_members?: TelegramUser[];
}

/** Membership change: the bot added to a chat, removed, or promoted. */
export interface ChatMemberUpdated {
  chat: TelegramChat;
  from?: TelegramUser;
  new_chat_member?: { status: string; user?: TelegramUser };
  old_chat_member?: { status: string };
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  /** Posts in a channel. A separate update type from `message`. */
  channel_post?: TelegramMessage;
  /** The bot's own membership changing, in any chat. */
  my_chat_member?: ChatMemberUpdated;
}

export interface SendMessageOptions {
  chatId: number;
  text: string;
  /** Threads the answer under the question — essential in a busy group. */
  replyToMessageId?: number;
  disableWebPagePreview?: boolean;
}

export class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly errorCode: number,
    description: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(`Telegram ${method} failed (${errorCode}): ${description}`);
    this.name = 'TelegramApiError';
  }
}

interface ApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number; migrate_to_chat_id?: number };
}

export class TelegramApi {
  constructor(private readonly token: string) {}

  /**
   * `timeoutMs` must outlast the long poll itself, so the abort fires only when
   * the connection is genuinely dead rather than at every idle poll.
   */
  async call<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = 20_000): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(`${API_ROOT}/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        signal: controller.signal,
      });
    } catch (err) {
      const reason = (err as Error).name === 'AbortError' ? 'timed out' : (err as Error).message;
      throw new TelegramApiError(method, 0, reason);
    } finally {
      clearTimeout(timer);
    }

    const payload = (await response.json().catch(() => ({}))) as ApiResponse<T>;

    if (!payload.ok) {
      const code = payload.error_code ?? response.status;
      throw new TelegramApiError(
        method,
        code,
        payload.description ?? `HTTP ${response.status}`,
        payload.parameters?.retry_after,
      );
    }
    return payload.result as T;
  }

  getMe(): Promise<TelegramUser> {
    return this.call<TelegramUser>('getMe');
  }

  /**
   * The update types the bot asks for.
   *
   * `allowed_updates` is a filter, not a hint: anything left out is never
   * delivered, and there is no error to notice. This list was once `['message']`
   * alone, which silently discarded two things that matter —
   *
   *   - `channel_post`, which is how posts arrive in a channel. A bot in a
   *     channel with only `message` subscribed receives absolutely nothing.
   *   - `my_chat_member`, the bot being added to or removed from a chat. That
   *     is the one event that answers "is it even in that group?", and without
   *     it the bot cannot tell the difference between a chat it was never added
   *     to and one where nobody has spoken.
   *
   * Everything else is still left out, so the server sends less of other
   * people's group chatter.
   */
  getUpdates(offset: number, timeoutSeconds: number): Promise<TelegramUpdate[]> {
    return this.call<TelegramUpdate[]>(
      'getUpdates',
      {
        offset,
        timeout: timeoutSeconds,
        allowed_updates: ['message', 'channel_post', 'my_chat_member'],
      },
      // Give the HTTP call headroom beyond the long poll it is holding open.
      (timeoutSeconds + 15) * 1000,
    );
  }

  async sendMessage(options: SendMessageOptions): Promise<TelegramMessage> {
    return this.call<TelegramMessage>('sendMessage', {
      chat_id: options.chatId,
      text: truncateForTelegram(options.text),
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: options.disableWebPagePreview !== false },
      ...(options.replyToMessageId
        ? {
            reply_parameters: {
              message_id: options.replyToMessageId,
              // The message may be gone by the time we answer; still deliver.
              allow_sending_without_reply: true,
            },
          }
        : {}),
    });
  }

  /**
   * The "typing…" indicator. Telegram clears it after ~5s or when a message
   * arrives, so it is sent once at the start of a turn rather than refreshed —
   * a tool-calling answer that takes longer simply shows nothing for a moment,
   * which is better than a heartbeat that keeps firing if the turn fails.
   */
  sendChatAction(chatId: number, action: 'typing' = 'typing'): Promise<boolean> {
    return this.call<boolean>('sendChatAction', { chat_id: chatId, action });
  }

  /**
   * Publishes the command menu clients show in the "/" picker.
   *
   * Registered for both the default scope and group chats: a menu entry that
   * has no command behind it does nothing when tapped, with no error anywhere,
   * so the menu is generated from the same list the runtime dispatches on.
   */
  async setMyCommands(commands: Array<{ command: string; description: string }>): Promise<void> {
    for (const scope of [{ type: 'default' }, { type: 'all_group_chats' }]) {
      await this.call<boolean>('setMyCommands', { commands, scope });
    }
  }

  leaveChat(chatId: number): Promise<boolean> {
    return this.call<boolean>('leaveChat', { chat_id: chatId });
  }
}

/**
 * Cuts on a line boundary where possible so a truncated table does not end
 * mid-tag — unbalanced HTML makes Telegram reject the whole message.
 */
export function truncateForTelegram(text: string, limit = MAX_MESSAGE_LENGTH): string {
  if (text.length <= limit) return text;

  const notice = '\n\n… truncated.';
  const budget = limit - notice.length;
  const cut = text.slice(0, budget);
  const lastNewline = cut.lastIndexOf('\n');

  return (lastNewline > budget * 0.5 ? cut.slice(0, lastNewline) : cut) + notice;
}
