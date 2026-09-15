/**
 * Telegram as the control terminal for the X bot.
 *
 * The X listener runs unattended and posts in public, which makes "what is it
 * doing right now, and can I stop it" the question that matters most. This is
 * the surface that answers it from a phone.
 *
 * Kept as an interface rather than a direct dependency on `XListener`, so the
 * Telegram side stays testable without an X client, and so a command cannot
 * quietly reach past the control surface into the listener's internals.
 */
import { esc } from './format.js';
import { APPROVE_PREFIX, REJECT_PREFIX } from './approvals.js';
import type { InlineKeyboard } from './api.js';
import type { PendingPost } from '../x/approval.js';

export interface XStatus {
  account: string;
  paused: boolean;
  postingEnabled: boolean;
  approvalRequired: boolean;
  repliesThisHour: number;
  pendingApprovals: number;
  updateIntervalHours: number;
  nextUpdateInMinutes: number | null;
  lastAngle: string | null;
}

/** What Telegram is allowed to do to the X bot. */
export interface XControl {
  status(): XStatus;
  pause(): void;
  resume(): void;
  /** Composes an update now; returns the text, or null if it declined. */
  composeNow(angle?: string): Promise<string | null>;
  pending(): PendingPost[];
  /** Re-sends a tappable card for each pending post; returns how many. */
  resend(): Promise<number>;
  approve(id: string, by?: string): Promise<string>;
  reject(id: string, by?: string): Promise<string>;
}

const USAGE = [
  '<b>/x</b> — control the X bot',
  '',
  '<code>/x status</code> — what it is doing',
  '<code>/x pending</code> — posts waiting for you (see also /drafts)',
  '<code>/x post [angle]</code> — draft an update now',
  '<code>/x approve &lt;id&gt;</code> — publish a pending post',
  '<code>/x reject &lt;id&gt;</code> — discard one',
  '<code>/x pause</code> / <code>/x resume</code> — stop or restart answering mentions',
  '',
  '<i>Angles: coverage, capability, safety, changelog, philosophy.</i>',
].join('\n');

function renderStatus(status: XStatus): string {
  const lines = [
    `<b>X bot</b> — ${esc(status.account)}`,
    '',
    `Mentions: ${status.paused ? '⏸ paused' : '▶️ answering'}`,
    status.approvalRequired
      ? 'Publishing: 🔒 approval required — nothing goes out until you tap it'
      : status.postingEnabled
        ? 'Publishing: ⚠️ LIVE — posts go straight out'
        : 'Publishing: draft mode — nothing is sent',
    '',
    `Pending your approval: <b>${status.pendingApprovals}</b>`,
    `Replies sent this hour: ${status.repliesThisHour}`,
  ];

  if (status.updateIntervalHours > 0) {
    const next =
      status.nextUpdateInMinutes === null
        ? 'unknown'
        : status.nextUpdateInMinutes === 0
          ? 'due now'
          : `in ${status.nextUpdateInMinutes} min`;

    lines.push(
      `Project updates: every ${status.updateIntervalHours}h — next ${esc(next)}`,
      ...(status.lastAngle ? [`Last angle: ${esc(status.lastAngle)}`] : []),
    );
  } else {
    lines.push('Project updates: off');
  }

  return lines.join('\n');
}

/**
 * Buttons for a list of drafts, one row per draft.
 *
 * Only the first few get buttons: a wall of them is unreadable, and `/drafts`
 * re-sends full cards when there are more. The numbers match the list above so
 * "✅ 2" is unambiguous without repeating the text on the button.
 */
export function pendingKeyboard(pending: PendingPost[], limit = 4): InlineKeyboard {
  return pending.slice(0, limit).map((item, index) => [
    { text: `✅ ${index + 1}`, callback_data: `${APPROVE_PREFIX}${item.id}` },
    { text: `🗑 ${index + 1}`, callback_data: `${REJECT_PREFIX}${item.id}` },
  ]);
}

function renderPendingList(pending: PendingPost[]): {
  text: string;
  keyboard?: InlineKeyboard;
} {
  if (!pending.length) return { text: 'Nothing is waiting for approval.' };

  const lines = [`<b>${pending.length} waiting</b>`, ''];

  pending.forEach((item, index) => {
    const age = Math.round((Date.now() - item.createdAt) / 60_000);
    const label = item.kind === 'reply' ? `reply to @${item.author ?? '?'}` : 'update';

    lines.push(
      `<b>${index + 1}.</b> ${esc(label)}, ${age}m ago — <code>${esc(item.id)}</code>`,
      esc(item.text),
      '',
    );
  });

  const keyboard = pendingKeyboard(pending);
  lines.push(
    keyboard.length < pending.length
      ? `<i>Buttons cover the first ${keyboard.length}. Use /drafts for the rest.</i>`
      : '<i>Tap a number to publish or discard it.</i>',
  );

  return { text: lines.join('\n'), keyboard };
}

/**
 * Runs one `/x …` invocation.
 *
 * Returns rendered HTML rather than sending anything, so the command behaves
 * like every other one and the runtime owns delivery.
 */
export async function runXCommand(
  control: XControl | undefined,
  args: string[],
  by?: string,
): Promise<string | { text: string; keyboard?: InlineKeyboard }> {
  if (!control) {
    return 'The X bot is not running in this process. Start it with <code>npm run agent</code> to control it from here.';
  }

  const [subcommand, ...rest] = args;

  switch ((subcommand ?? 'status').toLowerCase()) {
    case 'status': {
      const status = control.status();
      const waiting = control.pending();

      // Anything pending is something to decide, so decide it from here rather
      // than being told a number and sent looking for the card.
      return waiting.length
        ? { text: renderStatus(status), keyboard: pendingKeyboard(waiting) }
        : renderStatus(status);
    }

    case 'pending':
      return renderPendingList(control.pending());

    case 'pause':
      control.pause();
      return '⏸ Paused. Mentions will not be answered until <code>/x resume</code>.';

    case 'resume':
      control.resume();
      return '▶️ Resumed. Answering mentions again.';

    case 'post': {
      const text = await control.composeNow(rest[0]);
      return text
        ? 'Drafted — sent for your approval above.'
        : 'Nothing worth posting from that angle: the facts did not support one, or it repeated a recent post.';
    }

    case 'approve': {
      const id = rest[0];
      if (!id) return 'Which one? <code>/x approve &lt;id&gt;</code> — see <code>/x pending</code>.';
      return control.approve(id, by);
    }

    case 'reject':
    case 'discard': {
      const id = rest[0];
      if (!id) return 'Which one? <code>/x reject &lt;id&gt;</code> — see <code>/x pending</code>.';
      return control.reject(id, by);
    }

    default:
      return USAGE;
  }
}

export const X_COMMAND_USAGE = USAGE;

/**
 * `/drafts` — re-send every pending post as a card you can act on.
 *
 * `/x pending` lists the queue as text, which is enough to know what is
 * waiting but not to do anything about it: the buttons live on the original
 * card, and in a busy chat that card is far above. This puts a fresh,
 * tappable card for each draft at the bottom of the conversation, where you
 * are already looking.
 *
 * The cards go to the control chat, which may not be where the command was
 * typed — so the reply says how many were sent rather than pretending they
 * appeared here.
 */
export async function runDraftsCommand(
  control: XControl | undefined,
  inControlChat: boolean,
): Promise<string> {
  if (!control) {
    return 'The X bot is not running in this process. Start it with <code>npm run agent</code> to review drafts from here.';
  }

  const waiting = control.pending();
  if (!waiting.length) {
    const status = control.status();

    return status.approvalRequired
      ? 'No drafts waiting. Use <code>/x post</code> to write one now.'
      : 'No drafts waiting — approval is off, so posts publish without one. Set TELEGRAM_CONTROL_CHAT to review them first.';
  }

  const count = await control.resend();
  const plural = count === 1 ? 'draft' : 'drafts';

  return inControlChat
    ? `${count} ${plural} below — tap to publish or discard.`
    : `${count} ${plural} sent to the control chat, where the buttons are.`;
}
