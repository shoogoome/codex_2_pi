import sessionSummaryExtension, { _setSummaryRunnerForTest } from "./index.js";
import type { GlobalSummaryConfig, GlobalSummaryConfigUpdate } from "./src/global-config.js";
import { SUMMARY_CUSTOM_ENTRY } from "./src/types.js";

function boot(options: {
  globalModelRef?: string;
  globalVisibleRows?: number;
  globalContextTurns?: number;
  branch?: any[];
} = {}) {
  const handlers = new Map<string, Function[]>();
  const commands = new Map<string, any>();
  const shortcuts = new Map<string, any>();
  const flags = new Map<string, boolean | string | undefined>();
  const appended: Array<{ customType: string; data: any }> = [];
  const setWidget = vi.fn();
  const requestRender = vi.fn();
  let globalConfig: GlobalSummaryConfig = {
    version: 1,
    ...(options.globalModelRef ? { modelRef: options.globalModelRef } : {}),
    ...(options.globalVisibleRows !== undefined ? { visibleRows: options.globalVisibleRows } : {}),
    ...(options.globalContextTurns !== undefined ? { contextTurns: options.globalContextTurns } : {}),
  };
  const loadGlobalConfig = vi.fn(async () => globalConfig);
  const saveGlobalConfig = vi.fn(async (_agentDir: string, update: GlobalSummaryConfigUpdate) => {
    globalConfig = {
      version: 1,
      ...(update.modelRef === undefined
        ? (globalConfig.modelRef ? { modelRef: globalConfig.modelRef } : {})
        : (update.modelRef ? { modelRef: update.modelRef } : {})),
      ...(update.visibleRows === undefined
        ? (globalConfig.visibleRows !== undefined ? { visibleRows: globalConfig.visibleRows } : {})
        : (update.visibleRows !== null ? { visibleRows: update.visibleRows } : {})),
      ...(update.contextTurns === undefined
        ? (globalConfig.contextTurns !== undefined ? { contextTurns: globalConfig.contextTurns } : {})
        : (update.contextTurns !== null ? { contextTurns: update.contextTurns } : {})),
    };
    return globalConfig;
  });
  const models = [
    { provider: "main", id: "large", name: "Large", maxTokens: 4096 },
    { provider: "small", id: "mini", name: "Mini", maxTokens: 1024 },
  ];
  const pi: any = {
    registerFlag: vi.fn((name: string, options: { default?: boolean | string }) => flags.set(name, options.default)),
    getFlag: vi.fn((name: string) => flags.get(name)),
    on: vi.fn((event: string, handler: Function) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    }),
    registerCommand: vi.fn((name: string, command: any) => commands.set(name, command)),
    registerShortcut: vi.fn((key: string, shortcut: any) => shortcuts.set(key, shortcut)),
    appendEntry: vi.fn((customType: string, data: any) => appended.push({ customType, data })),
  };
  const ctx: any = {
    hasUI: true,
    model: models[0],
    sessionManager: { getBranch: () => options.branch ?? [] },
    modelRegistry: {
      getAvailable: () => models,
      getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "test" })),
    },
    ui: {
      setWidget,
      notify: vi.fn(),
      select: vi.fn(),
    },
  };
  sessionSummaryExtension(pi, {
    agentDir: "/tmp/pi-session-summary-test",
    loadGlobalConfig,
    saveGlobalConfig,
  });
  return {
    pi,
    ctx,
    handlers,
    commands,
    shortcuts,
    flags,
    appended,
    setWidget,
    requestRender,
    models,
    loadGlobalConfig,
    saveGlobalConfig,
    getGlobalConfig: () => globalConfig,
  };
}

function handler(handlers: Map<string, Function[]>, event: string): Function {
  const value = handlers.get(event)?.[0];
  if (!value) throw new Error(`missing ${event} handler`);
  return value;
}

afterEach(() => {
  _setSummaryRunnerForTest();
});

describe("session summary extension", () => {
  it("registers a permanent above-editor widget and one user/agent row per run", async () => {
    _setSummaryRunnerForTest(async ({ role }) => `${role}-summary`);
    const { ctx, handlers, appended, setWidget, shortcuts } = boot();
    await handler(handlers, "session_start")({ type: "session_start", reason: "startup" }, ctx);

    expect([...shortcuts.keys()]).toEqual(["alt+up", "alt+down"]);
    expect(setWidget).toHaveBeenCalledWith("session-summary-thread", expect.any(Function), { placement: "aboveEditor" });
    const factory = setWidget.mock.calls[0][1];
    const component = factory({ requestRender: vi.fn() }, { fg: (_c: string, text: string) => text, bold: (text: string) => text });
    expect(component.render(80)[0]).toContain("summary");
    expect(component.render(80)[0]).not.toContain("会话脉络");
    expect(component.render(80)[1]).toContain("等待首轮");

    const inputResult = handler(handlers, "input")(
      { type: "input", text: "请实现常驻摘要", source: "interactive" },
      ctx,
    );
    expect(inputResult).toEqual({ action: "continue" });

    const agentResult = handler(handlers, "agent_end")({
      type: "agent_end",
      messages: [
        { role: "user", content: [{ type: "text", text: "请实现常驻摘要" }] },
        { role: "assistant", content: [{ type: "text", text: "已经实现" }] },
      ],
    }, ctx);
    expect(agentResult).toBeUndefined();

    await vi.waitFor(() => {
      const summaries = appended
        .filter((item) => item.customType === SUMMARY_CUSTOM_ENTRY && item.data?.kind === "upsert")
        .map((item) => item.data.entry.summary);
      expect(summaries).toContain("user-summary");
      expect(summaries).toContain("agent-summary");
    });

    const rendered = component.render(100).join("\n");
    expect(rendered).toContain("你");
    expect(rendered).toContain("user-summary");
    expect(rendered).toContain("AI");
    expect(rendered).toContain("agent-summary");
  });

  it("ignores slash commands and extension-generated input as user speech", async () => {
    const { ctx, handlers, appended } = boot();
    await handler(handlers, "session_start")({ type: "session_start", reason: "startup" }, ctx);
    handler(handlers, "input")({ type: "input", text: "/cost", source: "interactive" }, ctx);
    handler(handlers, "input")({ type: "input", text: "autopilot", source: "extension" }, ctx);
    expect(appended.filter((item) => item.data?.kind === "upsert")).toHaveLength(0);
  });

  it("includes the configured recent turns when summarizing a user message", async () => {
    const runner = vi.fn(async () => "结合上下文的摘要");
    _setSummaryRunnerForTest(runner);
    const branch = [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "旧需求" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "旧需求已完成" }] } },
      { type: "message", message: { role: "user", content: [{ type: "text", text: "把标题改成 summary" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "标题已经修改" }] } },
    ];
    const { ctx, handlers } = boot({ globalContextTurns: 1, branch });
    await handler(handlers, "session_start")({ type: "session_start", reason: "startup" }, ctx);

    handler(handlers, "input")({ type: "input", text: "然后把它改成灰色", source: "interactive" }, ctx);

    await vi.waitFor(() => expect(runner).toHaveBeenCalled());
    const source = (runner.mock.calls as any)[0][0].source as string;
    expect(source).toContain("把标题改成 summary");
    expect(source).toContain("标题已经修改");
    expect(source).toContain("当前用户消息：\n然后把它改成灰色");
    expect(source).not.toContain("旧需求已完成");
  });

  it("uses a separately selected model without changing the main session model", async () => {
    const runner = vi.fn(async () => "小模型摘要");
    _setSummaryRunnerForTest(runner);
    const { ctx, handlers, commands, pi, models } = boot();
    await handler(handlers, "session_start")({ type: "session_start", reason: "startup" }, ctx);

    await commands.get("session-summary").handler("model session small/mini", ctx);
    handler(handlers, "input")({ type: "input", text: "新的用户需求", source: "rpc" }, ctx);

    await vi.waitFor(() => expect(runner).toHaveBeenCalled());
    expect((runner.mock.calls as any)[0][0].model).toBe(models[1]);
    expect(pi.setModel).toBeUndefined();
  });

  it("persists a global model and reuses it in a new session without per-session setup", async () => {
    const runner = vi.fn(async () => "全局小模型摘要");
    _setSummaryRunnerForTest(runner);
    const {
      ctx,
      handlers,
      commands,
      models,
      saveGlobalConfig,
      getGlobalConfig,
    } = boot();
    await handler(handlers, "session_start")({ type: "session_start", reason: "startup" }, ctx);

    // Omitting the scope intentionally writes the global default; per-session
    // overrides require the explicit `model session ...` form.
    await commands.get("session-summary").handler("model small/mini", ctx);
    expect(saveGlobalConfig).toHaveBeenCalledWith(
      "/tmp/pi-session-summary-test",
      { modelRef: "small/mini" },
    );
    expect(getGlobalConfig()).toEqual({ version: 1, modelRef: "small/mini" });

    // A fresh session has no session-summary custom entries, yet inherits the
    // globally saved model on restore and on every subsequent summary job.
    await handler(handlers, "session_start")({ type: "session_start", reason: "new" }, ctx);
    handler(handlers, "input")({ type: "input", text: "跨会话继续使用", source: "interactive" }, ctx);

    await vi.waitFor(() => expect(runner).toHaveBeenCalled());
    expect((runner.mock.calls as any)[0][0].model).toBe(models[1]);
  });

  it("persists the global context turn count", async () => {
    const { ctx, handlers, commands, saveGlobalConfig, getGlobalConfig } = boot();
    await handler(handlers, "session_start")({ type: "session_start", reason: "startup" }, ctx);

    await commands.get("session-summary").handler("context 5", ctx);

    expect(saveGlobalConfig).toHaveBeenCalledWith(
      "/tmp/pi-session-summary-test",
      { contextTurns: 5 },
    );
    expect(getGlobalConfig()).toEqual({ version: 1, contextTurns: 5 });
  });

  it("persists the global display row count next to the model setting", async () => {
    const { ctx, handlers, commands, saveGlobalConfig, getGlobalConfig } = boot({
      globalModelRef: "small/mini",
      globalVisibleRows: 6,
    });
    await handler(handlers, "session_start")({ type: "session_start", reason: "startup" }, ctx);

    await commands.get("session-summary").handler("lines 12", ctx);

    expect(saveGlobalConfig).toHaveBeenCalledWith(
      "/tmp/pi-session-summary-test",
      { visibleRows: 12 },
    );
    expect(getGlobalConfig()).toEqual({ version: 1, modelRef: "small/mini", visibleRows: 12 });
  });
});
