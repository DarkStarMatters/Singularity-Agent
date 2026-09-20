/**
 * Getting the QR to where the phone is.
 *
 * A payment request printed in a terminal is only useful to somebody sitting at
 * that terminal. The person who has to approve it is holding a phone, and often
 * not the same person — so the same code has to reach Telegram, from wherever
 * the request was created: the CLI, an agent over MCP, or the bot itself.
 *
 * The important word is *same*. This does not re-derive anything. One intent
 * produces one URL, that URL produces one matrix, and every surface renders
 * that identical matrix — terminal as half-blocks, Telegram as a PNG. If the
 * code on your screen and the code on your phone could ever differ, one of them
 * is wrong and nobody would know which.
 *
 * It is deliberately fire-and-forget at the call site. A payment request that
 * was created successfully has been created successfully, and a Telegram outage
 * must not turn that into a failure — the link and the QR are already in hand.
 * What it must not do is fail *silently*, so the result says what happened and
 * every caller reports it.
 */

import { TelegramApi } from '../telegram/api.js';
import { qrMatrix } from '../core/qr.js';
import { qrArtPng } from '../art/raster.js';
import type { CreatedIntent } from './operations.js';

/** What happened when we tried to put this in front of a phone. */
export interface NotifyResult {
  sent: boolean;
  /** Why not, when not. Never empty on a failure — an unsent QR that says
   *  nothing about why is worse than one that was never attempted. */
  reason?: string;
  chatId?: number;
  /**
   * Which bot it actually went out as.
   *
   * Reported because this project has already lost time to a stale
   * `TELEGRAM_BOT_TOKEN` in a shell environment shadowing the real one, and
   * the symptom is silent: the send succeeds, the QR arrives, and it arrives
   * from the wrong bot. `sendPhoto` returns the sender for free, so the caller
   * can say which one rather than assuming.
   */
  sentAs?: string;
}

/**
 * Where a payment QR is sent when nobody names a chat.
 *
 * `TELEGRAM_CONTROL_CHAT` already exists for approvals, and a payment request
 * is the same kind of thing: something an operator needs to see and act on.
 * Reusing it means one less variable and no chance of the two drifting apart.
 */
export function payChatId(): number | undefined {
  const raw = (process.env.SINGULARITY_PAY_CHAT || process.env.TELEGRAM_CONTROL_CHAT || '').trim();
  if (!raw) return undefined;

  const id = Number(raw);
  return Number.isFinite(id) && id !== 0 ? id : undefined;
}

/** The caption a payment QR carries into a chat. */
export function payCaption(created: CreatedIntent): string {
  const { intent, risk } = created;
  const asset = intent.mint ? `of ${intent.mint}` : 'SOL';

  const lines = [
    `<b>Payment request</b> — ${intent.label}`,
    '',
    `<b>${intent.amount}</b> ${asset}`,
    `to <code>${intent.to}</code>`,
  ];

  if (intent.memo) lines.push(`memo <code>${intent.memo}</code>`);
  if (intent.orderId) lines.push(`order <code>${intent.orderId}</code>`);

  // The risk read belongs on the approval screen, not in a log somewhere. If
  // the token can be frozen or clawed back after it arrives, the person about
  // to accept it should be told before they show this to a customer.
  if (risk && !risk.custodyIsYours) {
    lines.push('', '⚠️ <b>Custody is shared</b> — a named party can freeze or take this after you are paid.');
    for (const warning of risk.warnings.slice(0, 2)) lines.push(`• ${warning}`);
  }

  lines.push(
    '',
    `<i>Scan with Phantom or any Solana wallet. The wallet builds and shows the transaction — Singularity holds no keys and cannot sign it.</i>`,
    '',
    `<code>${intent.id}</code>`,
  );

  return lines.join('\n');
}

/**
 * Send a created payment request to Telegram as a scannable image.
 *
 * Returns rather than throws. Every caller here has already produced a working
 * link by the time this runs, and losing that because a chat was unreachable
 * would be the wrong trade.
 */
export async function notifyPayment(
  created: CreatedIntent,
  options: { chatId?: number; token?: string } = {},
): Promise<NotifyResult> {
  const token = (options.token ?? process.env.TELEGRAM_BOT_TOKEN ?? '').trim();
  const chatId = options.chatId ?? payChatId();

  if (!token) {
    return { sent: false, reason: 'TELEGRAM_BOT_TOKEN is not set, so there is no bot to send from.' };
  }

  if (chatId === undefined) {
    return {
      sent: false,
      reason:
        'No chat to send to. Set SINGULARITY_PAY_CHAT, or TELEGRAM_CONTROL_CHAT, to the numeric chat id — /chatid in the bot prints it.',
    };
  }

  try {
    // The same matrix *and* the same artwork the terminal renders. One intent,
    // one URL, one code — the reference seeds the style, so a payer comparing
    // the picture in the chat against the one on screen sees the same thing.
    const png = qrArtPng(qrMatrix(created.url), created.intent.reference, { scale: 8 });

    const message = await new TelegramApi(token).sendPhoto({
      chatId,
      photo: png,
      filename: `payment-${created.intent.id.slice(0, 8)}.png`,
      caption: payCaption(created),
    });

    const sentAs = message.from?.username;
    return { sent: true, chatId, ...(sentAs ? { sentAs } : {}) };
  } catch (err) {
    return { sent: false, chatId, reason: (err as Error).message };
  }
}
