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
