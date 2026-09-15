/**
 * Posting to X from elizaOS.
 *
 * This is the only action in the plugin that reaches outside the process and
 * does something a user cannot take back, so it is built the other way round
 * from the rest: the default outcome is a draft, and publishing is what has to
 * be argued for.
 *
 * Three gates stand between an agent deciding to post and a post existing:
 *
 *   1. Credentials. Without all four OAuth 1.0a values the action does not even
 *      validate, so the agent never offers it.
 *   2. `X_POSTING_ENABLED` must be exactly "true" (enforced in `XClient.post`).
 *   3. `dryRun` in the handler options forces a draft regardless of 1 and 2 —
 *      the switch a caller can flip per call to preview.
 *
 * When the action drafts instead of publishing it still returns `success: true`
 * with the drafted text: drafting is the designed outcome, not a failure, and
 * reporting it as an error would make the agent retry.
 */
import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
} from '@elizaos/core';
import { DEFAULT_POST_LIMIT, XClient, loadXConfig, type PostResult } from '../x/client.js';
import { toPlainText } from './plain.js';
import { formatError } from '../telegram/format.js';
import { settingsEnv } from './settings.js';
import { messageText } from './actions.js';

export const POST_TO_X = 'POST_TO_X';

/** Explicit text wins over anything drafted. `"…"`, `'…'`, or `post: …`. */
const QUOTED = /["“']([^"”']{1,400})["”']/;
const AFTER_COLON = /\b(?:post|tweet|publish)\s*:\s*([\s\S]{1,400})$/i;

/**
 * Pulls out text the user supplied verbatim, so "post this: gas is cheap" does
 * not get paraphrased by a model before it goes out under their name.
 */
export function explicitPostText(message: string): string | null {
  const quoted = QUOTED.exec(message);
  if (quoted?.[1]?.trim()) return quoted[1].trim();

  const afterColon = AFTER_COLON.exec(message);
  if (afterColon?.[1]?.trim()) return afterColon[1].trim();

  return null;
}

/**
 * The drafting prompt. The length rule is repeated as a hard number because
 * models reliably overshoot a "keep it short" instruction, and an overshoot is
 * a `POST_TOO_LONG` throw rather than a truncated post.
 */
export function draftPrompt(request: string): string {
  return [
    'Write a single post for X (formerly Twitter) based on the request below.',
    '',
    `Request: ${request}`,
    '',
    'Rules:',
    `- Hard maximum ${DEFAULT_POST_LIMIT} characters, including spaces. Count them.`,
    '- Plain text only. No surrounding quotation marks, no preamble, no commentary.',
    '- No hashtags unless the request asks for them.',
    '- State only what the request supports. Do not invent numbers, prices or events.',
    '',
    'Return the post text and nothing else.',
  ].join('\n');
}

/**
 * Models wrap output in quotes or a "Here's your post:" preamble often enough
 * that it is worth undoing, since either would be published literally.
 */
export function cleanDraft(raw: string): string {
  const withoutPreamble = raw.replace(/^[^\n]{0,60}:\s*\n+/, '').trim();
  const unwrapped = /^["“']([\s\S]+)["”']$/.exec(withoutPreamble);
  return (unwrapped?.[1] ?? withoutPreamble).trim();
}

function renderResult(result: PostResult): string {
  if (result.published) {
    return [`Posted to X.`, ``, result.text, ``, result.url ?? ''].join('\n').trimEnd();
  }
  return [
    'Not published — this is a draft.',
    '',
    result.text,
    '',
    `(${result.text.length}/${DEFAULT_POST_LIMIT} characters)`,
    result.reason ? `Reason: ${result.reason}` : '',
  ]
    .join('\n')
    .trimEnd();
}

export const postToXAction: Action = {
  name: POST_TO_X,
  similes: ['TWEET', 'POST_TWEET', 'PUBLISH_POST', 'SHARE_ON_X', 'POST_ON_TWITTER'],
  description:
    'Compose and publish a post on X. Publishing is gated: with X_POSTING_ENABLED unset or not exactly "true", this returns a draft and nothing leaves the process. Use when the user asks to post, tweet, or publish something. Do not use to answer a question in chat.',

  examples: [
    [
      { name: '{{user}}', content: { text: 'post about how cheap base gas is right now' } },
      {
        name: '{{agent}}',
        content: { text: 'Drafting a post about Base fees.', actions: [POST_TO_X] },
      },
    ],
    [
      { name: '{{user}}', content: { text: 'tweet this: "chain-agnostic beats chain-maximalist"' } },
      {
        name: '{{agent}}',
        content: { text: 'Posting that verbatim.', actions: [POST_TO_X] },
      },
    ],
  ],

  // Unconfigured credentials mean the action is invisible to the agent, rather
  // than offered and then failing after the user has agreed to it.
  validate: async (runtime, message) => {
    if (!loadXConfig(settingsEnv(runtime))) return false;

    const text = messageText(message).toLowerCase();
    return /\b(post|tweet|publish|share)\b/.test(text);
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state,
    options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const config = loadXConfig(settingsEnv(runtime));

    // `validate` already checked, but a handler can be called directly.
    if (!config) {
      const text =
        'X is not configured, so there is nothing to post to. Set X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN and X_ACCESS_SECRET.';
      await callback?.({ text, actions: [POST_TO_X] });
      return { success: false, text, error: new Error('X credentials missing') };
    }

    try {
      const override = typeof options?.text === 'string' ? options.text.trim() : '';
      const supplied = override || explicitPostText(messageText(message));

      const text =
        supplied ??
        cleanDraft(
          await runtime.useModel('TEXT_LARGE', { prompt: draftPrompt(messageText(message)) }),
        );

      const result = await new XClient(config).post(text, {
        dryRun: options?.dryRun === true,
      });

      const rendered = renderResult(result);
      await callback?.({
        text: rendered,
        actions: [POST_TO_X],
        ...(result.url ? { url: result.url } : {}),
      });

      // A draft is a successful outcome — see the header.
      return { success: true, text: rendered, data: { post: result } };
    } catch (err) {
      const rendered = toPlainText(formatError(err));
      await callback?.({ text: rendered, actions: [POST_TO_X] });
      return {
        success: false,
        text: rendered,
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
  },
};
