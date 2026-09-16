/**
 * Posting a project update from elizaOS.
 *
 * The X listener posts these on a timer; this is the same thing on demand, so
 * an agent can be told "post an update about chain coverage" and do it through
 * the plugin rather than out of band.
 *
 * It shares `src/x/updates.ts` with the scheduler, which means the grounding
 * rule holds here too: the model is handed facts read out of the repository and
 * told that anything not in them does not exist. An agent cannot talk its way
 * into announcing a release that did not happen.
 */
import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
} from '@elizaos/core';
import { XClient, loadXConfig } from '../x/client.js';
import {
  UPDATE_ANGLES,
  collectProjectFacts,
  nextUpdate,
  postUpdate,
  updateBriefs,
  type UpdateAngle,
} from '../x/updates.js';
import { GrokAgent } from '../grok/agent.js';
import { grokClientFor } from './grok-model.js';
import { systemPromptFor } from '../grok/persona.js';
import { toPlainText } from './plain.js';
import { formatError } from '../telegram/format.js';
import { settingsEnv } from './settings.js';
import { messageText } from './actions.js';

export const POST_PROJECT_UPDATE = 'POST_PROJECT_UPDATE';

/** Lets someone say "post about what chains we support" and get that angle. */
export function angleFrom(text: string): UpdateAngle | null {
  const lower = text.toLowerCase();

  for (const angle of UPDATE_ANGLES) {
    if (lower.includes(angle)) return angle;
  }
  // "coverage" and "safety" were angles once; they are now the chain and
  // limitation angles, so the words people still use keep working.
  if (/\bchains?\b|\bcoverage\b|\bsupport\b/.test(lower)) return 'chainnote';
  if (/\bsafe|\bkeys?\b|\bsign|\bcustody\b|\blimit/.test(lower)) return 'limitation';
  if (/\bhow do|\bhow to|\bcommand|\bexample/.test(lower)) return 'howto';
  if (/\bgotcha|\btrap|\bmistake/.test(lower)) return 'gotcha';
  if (/\bchange|\bshipped|\brelease|\bcommit/.test(lower)) return 'changelog';
  if (/\bwhy\b|\bphilosoph|\bdesign\b/.test(lower)) return 'philosophy';

  return null;
}

export const postProjectUpdateAction: Action = {
  name: POST_PROJECT_UPDATE,
  similes: ['PROJECT_UPDATE', 'ANNOUNCE', 'POST_UPDATE', 'SHARE_PROGRESS'],
  description:
    'Write and publish a project update on X about Singularity itself — what it covers, what it can do, what changed. Written only from facts read out of the repository, so it cannot announce anything that did not happen. Publishing is gated by X_POSTING_ENABLED; otherwise it returns a draft. Use when asked to post an update or announce something about the project, not to answer a question.',

  examples: [
    [
      { name: '{{user}}', content: { text: 'post a project update about what chains we support' } },
      {
        name: '{{agent}}',
        content: { text: 'Writing one from the chain registry.', actions: [POST_PROJECT_UPDATE] },
      },
    ],
    [
      { name: '{{user}}', content: { text: 'announce what shipped recently' } },
      {
        name: '{{agent}}',
        content: { text: 'Pulling the recent commits.', actions: [POST_PROJECT_UPDATE] },
      },
    ],
  ],

  validate: async (runtime, message) => {
    if (!loadXConfig(settingsEnv(runtime))) return false;

    const text = messageText(message).toLowerCase();
    return /\b(update|announce|announcement|progress|changelog|release)\b/.test(text);
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state,
    options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const config = loadXConfig(settingsEnv(runtime));

    if (!config) {
      const text = 'X is not configured, so there is nothing to post to.';
      await callback?.({ text, actions: [POST_PROJECT_UPDATE] });
      return { success: false, text, error: new Error('X credentials missing') };
    }

    try {
      const facts = collectProjectFacts();
      const requested = typeof options?.angle === 'string' ? (options.angle as UpdateAngle) : null;
      const angle =
        (requested && UPDATE_ANGLES.includes(requested) ? requested : null) ??
        angleFrom(messageText(message));

      // Narrow to the requested angle when there is one, then let nextUpdate
      // pick the subject — otherwise "post about chains" would say the same
      // thing about the same chain every time anyone asked.
      const briefs = updateBriefs(facts);
      const pool = angle ? briefs.filter((candidate) => candidate.angle === angle) : briefs;
      const brief = nextUpdate(pool.length ? pool : briefs, [], []);
      if (!brief) throw new Error('No update material is available to write from.');

      // A fresh agent rather than the conversation's own: an update is written
      // from the fact sheet, and chat history would only bias it. postUpdate
      // takes care of disabling tools and allowing an empty answer.
      const writer = new GrokAgent(grokClientFor(runtime, 'large'), {
        system: systemPromptFor('x'),
      });

      const update = await postUpdate(new XClient(config), writer, facts, brief, {
        ...(options?.dryRun === true ? { dryRun: true } : {}),
      });

      if (!update) {
        const text = `Nothing worth posting for the ${brief.angle} angle — the facts did not support a post, so I wrote none.`;
        await callback?.({ text, actions: [POST_PROJECT_UPDATE] });
        return { success: true, text, data: { angle: brief.angle, subject: brief.subject, posted: false } };
      }

      const rendered = update.result.published
        ? `Posted a ${brief.angle} update.\n\n${update.text}\n\n${update.result.url ?? ''}`.trimEnd()
        : `Drafted a ${brief.angle} update — not published.\n\n${update.text}\n\nReason: ${update.result.reason ?? 'posting disabled'}`;

      await callback?.({
        text: rendered,
        actions: [POST_PROJECT_UPDATE],
        ...(update.result.url ? { url: update.result.url } : {}),
      });

      return { success: true, text: rendered, data: { angle: brief.angle, subject: brief.subject, update: update.result } };
    } catch (err) {
      const rendered = toPlainText(formatError(err));
      await callback?.({ text: rendered, actions: [POST_PROJECT_UPDATE] });
      return {
        success: false,
        text: rendered,
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
  },
};
