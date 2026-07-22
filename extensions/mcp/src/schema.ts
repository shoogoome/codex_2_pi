// Pure conversion from an MCP tool inputSchema (JSON Schema subset) to a
// TypeBox schema for pi.registerTool. Unknown constructs degrade to Type.Any()
// so tool registration never fails on an exotic schema.

import { Type } from "typebox";
import type { TSchema } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function optionsFor(schema: Record<string, unknown>): { description?: string } {
  const opts: { description?: string } = {};
  if (typeof schema.description === "string") opts.description = schema.description;
  return opts;
}

/**
 * Convert a JSON Schema node to a TypeBox schema.
 *
 * Covers: object (properties + required→optional wrapping), string, number,
 * integer, boolean, array (items), enum (→StringEnum), description passthrough,
 * and nesting. Anything else → Type.Any(). A missing/empty schema → Type.Object({}).
 */
export function jsonSchemaToTypeBox(schema: unknown): TSchema {
  if (!isObject(schema)) {
    return Type.Object({});
  }

  const opts = optionsFor(schema);

  // Enum takes precedence: a list of string literals → StringEnum.
  if (Array.isArray(schema.enum)) {
    const values = schema.enum.filter((v): v is string => typeof v === "string");
    if (values.length > 0 && values.length === schema.enum.length) {
      return StringEnum(values, opts);
    }
    return Type.Any();
  }

  const type = schema.type;

  switch (type) {
    case "object": {
      const props = isObject(schema.properties) ? schema.properties : {};
      const required = Array.isArray(schema.required)
        ? schema.required.filter((r): r is string => typeof r === "string")
        : [];
      const fields: Record<string, TSchema> = {};
      for (const [key, propSchema] of Object.entries(props)) {
        const converted = jsonSchemaToTypeBox(propSchema);
        fields[key] = required.includes(key) ? converted : Type.Optional(converted);
      }
      return Type.Object(fields, opts);
    }
    case "string":
      return Type.String(opts);
    case "number":
      return Type.Number(opts);
    case "integer":
      return Type.Integer(opts);
    case "boolean":
      return Type.Boolean(opts);
    case "array": {
      const items = schema.items === undefined ? Type.Any() : jsonSchemaToTypeBox(schema.items);
      return Type.Array(items, opts);
    }
    default:
      // No type but has properties → treat as object.
      if (isObject(schema.properties)) {
        return jsonSchemaToTypeBox({ ...schema, type: "object" });
      }
      return Type.Any();
  }
}
