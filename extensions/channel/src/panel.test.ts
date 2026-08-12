import { ChannelPanel, type ChannelPanelDeps, type ChannelPanelTheme } from "./panel.js";
import { createChannelDefinition } from "./store.js";

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
