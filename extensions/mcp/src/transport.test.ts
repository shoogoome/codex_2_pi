import { afterEach, describe, it, expect, vi } from "vitest";
import { HttpTransport, parseHttpBody } from "./transport.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

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

describe("HttpTransport environment expansion", () => {
  it("expands $VAR and ${VAR} references in the HTTP URL", async () => {
    vi.stubEnv("IWIKI_MCP_URL", "https://iwiki.example.test/mcp");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      text: () => Promise.resolve('{"jsonrpc":"2.0","id":1,"result":{}}'),
    });
    vi.stubGlobal("fetch", fetchMock);
    const transport = new HttpTransport({
      url: "${IWIKI_MCP_URL}",
      type: "http",
    });

    await transport.request("initialize", {});

    expect(fetchMock).toHaveBeenCalledWith(
      "https://iwiki.example.test/mcp",
      expect.any(Object),
    );
  });

  it("expands $VAR and ${VAR} references in HTTP headers", async () => {
    vi.stubEnv("TAIJI_MCP_TOKEN", "secret-token");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      text: () => Promise.resolve('{"jsonrpc":"2.0","id":1,"result":{}}'),
    });
    vi.stubGlobal("fetch", fetchMock);
    const transport = new HttpTransport({
      url: "http://localhost/mcp",
      type: "http",
      headers: {
        Authorization: "Bearer ${TAIJI_MCP_TOKEN}",
        "x-api-key": "$TAIJI_MCP_TOKEN",
      },
    });

    await transport.request("initialize", {});

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost/mcp",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer secret-token",
          "x-api-key": "secret-token",
        }),
      }),
    );
  });

  it("fails clearly when a referenced environment variable is missing", () => {
    delete process.env.MISSING_MCP_URL;
    delete process.env.MISSING_MCP_TOKEN;
    expect(
      () =>
        new HttpTransport({
          url: "${MISSING_MCP_URL}",
          type: "http",
          headers: { Authorization: "Bearer ${MISSING_MCP_TOKEN}" },
        }),
    ).toThrow("Missing environment variable(s): MISSING_MCP_URL, MISSING_MCP_TOKEN");
  });
});
