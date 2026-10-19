import { Value } from "typebox/value";
import { PiChannelManageParams, registerPiChannelTools } from "./piTools.js";
import { PiChannelRuntime } from "./piRuntime.js";

function tool(getRuntime: () => PiChannelRuntime | undefined) {
  let registered: any;
  registerPiChannelTools({ registerTool: (value: any) => { registered = value; } } as never, getRuntime);
  return registered;
}

const identity = { displayName: "后端", introduction: "负责服务端接口" };

describe("channel_manage tool", () => {
  it("registers a sequential UI-independent tool with self-rendered shell", async () => {
    const manage = vi.fn(async () => ({ channels: [] }));
    const entry = tool(() => ({ manage } as unknown as PiChannelRuntime));
    expect(entry.name).toBe("channel_manage");
    expect(entry.renderShell).toBe("self");
    expect(entry.executionMode).toBe("sequential");
    expect(entry.parameters.type).toBe("object");
    const result = await entry.execute("t", { action: "list" }, undefined, undefined, { hasUI: false });
    expect(result.details).toEqual({ action: "list", result: { channels: [] } });
    expect(manage).toHaveBeenCalledWith({ action: "list" });
    expect(entry.promptGuidelines.join(" ")).toContain("plan mode");
  });

  it("defines each management action and rejects wrong fields in discriminated parameters", () => {
    const valid = [
      { action: "create", name: "协作", mode: "group", identity },
      { action: "create", protocol: "pi", name: "协作", mode: "direct", identity },
      { action: "create", protocol: "http", name: "dot", http: { callbackUrl: "https://example.com" } },
      { action: "create", protocol: "wechat", name: "wx" },
      { action: "create", protocol: "dots", name: "dot", dots: { auth: "none", subscriptionTtlMs: 60_000, retryIntervalMs: 100, maxAttempts: 3 } },
      { action: "update", channel: "dot", dots: { token: "new" } },
      { action: "create", protocol: "mcp", name: "session", mcp: { host: "127.0.0.1", port: 0 } },
      { action: "update", channel: "session", mcp: { token: "new-token" } },
      { action: "create", protocol: "mcp", name: "no-auth", mcp: { auth: "none" } },
      { action: "update", channel: "dot", direction: "inbound" },
      { action: "restart" }, { action: "restart", channel: "dot" },
      { action: "delete", channel: "dot", confirm: true },
      ...["status", "auth", "mount", "unmount", "enable", "disable"].map((action) => ({ action, channel: "dot" })),
      { action: "join", pairing_code: "code", identity, local_name: "alias" },
      { action: "list" }, { action: "members", channel: "room" },
      { action: "update_identity", channel: "room", identity },
      { action: "leave", channel: "room" }, { action: "destroy", channel: "room", confirm: true },
      ...["show", "rotate", "revoke"].map((operation) => ({ action: "pairing", channel: "room", operation })),
    ];
    for (const input of valid) expect(Value.Check(PiChannelManageParams, input)).toBe(true);
    for (const input of [
      { action: "create", name: "room", mode: "group" },
      { action: "create", protocol: "http", name: "dot", identity },
      { action: "create", protocol: "smtp", name: "dot" },
      { action: "create", protocol: "mcp", name: "session", mcp: { callbackUrl: "https://example.com" } },
      { action: "create", protocol: "mcp", name: "session", mcp: { auth: "invalid" } },
      { action: "create", protocol: "dots", name: "dot", dots: { callbackUrl: "https://example.com" } },
      { action: "create", protocol: "dots", name: "dot", dots: { maxAttempts: 21 } },
      { action: "delete", channel: "dot", confirm: false },
      { action: "update", channel: "dot", scope: "all" },
      { action: "join", pairing_code: "code", identity: { displayName: "x" } },
      { action: "destroy", channel: "room" },
      { action: "update_identity", channel: "room", identity, memberId: "other" },
      { action: "pairing", channel: "room", operation: "hack" },
    ]) expect(Value.Check(PiChannelManageParams, input)).toBe(false);
  });

  it("throws meaningful failures rather than returning successful-looking errors", async () => {
    await expect(tool(() => undefined).execute("t", { action: "list" })).rejects.toThrow("No active Pi session");
    const manage = vi.fn(async () => { throw new Error("Only the creator can destroy"); });
    await expect(tool(() => ({ manage } as unknown as PiChannelRuntime)).execute("t", { action: "destroy", channel: "room", confirm: true })).rejects.toThrow("Only the creator");
    const signal = new AbortController(); signal.abort();
    await expect(tool(() => ({ manage } as unknown as PiChannelRuntime)).execute("t", { action: "list" }, signal.signal)).rejects.toThrow("cancelled");
    expect(manage).toHaveBeenCalledOnce();
    await expect(tool(() => ({ manage } as unknown as PiChannelRuntime)).execute("t", { action: "destroy", channel: "room" })).rejects.toThrow("Invalid channel_manage parameters");
    expect(manage).toHaveBeenCalledOnce();
  });

  it("uses runtime disabled enforcement even in non-interactive mode", async () => {
    const runtime = new PiChannelRuntime({
      session: { id: "s", name: "s", cwd: "/repo" }, enabled: () => false, externalNames: () => [],
      onChange: vi.fn(), onMessage: vi.fn(),
    });
    const entry = tool(() => runtime);
    await expect(entry.execute("t", { action: "create", name: "room", mode: "direct", identity })).rejects.toThrow("disabled");
    await runtime.close();
  });
});
