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
      result: toJson({
        error: 'BAD_ARGUMENTS',
        message: 'Arguments were not valid JSON.',
        hint: 'Send the arguments as a JSON object matching the tool schema.',
      }),
    };
  }

  try {
    return { name, arguments: args, ok: true, result: toJson(await tool.run(args)) };
  } catch (err) {
    const payload =
      err instanceof SingularityError
        ? { error: err.code, message: err.message, hint: err.hint }
        : { error: 'UNEXPECTED', message: err instanceof Error ? err.message : String(err) };

    return { name, arguments: args, ok: false, result: toJson(payload) };
  }
}
