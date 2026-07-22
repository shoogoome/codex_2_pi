import { describe, it, expect } from "vitest";
import { parseHttpBody } from "./transport.js";

// Only the pure HTTP body parser is unit-tested here. StdioTransport /
// HttpTransport themselves are exercised via the framing + client tests to keep
// the suite from spawning processes or hitting the network.
describe("parseHttpBody", () => {
  it("parses a plain JSON object body", () => {
    expect(parseHttpBody('{"result":{"ok":1}}')).toEqual({ result: { ok: 1 } });
  });

  it("parses an SSE-style data frame", () => {
    const sse = "event: message\ndata: {\"result\":42}\n\n";
    expect(parseHttpBody(sse)).toEqual({ result: 42 });
  });

  it("returns undefined for empty body", () => {
    expect(parseHttpBody("   ")).toBeUndefined();
  });
});
