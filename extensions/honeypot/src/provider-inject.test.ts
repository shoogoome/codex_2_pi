import { describe, expect, it } from "vitest";
import { injectProviderPayload } from "./provider-inject.js";

describe("injectProviderPayload", () => {
  it("prepends instructions field", () => {
    const out = injectProviderPayload({ instructions: "base" }, "bridge");
    expect(String(out.instructions)).toContain("[honeypot-INJ]");
    expect(String(out.instructions)).toContain("base");
  });

  it("prepends system message in input array", () => {
    const out = injectProviderPayload({ input: [{ role: "system", content: "x" }] }, "bridge");
    const input = out.input as { content: string }[];
    expect(input[0]?.content).toContain("bridge");
  });

  it("prepends input_text part without flattening structured content", () => {
    const out = injectProviderPayload(
      {
        model: "gpt-5.6-sol",
        instructions: "sys",
        input: [{ role: "developer", content: [{ type: "input_text", text: "x" }] }],
      },
      "inj",
    );
    expect(String(out.instructions)).toContain("[honeypot-INJ]");
    const input = out.input as { content: { type: string; text: string }[] }[];
    expect(input[0]?.content[0]?.type).toBe("input_text");
    expect(input[0]?.content[0]?.text).not.toBe("[honeypot-INJ]");
  });

  it("leaves unknown payload shapes unchanged", () => {
    const payload = { model: "m" };
    expect(injectProviderPayload(payload, "inj")).toEqual(payload);
  });
});
