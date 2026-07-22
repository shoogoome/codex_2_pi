import { describe, it, expect } from "vitest";
import { connectServer } from "./orchestrator.js";
import type { ToolDefinitionSpec } from "./register.js";
import type { Transport } from "./types.js";

// A scripted fake transport: records every request in order and replies from a
// per-method responder. No process is spawned and no network is touched.
function fakeTransport(
  responder: (method: string, params?: unknown) => unknown,
): Transport & { calls: Array<{ method: string; params?: unknown }>; notes: string[] } {
  const calls: Array<{ method: string; params?: unknown }> = [];
  const notes: string[] = [];
  return {
    calls,
    notes,
    async request(method, params) {
      calls.push({ method, params });
      return responder(method, params);
    },
    notify(method) {
      notes.push(method);
    },
    close() {},
  };
}

const TOOLS = [
  {
    name: "create_issue",
    description: "make an issue",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
    },
  },
  { name: "list_repos" },
];

function scriptedServer() {
  return fakeTransport((method) => {
    if (method === "initialize") return { serverInfo: { name: "github" } };
    if (method === "tools/list") return { tools: TOOLS };
    if (method === "tools/call") return { content: [{ type: "text", text: "done" }] };
    return {};
  });
}

describe("connectServer (fake transport)", () => {
  it("runs initialize → tools/list and registers one spec per tool", async () => {
    const t = scriptedServer();
    const registered: ToolDefinitionSpec[] = [];

    const { client, tools, specs } = await connectServer("github", t, (spec) =>
      registered.push(spec),
    );

    // Handshake order: initialize first, then tools/list.
    expect(t.calls.map((c) => c.method)).toEqual(["initialize", "tools/list"]);
    expect(t.notes).toContain("notifications/initialized");
    expect(client.isInitialized).toBe(true);

    // One tool spec registered per discovered tool, flattened + labelled.
    expect(tools).toHaveLength(2);
    expect(registered).toHaveLength(2);
    expect(registered.map((s) => s.name)).toEqual([
      "mcp__github__create_issue",
      "mcp__github__list_repos",
    ]);
    expect(registered[0].label).toBe("github:create_issue");
    expect(registered[0].description).toBe("make an issue");
    // Placeholder description when the server omits one.
    expect(registered[1].description).toContain("list_repos");
    // Schema conversion happened (required title stays required).
    expect((registered[0].parameters as { required?: string[] }).required).toEqual(["title"]);
    // specs returned mirror what was registered.
    expect(specs).toEqual(registered);
  });

  it("forwards tools/call through the returned client using the original tool name", async () => {
    const t = scriptedServer();
    const { client, specs } = await connectServer("github", t, () => {});

    const spec = specs[0];
    const res = await client.callTool(spec.toolName, { title: "hi" });

    const callFrame = t.calls.find((c) => c.method === "tools/call");
    expect(callFrame?.params).toEqual({ name: "create_issue", arguments: { title: "hi" } });
    expect(res.content).toEqual([{ type: "text", text: "done" }]);
    expect(res.isError).toBe(false);
  });

  it("registers nothing when the server exposes no tools", async () => {
    const t = fakeTransport((m) => (m === "tools/list" ? { tools: [] } : {}));
    const registered: ToolDefinitionSpec[] = [];
    const { specs } = await connectServer("empty", t, (s) => registered.push(s));
    expect(specs).toEqual([]);
    expect(registered).toEqual([]);
  });
});
