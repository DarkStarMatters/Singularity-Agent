/**
 * The approval card: a pending X post rendered into Telegram with buttons.
 *
 * This is the reviewer transport for `src/x/approval.ts`. It has one job that
 * is easy to get subtly wrong — showing the operator *exactly* what will be
 * published, character for character. So the post text is escaped and shown
 * verbatim, never reflowed or summarized, and the character count is stated
 * because X's limit is the constraint that most often makes a post wrong.
 *
 * After a decision the card is rewritten in place. Leaving a row of dead
 * buttons under a decided post invites double-taps and makes the history
 * unreadable.
 */
import { esc } from './format.js';
import type { TelegramApi, InlineKeyboard } from './api.js';
import type { ApprovalTransport, PendingPost, ResolvedPost } from '../x/approval.js';
import { REPLY_LIMIT } from '../x/listener.js';

/** Callback payloads. Telegram caps `callback_data` at 64 bytes. */
export const APPROVE_PREFIX = 'ok:';
export const REJECT_PREFIX = 'no:';

export function decisionFrom(data: string): { approve: boolean; id: string } | null {
  if (data.startsWith(APPROVE_PREFIX)) return { approve: true, id: data.slice(APPROVE_PREFIX.length) };
  if (data.startsWith(REJECT_PREFIX)) return { approve: false, id: data.slice(REJECT_PREFIX.length) };

  return null;
}

function keyboardFor(id: string): InlineKeyboard {
  return [
    [
      { text: '✅ Post it', callback_data: `${APPROVE_PREFIX}${id}` },
      { text: '🗑 Discard', callback_data: `${REJECT_PREFIX}${id}` },
    ],
  ];
}

export function renderPending(pending: PendingPost): string {
  const heading =
    pending.kind === 'reply'
      ? `<b>Reply to ${esc(pending.author ? `@${pending.author}` : 'a mention')}</b>`
      : '<b>Project update</b>';

  const lines = [heading, ''];

  if (pending.context) {
    lines.push('<i>They said:</i>', `<blockquote>${esc(pending.context)}</blockquote>`, '');
  }

  lines.push(
    // Verbatim, escaped: this is the thing being agreed to.
    esc(pending.text),
    '',
    `<i>${pending.text.length}/${REPLY_LIMIT} characters · id <code>${esc(pending.id)}</code></i>`,
  );

  return lines.join('\n');
}

export function renderResolved(resolution: ResolvedPost): string {
  const { pending, approved, result, error, hint, by } = resolution;
  const who = by ? ` by ${esc(by)}` : '';

  if (!approved) {
    return [`🗑 <b>Discarded</b>${who}`, '', `<s>${esc(pending.text)}</s>`].join('\n');
  }
  if (error) {
    return [
      `⚠️ <b>Approved${who}, but publishing failed</b>`,
      '',
      esc(pending.text),
      '',
      `<i>${esc(error)}</i>`,
      // The hint is the half of an error worth acting on — a bare "403" sends
      // someone hunting, while the hint names the two settings that fix it.
      ...(hint ? ['', esc(hint)] : []),
    ].join('\n');
  }

  // Approval is not the only gate: X_POSTING_ENABLED still applies, and a
  // dry-run result comes back `published: false`. Reporting that as "Posted"
  // would be the exact failure the agent is told never to commit — claiming
  // something went out when it did not.
  if (result && !result.published) {
    return [
      `📝 <b>Approved${who} — but nothing was published</b>`,
      '',
      esc(pending.text),
      '',
      `<i>${esc(result.reason ?? 'Publishing is disabled.')}</i>`,
      '<i>Set X_POSTING_ENABLED=true for an approval to actually post.</i>',
    ].join('\n');
  }

  return [
    `✅ <b>Posted</b>${who}`,
    '',
    esc(pending.text),
    ...(result?.url ? ['', `<a href="${esc(result.url)}">View on X</a>`] : []),
  ].join('\n');
}

/**
 * Sends approval cards to one chat and rewrites them when decided.
 *
 * The message id of each card is remembered so the outcome can replace the
 * original rather than pile another message onto the chat.
 */
export class TelegramApprovals implements ApprovalTransport {
  private readonly cards = new Map<string, number>();

  constructor(
    private readonly api: TelegramApi,
    private readonly chatId: number,
  ) {}

  async request(pending: PendingPost): Promise<void> {
    const sent = await this.api.sendMessage({
      chatId: this.chatId,
      text: renderPending(pending),
      keyboard: keyboardFor(pending.id),
    });

    this.cards.set(pending.id, sent.message_id);
  }

  async resolved(resolution: ResolvedPost): Promise<void> {
    const messageId = this.cards.get(resolution.pending.id);
    this.cards.delete(resolution.pending.id);

    const text = renderResolved(resolution);

    // No card to rewrite when the decision came from a command rather than a
    // button, or after a restart — say it as a new message instead.
    if (messageId === undefined) {
      await this.api.sendMessage({ chatId: this.chatId, text });
      return;
    }

    await this.api.editMessageText({ chatId: this.chatId, messageId, text });
  }
}
