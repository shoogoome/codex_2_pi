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
});
