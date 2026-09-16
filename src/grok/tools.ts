/**
 * The tool catalogue, exposed to Grok as callable functions.
 *
 * Nothing here describes what the tools do — that lives once, in
 * `src/tools/catalog.ts`, and is converted rather than restated.
 *
 * A tool that throws returns its error to the model as a normal result. That is
 * the whole point of the `hint` on `SingularityError`: "unknown chain, did you
 * mean base?" lets the model fix its own call, whereas a thrown exception ends
 * the turn with nothing to say.
 */
import { getTool, TOOLS } from '../tools/catalog.js';
import { shapeToJsonSchema } from '../tools/json-schema.js';
import { SingularityError } from '../core/errors.js';
import { toJson } from '../core/format.js';
import {
  carriesUntrusted,
  findCompleteness,
  weakest,
  UNTRUSTED_NOTE,
  type Completeness,
} from '../core/envelope.js';
import type { ToolCall, ToolSchema } from './client.js';

/** Built once: the schemas are static for the process lifetime. */
let cached: ToolSchema[] | null = null;

export function toolSchemas(): ToolSchema[] {
  cached ??= TOOLS.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: shapeToJsonSchema(tool.shape),
    },
  }));
  return cached;
}

export interface ToolRun {
  name: string;
  arguments: Record<string, unknown>;
  /** JSON, ready to hand back as a `tool` message. */
  result: string;
  ok: boolean;
  /**
   * The weakest completeness anywhere in this result, when it carried one.
   *
   * Kept structured rather than left buried in the JSON so a surface can act
   * on it — the X listener uses it to refuse to publish a claim the data does
   * not support. A model reading the same caveat in prose may honour it; a
   * publish gate reading this field has no choice.
   */
  completeness?: Completeness;
  /** The result contained text authored on-chain. */
  untrusted: boolean;
}

/**
 * Wraps a result before the model sees it.
 *
 * `runToolCall` is the seam where chain data becomes model context, and on this
 * repo's X surface that context goes on to compose a public post. A token whose
 * `symbol()` is a sentence aimed at the reader arrives here having already been
 * stripped of anything that could forge structure (see `sanitizeOnchainText`);
 * what is added here is the other half — telling the model, in the same
 * message, that those fields are data and not instructions.
 */
function envelope(value: unknown): { json: string; completeness?: Completeness; untrusted: boolean } {
  const untrusted = carriesUntrusted(value);
  const found = findCompleteness(value);
  const worst = weakest(found);

  const payload =
    untrusted && value && typeof value === 'object'
      ? { ...(value as Record<string, unknown>), _untrusted: UNTRUSTED_NOTE }
      : value;

  return {
    json: toJson(payload),
    ...(worst ? { completeness: worst } : {}),
    untrusted,
  };
}

/**
 * Runs one tool call. Never throws: every failure becomes a result the model
 * can read and react to.
 */
export async function runToolCall(call: ToolCall): Promise<ToolRun> {
  const name = call.function.name;
  const tool = getTool(name);

  if (!tool) {
    return {
      name,
      arguments: {},
      ok: false,
      untrusted: false,
      result: toJson({
        error: 'UNKNOWN_TOOL',
        message: `There is no tool called "${name}".`,
        hint: `Available tools: ${TOOLS.map((t) => t.name).join(', ')}.`,
      }),
    };
  }

  let args: Record<string, unknown>;
  try {
    // Models occasionally send "" or "null" for a no-argument call.
    const raw = call.function.arguments?.trim();
    args = raw && raw !== 'null' ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return {
      name,
      arguments: {},
      ok: false,
      untrusted: false,
      result: toJson({
        error: 'BAD_ARGUMENTS',
        message: 'Arguments were not valid JSON.',
        hint: 'Send the arguments as a JSON object matching the tool schema.',
      }),
    };
  }

  try {
    const { json, completeness, untrusted } = envelope(await tool.run(args));
    return {
      name,
      arguments: args,
      ok: true,
      result: json,
      untrusted,
      ...(completeness ? { completeness } : {}),
    };
  } catch (err) {
    const payload =
      err instanceof SingularityError
        ? { error: err.code, message: err.message, hint: err.hint }
        : { error: 'UNEXPECTED', message: err instanceof Error ? err.message : String(err) };

    return { name, arguments: args, ok: false, untrusted: false, result: toJson(payload) };
  }
}
