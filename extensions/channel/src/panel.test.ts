import { ChannelPanel, type ChannelPanelDeps, type ChannelPanelTheme } from "./panel.js";
import { createChannelDefinition } from "./store.js";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { PiPanelRow } from "./piPanel.js";

const theme: ChannelPanelTheme = {
  fg: (_color, text) => text,
  bold: (text) => text,
  inverse: (text) => text,
};

function buildDeps(): { deps: ChannelPanelDeps; setMounted: ReturnType<typeof vi.fn>; restart: ReturnType<typeof vi.fn> } {
  const channel = createChannelDefinition({
    name: "研发微信",
    protocol: "wechat",
    direction: "both",
    scope: "selected",
    sessionId: "session-a",
  });
  const setMounted = vi.fn(async () => undefined);
  const restart = vi.fn(async () => undefined);
  return {
    deps: {
      sessionId: "session-a",
      sessionName: "发布会话",
      listChannels: () => [{
        channel,
        authActionLabel: "扫码登录",
        runtime: {
          id: channel.id,
          name: channel.name,
          protocol: channel.protocol,
          direction: channel.direction,
          scope: channel.scope.kind,
          mounted: true,
          enabled: true,
          status: "connected",
        },
      }],
      saveChannel: async () => undefined,
      removeChannel: async () => undefined,
      restartChannel: restart,
      setMounted,
    },
    setMounted,
    restart,
  };
}

describe("Channel TUI panel", () => {
  it("shows protocol, direction, scope, mount, session name and runtime status clearly", () => {
    const { deps } = buildDeps();
    const panel = new ChannelPanel(theme, deps, vi.fn());
    const text = panel.render(120).join("\n");

    expect(text).toContain("发布会话");
    expect(text).toContain("研发微信");
    expect(text).toContain("wechat");
    expect(text).toContain("双向");
    expect(text).toContain("多会话");
    expect(text).toContain("[mounted]");
    expect(text).toContain("connected");
    expect(panel.handleInput("\r")).toBeUndefined();
    expect(panel.render(120).join("\n")).toContain("Auto-trigger Pi: yes");
  });

  it("opens the generic auth target selector when the selected protocol has no auth adapter", () => {
    const http = createChannelDefinition({
      name: "legacy",
      protocol: "http",
      direction: "inbound",
      scope: "selected",
      sessionId: "session-a",
      http: { token: "secret" },
    });
    const done = vi.fn();
    const panel = new ChannelPanel(theme, {
      ...buildDeps().deps,
      listChannels: () => [{ channel: http }],
    }, done);

    panel.handleInput("l");
    expect(panel.requestedAuthTarget).toBe("__select__");
    expect(done).toHaveBeenCalled();
  });

  it("edits direction as a current-session override without changing the Channel default", async () => {
    const channel = createChannelDefinition({
      name: "共享微信",
      protocol: "wechat",
      direction: "both",
      scope: "selected",
      sessionId: "session-a",
    });
    channel.scope.sessionIds.push("session-b");
    channel.sessionDirections = { "session-a": "both", "session-b": "outbound" };
    const saveChannel = vi.fn(async () => undefined);
    const panel = new ChannelPanel(theme, {
      ...buildDeps().deps,
      listChannels: () => [{ channel }],
      saveChannel,
    }, vi.fn());

    panel.handleInput("\r");
    panel.handleInput("e");
    panel.handleInput("\u001b[B");
    panel.handleInput("\u001b[B");
    panel.handleInput("\u001b[C");
    for (let index = 0; index < 4; index += 1) panel.handleInput("\u001b[B");
    panel.handleInput("\r");
    await panel.lastOp;

    expect(saveChannel).toHaveBeenCalledWith(expect.objectContaining({
      direction: "both",
      sessionDirections: {
        "session-a": "inbound",
        "session-b": "outbound",
      },
      scope: { kind: "selected", sessionIds: ["session-a", "session-b"] },
    }));
  });

  it("mounts/unmounts selected-scope channels and exposes adapter-defined auth from details", async () => {
    const { deps, setMounted } = buildDeps();
    const done = vi.fn();
    const panel = new ChannelPanel(theme, deps, done);

    panel.handleInput("m");
    await panel.lastOp;
    expect(setMounted).toHaveBeenCalledWith(expect.any(String), false);

    panel.handleInput("\r");
    panel.handleInput("l");
    expect(panel.requestedAuthTarget).toBeTruthy();
    expect(done).toHaveBeenCalled();
  });
});

describe("MCP Channel TUI configuration", () => {
  it("appends MCP to the type picker without changing Pi creation indices and generates a private listener token", async () => {
    const saveChannel = vi.fn(async (_channel: unknown) => undefined);
    const panel = new ChannelPanel(theme, {
      ...buildDeps().deps, listChannels: () => [], listPiChannels: () => [], saveChannel,
    }, vi.fn());
    panel.handleInput("a");
    expect(panel.render(120).join("\n")).toContain("MCP 服务");
    for (let index = 0; index < 4; index += 1) panel.handleInput("\u001b[B");
    panel.handleInput("\r");
    expect(panel.snapshot().form?.protocol).toBe("mcp");
    const formText = panel.render(120).join("\n");
    expect(formText).toContain("MCP token");
    expect(formText).toContain("Bind host");
    expect(formText).not.toContain("Callback");
    for (const character of "dot-mcp") panel.handleInput(character);
    for (let index = 0; index < 10; index += 1) panel.handleInput("\u001b[B");
    panel.handleInput("\r");
    await panel.lastOp;
    expect(saveChannel).toHaveBeenCalledWith(expect.objectContaining({
      protocol: "mcp", name: "dot-mcp", scope: { kind: "selected", sessionIds: ["session-a"] },
      mcp: expect.objectContaining({ host: "127.0.0.1", port: 0, token: expect.stringMatching(/^[0-9a-f]{64}$/) }),
    }));
    expect(panel.snapshot().status).toContain("仅本次显示");
    const generated = saveChannel.mock.calls[0]![0] as any;
    const tokenLines = panel.render(40).filter((line) => /│ [0-9a-f]+\s*│/.test(line));
    expect(tokenLines.map((line) => line.replace(/[^0-9a-f]/g, "")).join("")).toBe(generated.mcp.token);
    panel.handleInput("\u001b");
    expect(panel.render(120).join("\n")).not.toContain(generated.mcp.token);
    expect(panel.requestedPiAction).toBeUndefined();
  });

  it("can disable MCP authentication without generating or displaying a token", async () => {
    const saveChannel = vi.fn(async (_channel: unknown) => undefined);
    const panel = new ChannelPanel(theme, { ...buildDeps().deps, listChannels: () => [], listPiChannels: () => [], saveChannel }, vi.fn());
    panel.handleInput("a");
    for (let index = 0; index < 4; index++) panel.handleInput("\u001b[B");
    panel.handleInput("\r");
    for (const character of "no-auth") panel.handleInput(character);
    for (let index = 0; index < 8; index++) panel.handleInput("\u001b[B");
    panel.handleInput("\u001b[C");
    expect(panel.snapshot().form?.mcpAuth).toBe("none");
    expect(panel.render(160).join("\n")).not.toContain("MCP token");
    expect(panel.snapshot().status).toContain("鉴权已关闭");
    panel.handleInput("\u001b[B"); panel.handleInput("\r");
    await panel.lastOp;
    expect(saveChannel).toHaveBeenCalledWith(expect.objectContaining({ mcp: expect.objectContaining({ auth: "none", token: "" }) }));
    expect(panel.render(160).join("\n")).not.toContain("MCP Bearer token");
    expect(panel.snapshot().status).toContain("鉴权已关闭");
  });

  it("uses a supported Pi theme color when switching the form protocol to MCP", () => {
    const strictTheme = { ...theme, fg: (color: string, text: string) => {
      if (color === "info") throw new Error("info is not a Pi ThemeColor");
      return text;
    } };
    const panel = new ChannelPanel(strictTheme, { ...buildDeps().deps, listChannels: () => [] }, vi.fn());
    panel.handleInput("a");
    panel.handleInput("\u001b[B");
    panel.handleInput("\u001b[C"); panel.handleInput("\u001b[C");
    expect(panel.snapshot().form?.protocol).toBe("mcp");
    expect(() => panel.render(100)).not.toThrow();
  });

  it("keeps MCP scope explicitly selected when the user tries all sessions", () => {
    const panel = new ChannelPanel(theme, {
      ...buildDeps().deps, listChannels: () => [], listPiChannels: () => [],
    }, vi.fn());
    panel.handleInput("a");
    for (let index = 0; index < 4; index += 1) panel.handleInput("\u001b[B");
    panel.handleInput("\r");
    for (let index = 0; index < 3; index += 1) panel.handleInput("\u001b[B");
    panel.handleInput("\u001b[C");
    expect(panel.snapshot().form?.scope).toBe("selected");
    expect(panel.snapshot().status).toContain("MCP 不支持全部会话");
  });

  it("shows a masked MCP endpoint and preserves transport limits while editing the local direction", async () => {
    const channel = createChannelDefinition({
      name: "dot-mcp", protocol: "mcp", direction: "both", scope: "selected", sessionId: "session-a",
      mcp: { token: "private-mcp-token", host: "127.0.0.1", port: 4321, maxBodyBytes: 8192, rateLimitPerMinute: 12, idempotencyTtlMs: 12345 },
    });
    channel.scope.sessionIds.push("session-b");
    channel.sessionDirections = { "session-a": "both", "session-b": "outbound" };
    const saveChannel = vi.fn(async () => undefined);
    const panel = new ChannelPanel(theme, {
      ...buildDeps().deps, listChannels: () => [{ channel }], saveChannel,
    }, vi.fn());
    panel.handleInput("\r");
    const details = panel.render(160).join("\n");
    expect(details).toContain("http://127.0.0.1:4321/mcp");
    expect(details).toContain("token ***");
    expect(details).not.toContain("private-mcp-token");
    expect(details).not.toContain("Credentials:");
    panel.handleInput("e");
    expect(panel.snapshot().form).toMatchObject({ host: "127.0.0.1", port: "4321", token: "private-mcp-token" });
    panel.handleInput("\u001b[B"); panel.handleInput("\u001b[B"); panel.handleInput("\u001b[C");
    for (let index = 0; index < 8; index += 1) panel.handleInput("\u001b[B");
    panel.handleInput("\r");
    await panel.lastOp;
    expect(saveChannel).toHaveBeenCalledWith(expect.objectContaining({
      mcp: channel.mcp, direction: "both", scope: channel.scope,
      sessionDirections: { "session-a": "inbound", "session-b": "outbound" },
    }));
  });
});

describe("dots Channel TUI configuration", () => {
  function addDots(saveChannel = vi.fn(async (_channel: unknown) => undefined)): ChannelPanel {
    const panel = new ChannelPanel(theme, {
      ...buildDeps().deps, listChannels: () => [], listPiChannels: () => [], saveChannel,
    }, vi.fn());
    panel.handleInput("a");
    expect(panel.render(120).join("\n")).toContain("dots Channel");
    for (let index = 0; index < 5; index++) panel.handleInput("\u001b[B");
    panel.handleInput("\r");
    return panel;
  }

  it("appends a dots picker entry with session-only defaults and generates a masked Bearer listener", async () => {
    const saveChannel = vi.fn(async (_channel: unknown) => undefined);
    const panel = addDots(saveChannel);
    expect(panel.snapshot().form).toMatchObject({
      name: "我的 dots", protocol: "dots", direction: "both", scope: "selected", delivery: "followUp", wake: true,
      host: "127.0.0.1", port: "0", mcpAuth: "bearer",
    });
    const formText = panel.render(160).join("\n");
    expect(formText).toContain("MCP token");
    expect(formText).not.toContain("Callback");
    for (let index = 0; index < 10; index++) panel.handleInput("\u001b[B");
    panel.handleInput("\r");
    await panel.lastOp;
    expect(saveChannel).toHaveBeenCalledWith(expect.objectContaining({
      protocol: "dots", name: "我的 dots", delivery: "followUp", wake: true,
      scope: { kind: "selected", sessionIds: ["session-a"] },
      dots: expect.objectContaining({ auth: "bearer", token: expect.stringMatching(/^[0-9a-f]{64}$/) }),
    }));
    expect(saveChannel.mock.calls[0]![0]).not.toHaveProperty("mcp");
    expect(panel.requestedPiAction).toBeUndefined();
  });

  it("keeps dots explicitly selected and permits auth none only with an Events warning", async () => {
    const saveChannel = vi.fn(async (_channel: unknown) => undefined);
    const panel = addDots(saveChannel);
    for (let index = 0; index < 3; index++) panel.handleInput("\u001b[B");
    panel.handleInput("\u001b[C");
    expect(panel.snapshot().form?.scope).toBe("selected");
    expect(panel.snapshot().status).toContain("dots 不支持全部会话");
    for (let index = 0; index < 5; index++) panel.handleInput("\u001b[B");
    panel.handleInput("\u001b[C");
    expect(panel.snapshot().form?.mcpAuth).toBe("none");
    expect(panel.snapshot().status).toMatch(/事件订阅.*(开放|可达)/);
    panel.handleInput("\u001b[B"); panel.handleInput("\r");
    await panel.lastOp;
    expect(saveChannel).toHaveBeenCalledWith(expect.objectContaining({ dots: expect.objectContaining({ auth: "none", token: "" }) }));
    expect(panel.snapshot().status).toMatch(/事件订阅.*(开放|可达)/);
  });

  it("preserves dots retry limits and other sessions when editing, and explains remote/read boundaries", async () => {
    const channel = createChannelDefinition({
      name: "dot-events", protocol: "dots", direction: "both", scope: "selected", sessionId: "session-a",
      dots: { token: "private-dots-token", host: "127.0.0.1", port: 4321, maxBodyBytes: 8192,
        rateLimitPerMinute: 12, idempotencyTtlMs: 12345, subscriptionTtlMs: 60000, retryIntervalMs: 2000, maxAttempts: 4 },
    });
    channel.scope.sessionIds.push("session-b");
    channel.sessionDirections = { "session-a": "both", "session-b": "outbound" };
    const saveChannel = vi.fn(async () => undefined);
    const panel = new ChannelPanel(theme, {
      ...buildDeps().deps, listChannels: () => [{ channel }], saveChannel,
    }, vi.fn());
    panel.handleInput("\r");
    const details = panel.render(220).join("\n");
    expect(details).toContain("http://127.0.0.1:4321/mcp");
    expect(details).toContain("MCP 2.0 Events");
    expect(details).toContain("default Bearer");
    expect(details).toContain("separately configured HTTPS");
    expect(details).toContain("do not prove the client read");
    expect(details).not.toContain("private-dots-token");
    expect(details).not.toContain("Credentials:");
    panel.handleInput("e");
    expect(panel.snapshot().form).toMatchObject({ host: "127.0.0.1", port: "4321", token: "private-dots-token" });
    panel.handleInput("\u001b[B"); panel.handleInput("\u001b[B"); panel.handleInput("\u001b[C");
    for (let index = 0; index < 8; index++) panel.handleInput("\u001b[B");
    panel.handleInput("\r");
    await panel.lastOp;
    expect(saveChannel).toHaveBeenCalledWith(expect.objectContaining({
      dots: channel.dots, direction: "both", scope: channel.scope,
      sessionDirections: { "session-a": "inbound", "session-b": "outbound" },
    }));
  });

  it("can cycle a plain add form to dots without introducing unsupported colors or all scope", () => {
    const panel = new ChannelPanel(theme, { ...buildDeps().deps, listChannels: () => [] }, vi.fn());
    panel.handleInput("a"); panel.handleInput("\u001b[B"); panel.handleInput("\u001b[D");
    expect(panel.snapshot().form).toMatchObject({ protocol: "dots", name: "我的 dots", scope: "selected", delivery: "followUp" });
    expect(() => panel.render(100)).not.toThrow();
  });

  it.each([1, 2, 12, 24, 48, 80])("keeps dots picker and form within %s terminal columns", (width) => {
    const panel = addDots();
    for (const line of panel.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    panel.handleInput("\u001b"); panel.handleInput("a");
    for (const line of panel.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  });
});

function piRow(): PiPanelRow {
  return { id: "pi1", name: "项目协作", protocol: "pi", mode: "group", status: "connected", ownerMemberId: "owner", selfMemberId: "self", revision: 1,
    members: [{ memberId: "owner", instanceId: "i", sessionId: "s", cwd: "/repo", identity: { displayName: "界面负责人", introduction: "私有介绍" } }],
  };
}

describe("Pi Channel TUI integration", () => {
  it("requests direct/group creation only after type selection", () => {
    const done = vi.fn();
    const panel = new ChannelPanel(theme, { ...buildDeps().deps, listPiChannels: () => [] }, done);
    panel.handleInput("a");
    expect(panel.snapshot().view.kind).toBe("add-type");
    panel.handleInput("\x1b[B"); panel.handleInput("\x1b[B"); panel.handleInput("\r");
    expect(panel.requestedPiAction).toEqual({ action: "create", mode: "direct" });
    expect(done).toHaveBeenCalledOnce();
  });
  it("opens pair-join outside overlay and cancellation leaves state intact", () => {
    const deps = buildDeps();
    const done = vi.fn();
    const panel = new ChannelPanel(theme, { ...deps.deps, listPiChannels: () => [] }, done);
    panel.handleInput("a"); panel.handleInput("\x1b");
    expect(panel.snapshot().view.kind).toBe("list");
    expect(done).not.toHaveBeenCalled();
    panel.handleInput("j");
    expect(panel.requestedPiAction).toEqual({ action: "join" });
    expect(deps.restart).not.toHaveBeenCalled();
  });
  it("displays Pi type/owner/count/state without credentials and delegates details", () => {
    const row = piRow();
    const deps = buildDeps();
    const done = vi.fn();
    const panel = new ChannelPanel(theme, { ...deps.deps, listChannels: () => [], listPiChannels: () => [row] }, done);
    const text = panel.render(140).join("\n");
    expect(text).toContain("pi 群"); expect(text).toContain("1人");
    expect(text).toContain("创建者:界面负责人"); expect(text).toContain("connected");
    expect(text).not.toContain("私有介绍");
    for (const key of ["r", "m", "x", " ", "l"]) panel.handleInput(key);
    expect(deps.restart).not.toHaveBeenCalled();
    panel.handleInput("\r");
    expect(panel.requestedPiAction).toEqual({ action: "details", channel: "pi1" });
    expect(done).toHaveBeenCalledOnce();
  });
  it("refreshes live status without restarting channels and sanitizes peer labels", () => {
    const row = piRow();
    const deps = buildDeps();
    const panel = new ChannelPanel(theme, { ...deps.deps, listChannels: () => [], listPiChannels: () => [row] }, vi.fn());
    const requestRender = vi.fn(); panel.requestRender = requestRender;
    row.status = "closed"; row.name = "协作\x1b[31m";
    panel.refresh();
    const text = panel.render(120).join("\n");
    expect(text).toContain("closed"); expect(text).not.toContain("\x1b");
    expect(requestRender).toHaveBeenCalled(); expect(deps.restart).not.toHaveBeenCalled();
  });
  it.each([1, 2, 12, 24, 48, 80])("fits every line into a %s-column terminal", (width) => {
    const panel = new ChannelPanel(theme, { ...buildDeps().deps, listPiChannels: () => [piRow()] }, vi.fn());
    for (const key of ["", "a", "\x1b", "\r"]) {
      if (key) panel.handleInput(key);
      for (const line of panel.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });
  it("re-renders using the current theme rather than cached colored labels", () => {
    let prefix = "A";
    const liveTheme = { ...theme, fg: (_c: string, text: string) => prefix + text };
    const panel = new ChannelPanel(liveTheme, { ...buildDeps().deps, listPiChannels: () => [piRow()] }, vi.fn());
    expect(panel.render(100)[0]).toContain("A"); prefix = "B"; panel.invalidate();
    expect(panel.render(100)[0]).toContain("B");
  });
});
