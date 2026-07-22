import { describe, it, expect, vi } from "vitest";
import { McpClient } from "./client.js";
import type { Transport } from "./types.js";

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

describe("McpClient", () => {
  it("sends initialize with protocol/client/capabilities and the initialized note", async () => {
    const t = fakeTransport(() => ({ serverInfo: { name: "s" } }));
    const client = new McpClient(t);
    await client.initialize();
    expect(t.calls[0].method).toBe("initialize");
    const params = t.calls[0].params as {
      protocolVersion: string;
      clientInfo: { name: string };
      capabilities: unknown;
    };
    expect(params.protocolVersion).toBeTruthy();
    expect(params.clientInfo.name).toBe("pi-mcp");
    expect(params.capabilities).toEqual({});
    expect(t.notes).toContain("notifications/initialized");
    expect(client.isInitialized).toBe(true);
  });

  it("parses tools from tools/list and filters invalid entries", async () => {
    const t = fakeTransport((m) =>
      m === "tools/list"
        ? { tools: [{ name: "a", description: "d" }, { bad: 1 }, null] }
        : {},
    );
    const tools = await new McpClient(t).listTools();
    expect(tools).toEqual([{ name: "a", description: "d" }]);
  });

  it("returns [] when tools/list has no array", async () => {
    const t = fakeTransport(() => ({}));
    expect(await new McpClient(t).listTools()).toEqual([]);
  });

  it("forwards name and arguments on callTool", async () => {
    const responder = vi.fn(() => ({ content: [{ type: "text", text: "ok" }] }));
    const t = fakeTransport(responder);
    const r = await new McpClient(t).callTool("do", { x: 1 });
    expect(t.calls[0].method).toBe("tools/call");
    expect(t.calls[0].params).toEqual({ name: "do", arguments: { x: 1 } });
    expect(r.content).toEqual([{ type: "text", text: "ok" }]);
    expect(r.isError).toBe(false);
  });

  it("defaults arguments to {} and reads isError", async () => {
    const t = fakeTransport(() => ({ content: [], isError: true }));
    const r = await new McpClient(t).callTool("do", undefined);
    expect(t.calls[0].params).toEqual({ name: "do", arguments: {} });
    expect(r.isError).toBe(true);
    expect(r.content).toEqual([]);
  });
});
