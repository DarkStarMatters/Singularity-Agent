/**
 * Zod shape → JSON Schema, for the handful of shapes the tool catalogue uses.
 *
 * The MCP SDK takes zod shapes directly; Grok's function-calling API takes JSON
 * Schema. Rather than write the parameters twice and let the two descriptions
 * drift apart, the zod shape stays the single source and is converted here.
 *
 * This deliberately covers only what `src/tools/catalog.ts` actually uses. A
 * general converter is a dependency-sized problem, and an unsupported type
 * throws loudly at startup rather than silently emitting `{}` — which a model
 * would read as "this argument takes anything".
 */
import { z } from 'zod';

export interface JsonSchema {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: readonly string[];
  additionalProperties?: boolean;
}

/** Zod hides these behind `_def`; the shapes used here are stable across 3.x. */
interface ZodDef {
  typeName: string;
  innerType?: z.ZodTypeAny;
  type?: z.ZodTypeAny;
  values?: readonly string[];
  options?: z.ZodTypeAny[];
}

function defOf(schema: z.ZodTypeAny): ZodDef {
  return schema._def as unknown as ZodDef;
}

/** True when the argument may be omitted entirely. */
export function isOptional(schema: z.ZodTypeAny): boolean {
  const { typeName } = defOf(schema);
  return typeName === 'ZodOptional' || typeName === 'ZodDefault';
}

export function toJsonSchema(schema: z.ZodTypeAny, name = 'value'): JsonSchema {
  const def = defOf(schema);
  // `.describe()` on the outside of `.optional()` and on the inside both need
  // to survive, so it is read before unwrapping and re-applied after.
  const description = schema.description;

  const rendered = render(schema, def, name);
  return description ? { ...rendered, description } : rendered;
}

function render(schema: z.ZodTypeAny, def: ZodDef, name: string): JsonSchema {
  switch (def.typeName) {
    case 'ZodOptional':
    case 'ZodDefault':
      return toJsonSchema(def.innerType!, name);

    case 'ZodString':
      return { type: 'string' };

    case 'ZodNumber':
      return { type: 'number' };

    case 'ZodBoolean':
      return { type: 'boolean' };

    case 'ZodUnknown':
    case 'ZodAny':
      // No `type` at all: a constrained "anything" in JSON Schema.
      return {};

    case 'ZodArray':
      return { type: 'array', items: toJsonSchema(def.type!, `${name}[]`) };

    case 'ZodEnum':
      return { type: 'string', enum: def.values };

    case 'ZodUnion': {
      const members = (def.options ?? []).map((option) => toJsonSchema(option, name));
      const types = members.map((m) => m.type).filter((t): t is string => typeof t === 'string');

      // Every union in the catalogue is a scalar widening (string | number),
      // which JSON Schema expresses as a type array.
      if (types.length !== members.length) {
        throw new Error(`Cannot convert union at "${name}": members must be scalars.`);
      }
      return { type: [...new Set(types)] };
    }

    default:
      throw new Error(`Unsupported zod type "${def.typeName}" at "${name}".`);
  }
}

/** Converts a whole argument shape into an object schema. */
export function shapeToJsonSchema(shape: Record<string, z.ZodTypeAny>): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(shape)) {
    properties[key] = toJsonSchema(value, key);
    if (!isOptional(value)) required.push(key);
  }

  return {
    type: 'object',
    properties,
    // Omitted entirely when empty: some providers reject `"required": []`.
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  };
}
