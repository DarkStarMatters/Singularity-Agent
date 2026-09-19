/**
 * One catalogue, four shapes.
 *
 * The agent already defines its tools once, in `src/tools/catalog.ts`, with a
 * Zod shape, a description written for a model, read-only annotations and the
 * implementation attached. The MCP server serves them; the CLI shares their
 * operations. What was missing is the rest of the world: an application built
 * on this SDK that wants to *be* an agent has had to hand-transcribe those
 * definitions into whichever framework it uses, and a transcribed tool schema
 * drifts from the operation it describes on the first change nobody
 * propagated.
 *
 * So everything below is derived. There is no second list of tool names here,
 * no parallel dispatch table, no re-worded descriptions — add a tool to the
 * catalogue and it appears in all four shapes, change a description and no copy
 * is left saying the old thing. That is the only property this file is really
 * trying to have, and it is why the code is thinner than the comment.
 *
 * Every tool in the catalogue reads and cannot write. Writes deliberately have
 * no entry: they need a signer, and a signature is not something a model should
 * be able to reach for mid-sentence. If you want an agent that can spend, build
 * that gate yourself — {@link createExecutor} hands you every call before it
 * runs, which is where the gate goes.
 */

import { TOOLS, getTool, shapeToJsonSchema, type ToolDefinition } from 'singularity-agent';
import { z } from 'zod';

export { TOOLS, getTool };
export type { ToolDefinition };

/** A tool in Anthropic Messages API form. */
export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** A tool in OpenAI-style function-calling form, which many frameworks reuse. */
export interface FunctionTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/** A tool in MCP `tools/list` form. */
export interface McpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; openWorldHint: boolean; destructiveHint?: boolean };
}

/**
 * Which tools to expose.
 *
 * Worth having because the catalogue is built for a general-purpose assistant
 * and most applications are not. A burn dashboard has no use for `decode`, and
 * every tool handed to a model is a tool it can be talked into calling.
 */
export interface ToolSelection {
  only?: string[];
  except?: string[];
}

export function selectTools(selection: ToolSelection = {}): ToolDefinition[] {
  let list: ToolDefinition[] = TOOLS;
  if (selection.only?.length) {
    const wanted = new Set(selection.only);
    list = list.filter((tool) => wanted.has(tool.name));
  }
  if (selection.except?.length) {
    const unwanted = new Set(selection.except);
    list = list.filter((tool) => !unwanted.has(tool.name));
  }
  return list;
}

const schemaOf = (tool: ToolDefinition): Record<string, unknown> =>
  shapeToJsonSchema(tool.shape as Record<string, z.ZodTypeAny>) as unknown as Record<string, unknown>;

/** The catalogue as Anthropic `tools`. */
export function anthropicTools(selection?: ToolSelection): AnthropicTool[] {
  return selectTools(selection).map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: schemaOf(tool),
  }));
}

/** The catalogue as OpenAI-style function tools. */
export function functionTools(selection?: ToolSelection): FunctionTool[] {
  return selectTools(selection).map((tool) => ({
    type: 'function' as const,
    function: { name: tool.name, description: tool.description, parameters: schemaOf(tool) },
  }));
}

/** The catalogue as MCP tool descriptors. */
export function mcpTools(selection?: ToolSelection): McpTool[] {
  return selectTools(selection).map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: schemaOf(tool),
    annotations: tool.annotations,
  }));
}

/** What running a tool produced. */
export interface ToolResult {
  name: string;
  /** The operation's own return value, envelope and all. */
  result?: unknown;
  /** Set instead of `result` when the call failed. */
  error?: { code: string; message: string; hint?: string };
  /** True when `error` is set. Frameworks that flag errored results read this. */
  isError: boolean;
}

/**
 * Run a tool call by name.
 *
 * The dispatch a tool-use loop needs, minus the loop — there are a dozen
 * reasonable ways to write that and none of them belong in a library.
 *
 * Two things happen here that are worth being explicit about.
 *
 * **Arguments are validated before the operation sees them.** The catalogue's
 * `run` casts rather than parses, which is correct where it is used — the MCP
 * SDK validates against the same Zod shape on the way in. Nothing validates on
 * this path, and the caller here is a language model improvising JSON, so the
 * shape is parsed. A model that passes `limit: "ten"` gets a readable message
 * about `limit` rather than `NaN` reaching an RPC call.
 *
 * **Failures come back as values, not throws.** A model that sees a thrown
 * exception sees a crashed turn; a model that sees `{ isError: true, hint }`
 * sees something it can act on, and the hints in this codebase are written for
 * exactly that reader. The completeness envelope is never touched on the way
 * through, so a `curated` scan is still labelled `curated` when the model
 * reads it.
 */
export async function runTool(name: string, input: Record<string, unknown> = {}): Promise<ToolResult> {
  const tool = getTool(name);
  if (!tool) {
    return {
      name,
      isError: true,
      error: {
        code: 'UNKNOWN_TOOL',
        message: `No tool named "${name}".`,
        hint: `Known tools: ${TOOLS.map((t) => t.name).join(', ')}.`,
      },
    };
  }

  const parsed = z.object(tool.shape as z.ZodRawShape).safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      name,
      isError: true,
      error: {
        code: 'BAD_ARGUMENTS',
        message: first
          ? `${first.path.join('.') || '(root)'}: ${first.message}`
          : 'The arguments did not match this tool.',
        hint: `Check the schema for "${name}".`,
      },
    };
  }

  try {
    return { name, result: await tool.run(parsed.data as Record<string, unknown>), isError: false };
  } catch (err) {
    const hint = (err as { hint?: unknown })?.hint;
    return {
      name,
      isError: true,
      error: {
        code: String((err as { code?: unknown })?.code ?? 'ERROR'),
        message: (err as Error)?.message ?? String(err),
        ...(typeof hint === 'string' ? { hint } : {}),
      },
    };
  }
}

export interface Executor {
  /** The tools this executor exposes, already filtered. */
  tools: ToolDefinition[];
  /** The same set in Anthropic form, ready to hand to the Messages API. */
  anthropic(): AnthropicTool[];
  /** The same set in OpenAI-style form. */
  functions(): FunctionTool[];
  run(name: string, input?: Record<string, unknown>): Promise<ToolResult>;
}

/**
 * A tool executor with your own policy in front of it.
 *
 * `before` sees every call and may rewrite its input, or throw to refuse it.
 * This is where an application puts what a library cannot decide: an allow-list
 * of addresses, a rate limit, a human confirmation, a redaction pass over what
 * gets logged. It runs after the model chose a tool and before the tool runs,
 * which is the only moment where both what was asked and what it would do are
 * known.
 *
 * Note what `run` does with a tool that was filtered out: it refuses by name
 * rather than falling through. A model can name a tool it was never offered —
 * from its training, or from earlier in the same conversation — and a filter
 * that only shortens a list is not a filter.
 */
export function createExecutor(
  options: {
    selection?: ToolSelection;
    before?: (
      name: string,
      input: Record<string, unknown>,
    ) => Record<string, unknown> | void | Promise<Record<string, unknown> | void>;
    after?: (result: ToolResult) => void | Promise<void>;
  } = {},
): Executor {
  const tools = selectTools(options.selection);
  const allowed = new Set(tools.map((tool) => tool.name));
  const selection = options.selection;

  return {
    tools,
    anthropic: () => anthropicTools(selection),
    functions: () => functionTools(selection),

    async run(name, input = {}) {
      if (!allowed.has(name)) {
        // Through `after` like every other outcome, not returned early. This
        // is the call an audit log most wants — a model reaching for a tool it
        // was never given — and skipping the hook here would drop precisely
        // those and keep the ordinary ones.
        const unavailable: ToolResult = {
          name,
          isError: true,
          error: {
            code: 'TOOL_NOT_AVAILABLE',
            message: `"${name}" is not available to this executor.`,
            hint: `Available: ${[...allowed].join(', ')}.`,
          },
        };
        await options.after?.(unavailable);
        return unavailable;
      }

      let effective = input;
      if (options.before) {
        try {
          const rewritten = await options.before(name, input);
          if (rewritten) effective = rewritten;
        } catch (err) {
          const refused: ToolResult = {
            name,
            isError: true,
            error: {
              code: String((err as { code?: unknown })?.code ?? 'REFUSED'),
              message: (err as Error)?.message ?? String(err),
            },
          };
          await options.after?.(refused);
          return refused;
        }
      }

      const result = await runTool(name, effective);
      await options.after?.(result);
      return result;
    },
  };
}
