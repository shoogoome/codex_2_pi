import { describe, it, expect, vi } from "vitest";

// Mock the transport so index.ts's real connect() path (McpClient handshake +
// tool registration) runs end-to-end without spawning a process or hitting the
// network. Each createTransport() call returns a scripted fake and is recorded.
const hoisted = vi.hoisted(() => {
  const transports: Array<{ calls: Array<{ method: string; params?: unknown }> }> = [];
  return { transports };
});

vi.mock("./src/transport.js", () => ({
  createTransport: () => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    const t = {
      calls,
      async request(method: string, params?: unknown) {
        calls.push({ method, params });
        if (method === "initialize") return {};
        if (method === "tools/list") {
          return { tools: [{ name: "query", description: "run a query", inputSchema: { type: "object" } }] };
        }
        if (method === "tools/call") return { content: [{ type: "text", text: "ok" }] };
        return {};
      },
      notify() {},
      close() {},
    };
    hoisted.transports.push(t);
    return t;
  },
}));

import mcpExtension from "./index.js";
import { parseMcpToolName } from "./src/naming.js";

type Handler = (data: unknown) => void;

function createPi() {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const lifecycle = new Map<string, Handler[]>();
  const events = new Map<string, Handler[]>();
  const pi = {
    tools,
    commands,
    registerTool: (t: any) => tools.set(t.name, t),
    registerCommand: (name: string, opts: any) => commands.set(name, opts),
    on: (ev: string, h: Handler) => {
      lifecycle.set(ev, [...(lifecycle.get(ev) ?? []), h]);
    },
    events: {
      on: (ev: string, h: Handler) => {
        events.set(ev, [...(events.get(ev) ?? []), h]);
        return () => {};
      },
      emit: (ev: string, data: unknown) => {
        (events.get(ev) ?? []).forEach((h) => h(data));
      },
    },
  };
  return pi;
}

// Drain the async connect() chain (a few awaited transport requests).
const flush = async () => {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
};

const OPENAI_FN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

describe("mcp extension — runtime injection of an illegal server name", () => {
  it("registers an OpenAI-legal tool name and dispatches via the canonical id", async () => {
    const pi = createPi();
    mcpExtension(pi as any);

    pi.events.emit("mcp:register-server", {
      name: "zhiyan:zhiyan-log",
      config: { type: "http", url: "https://example.com/mcp" },
    });
    await flush();

    const expected = "mcp__zhiyan_zhiyan-log__query";
    expect(pi.tools.has(expected)).toBe(true);
    // Every registered tool name must satisfy OpenAI's function-name rule.
    for (const name of pi.tools.keys()) expect(name).toMatch(OPENAI_FN);

    // parseToolName reverses back to the canonical server used for dispatch...
    expect(parseMcpToolName(expected)).toEqual({ server: "zhiyan_zhiyan-log", tool: "query" });
    // ...and the approvals server-level matcher (mcp__<server>) still matches.
    expect(expected.startsWith("mcp__zhiyan_zhiyan-log__")).toBe(true);

    // Dispatch: executing the tool forwards to the live client using the raw
    // remote tool name ("query"), and maps the result back.
    const tool = pi.tools.get(expected)!;
    const res = await tool.execute("call-1", { q: 1 });
    expect(res.details).toEqual({ server: "zhiyan_zhiyan-log", tool: "query", isError: false });
    const callFrame = hoisted.transports
      .flatMap((t) => t.calls)
      .find((c) => c.method === "tools/call");
    expect(callFrame?.params).toEqual({ name: "query", arguments: { q: 1 } });
  });

  it("resolves canonical-id collisions between distinct raw names with a suffix", async () => {
    const pi = createPi();
    mcpExtension(pi as any);

    pi.events.emit("mcp:register-server", {
      name: "zhiyan:zhiyan-log",
      config: { type: "http", url: "https://a" },
    });
    pi.events.emit("mcp:register-server", {
      name: "zhiyan.zhiyan-log", // sanitizes to the same base as above
      config: { type: "http", url: "https://b" },
    });
    await flush();

    expect(pi.tools.has("mcp__zhiyan_zhiyan-log__query")).toBe(true);
    expect(pi.tools.has("mcp__zhiyan_zhiyan-log_2__query")).toBe(true);
    for (const name of pi.tools.keys()) expect(name).toMatch(OPENAI_FN);
  });
});
