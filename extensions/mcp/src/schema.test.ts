import { describe, it, expect } from "vitest";
import { jsonSchemaToTypeBox } from "./schema.js";

describe("jsonSchemaToTypeBox", () => {
  it("returns an empty object schema for missing/invalid schema", () => {
    const s = jsonSchemaToTypeBox(undefined) as { type?: string };
    expect(s.type).toBe("object");
    expect(jsonSchemaToTypeBox("nope")).toBeTruthy();
  });

  it("wraps object required vs optional correctly", () => {
    const s = jsonSchemaToTypeBox({
      type: "object",
      properties: {
        a: { type: "string" },
        b: { type: "number" },
      },
      required: ["a"],
    }) as { type: string; properties: Record<string, unknown>; required?: string[] };
    expect(s.type).toBe("object");
    expect(Object.keys(s.properties).sort()).toEqual(["a", "b"]);
    // TypeBox tracks non-optional keys in `required`.
    expect(s.required).toEqual(["a"]);
  });

  it("passes description through", () => {
    const s = jsonSchemaToTypeBox({ type: "string", description: "hi" }) as {
      description?: string;
    };
    expect(s.description).toBe("hi");
  });

  it("maps primitive types", () => {
    expect((jsonSchemaToTypeBox({ type: "string" }) as { type: string }).type).toBe("string");
    expect((jsonSchemaToTypeBox({ type: "number" }) as { type: string }).type).toBe("number");
    expect((jsonSchemaToTypeBox({ type: "integer" }) as { type: string }).type).toBe("integer");
    expect((jsonSchemaToTypeBox({ type: "boolean" }) as { type: string }).type).toBe("boolean");
  });

  it("converts enum to a string enum", () => {
    const s = jsonSchemaToTypeBox({ enum: ["a", "b", "c"] }) as {
      enum?: string[];
      anyOf?: unknown[];
    };
    // StringEnum encodes values on the schema (enum array).
    expect(s.enum).toEqual(["a", "b", "c"]);
  });

  it("handles arrays with item schema", () => {
    const s = jsonSchemaToTypeBox({ type: "array", items: { type: "string" } }) as {
      type: string;
      items: { type: string };
    };
    expect(s.type).toBe("array");
    expect(s.items.type).toBe("string");
  });

  it("handles nested objects and arrays of objects", () => {
    const s = jsonSchemaToTypeBox({
      type: "object",
      properties: {
        nested: {
          type: "object",
          properties: { x: { type: "integer" } },
          required: ["x"],
        },
        list: { type: "array", items: { type: "object", properties: {} } },
      },
      required: ["nested"],
    }) as {
      properties: {
        nested: { type: string; required?: string[] };
        list: { type: string; items: { type: string } };
      };
      required?: string[];
    };
    expect(s.properties.nested.type).toBe("object");
    expect(s.properties.nested.required).toEqual(["x"]);
    expect(s.properties.list.items.type).toBe("object");
    expect(s.required).toEqual(["nested"]);
  });

  it("treats a schema with properties but no type as object", () => {
    const s = jsonSchemaToTypeBox({ properties: { a: { type: "string" } } }) as {
      type: string;
    };
    expect(s.type).toBe("object");
  });

  it("degrades unknown constructs to Any (no type field)", () => {
    const s = jsonSchemaToTypeBox({ oneOf: [{ type: "string" }] }) as { type?: string };
    expect(s.type).toBeUndefined();
  });
});
