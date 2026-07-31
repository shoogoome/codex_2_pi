import { describe, expect, it, vi } from "vitest";
import ultraExtension from "../ultra/index.js";
import { ULTRA_STATE_ENTRY } from "../ultra/core.js";
import effortExtension from "./index.js";

type Model = {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
};

interface HarnessOptions {
  current?: string;
  model?: Model;
  models?: Model[];
  hasUI?: boolean;
  selections?: string[];
}

function codexModel(id = "gpt-5.6-sol"): Model {
  return {
    provider: "openai-codex",
    id,
    name: id === "gpt-5.6-sol" ? "GPT-5.6 Sol" : "GPT-5.6 Terra",
    reasoning: true,
    thinkingLevelMap: { minimal: "low", xhigh: "xhigh", max: "max" },
  };
}

function createHarness(options: HarnessOptions = {}) {
  let current = options.current ?? "medium";
  let model = options.model ?? codexModel();
  let editorText = "";
  let terminalHandler: ((data: string) => { consume?: boolean; data?: string } | undefined) | undefined;
  const commands = new Map<string, any>();
  const shortcuts = new Map<string, any>();
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
  const notifications: Array<{ msg: string; level?: string }> = [];
  const selections = [...(options.selections ?? [])];
  const models = options.models ?? [model];

  const pi: any = {
    events: {},
    registerCommand: vi.fn((name: string, def: any) => commands.set(name, def)),
    registerShortcut: vi.fn((key: string, def: any) => shortcuts.set(key, def)),
    on: vi.fn((event: string, handler: (event: any, ctx: any) => any) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    }),
    appendEntry: vi.fn((customType: string, data: unknown) => {
      entries.push({ type: "custom", customType, data });
    }),
    getActiveTools: vi.fn(() => ["read", "task_agent"]),
    getAllTools: vi.fn(() => [{ name: "read" }, { name: "task_agent" }]),
    getThinkingLevel: vi.fn(() => current),
    setThinkingLevel: vi.fn((level: string) => {
      current = level;
    }),
    setModel: vi.fn(async (next: Model) => {
      model = next;
      return true;
    }),
  };
  const ui: any = {
    notify: vi.fn((msg: string, level?: string) => notifications.push({ msg, level })),
    select: vi.fn(async () => selections.shift()),
    setStatus: vi.fn(),
    setWidget: vi.fn(),
    onTerminalInput: vi.fn((handler: typeof terminalHandler) => {
      terminalHandler = handler;
      return () => {
        if (terminalHandler === handler) terminalHandler = undefined;
      };
    }),
    getEditorText: vi.fn(() => editorText),
    setEditorText: vi.fn((text: string) => {
      editorText = text;
    }),
    theme: {
      fg: vi.fn((_color: string, text: string) => text),
      bold: vi.fn((text: string) => text),
    },
  };
  const ctx: any = {
    hasUI: options.hasUI ?? true,
    get model() {
      return model;
    },
    modelRegistry: { getAvailable: vi.fn(() => models) },
    sessionManager: { getBranch: () => [] },
    ui,
  };

  // Match the real alphabetical load order: effort registers first, Ultra then
  // attaches its controller synchronously on the shared event bus.
  effortExtension(pi);
  ultraExtension(pi);

  return {
    pi,
    ctx,
    commands,
    shortcuts,
    handlers,
    entries,
    notifications,
    ui,
    getCurrent: () => current,
    getModel: () => model,
    setEditorText: (text: string) => {
      editorText = text;
    },
    fireTerminal: (data: string) => terminalHandler?.(data),
  };
}

async function fire(
  handlers: Map<string, Array<(event: any, ctx: any) => any>>,
  event: string,
  payload: any,
  ctx: any,
): Promise<any[]> {
  const results = [];
  for (const handler of handlers.get(event) ?? []) results.push(await handler(payload, ctx));
  return results;
}

async function flushPicker(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("effort extension", () => {
  it("owns only the generic command, shortcuts, and model-picker lifecycle", () => {
    const { commands, shortcuts, handlers } = createHarness();
    expect(commands.has("effort")).toBe(true);
    expect([...shortcuts.keys()]).toEqual(["alt+,", "alt+."]);
    // Ultra owns the other handlers; effort itself adds exactly start/shutdown.
    expect(handlers.get("session_start")).toHaveLength(2);
    expect(handlers.get("session_shutdown")).toHaveLength(2);
  });

  it("reports and applies native levels", async () => {
    const { pi, ctx, commands, notifications, getCurrent } = createHarness({ current: "high" });
    await commands.get("effort").handler("status", ctx);
    expect(notifications[0].msg).toContain("high");

    await commands.get("effort").handler("max", ctx);
    expect(pi.setThinkingLevel).toHaveBeenCalledWith("max");
    expect(getCurrent()).toBe("max");
  });

  it("delegates /effort ultra to the separate Ultra controller", async () => {
    const { ctx, commands, entries, getCurrent } = createHarness();
    await commands.get("effort").handler("ultra", ctx);
    expect(getCurrent()).toBe("max");
    expect(entries.at(-1)).toEqual({
      type: "custom",
      customType: ULTRA_STATE_ENTRY,
      data: { enabled: true, fallbackLevel: "medium" },
    });
  });

  it("keeps Max/Ultra behind the explicit More reasoning picker", async () => {
    const { ctx, commands, entries, ui } = createHarness({
      selections: [
        "More reasoning… — Max and Ultra consume usage limits faster",
        "Ultra — For demanding work using multiple agents · highest usage",
      ],
    });
    await commands.get("effort").handler("", ctx);
    expect(ui.select).toHaveBeenNthCalledWith(1, "Select Reasoning Level for gpt-5.6-sol", expect.any(Array));
    expect(ui.select).toHaveBeenNthCalledWith(
      2,
      "Advanced Reasoning · ⚠ Consumes usage limits faster",
      expect.any(Array),
    );
    expect(entries.at(-1)?.data).toEqual({ enabled: true, fallbackLevel: "medium" });
  });

  it("Alt+, lowers Ultra to Max", async () => {
    const { ctx, commands, shortcuts, getCurrent, entries } = createHarness();
    await commands.get("effort").handler("ultra", ctx);
    await shortcuts.get("alt+,").handler(ctx);
    expect(getCurrent()).toBe("max");
    expect(entries.at(-1)?.data).toEqual({ enabled: false });
  });

  it("Alt+. never silently crosses from Extra high into Max/Ultra", async () => {
    const { ctx, shortcuts, pi, notifications, getCurrent } = createHarness({ current: "xhigh" });
    await shortcuts.get("alt+.").handler(ctx);
    expect(getCurrent()).toBe("xhigh");
    expect(pi.setThinkingLevel).not.toHaveBeenCalled();
    expect(notifications[0].msg).toContain("More reasoning");
  });

  it("intercepts /model and applies model+Ultra atomically", async () => {
    const sol = codexModel("gpt-5.6-sol");
    const terra = codexModel("gpt-5.6-terra");
    const harness = createHarness({
      model: terra,
      models: [sol, terra],
      selections: [
        "openai-codex/gpt-5.6-sol — GPT-5.6 Sol",
        "More reasoning… — Max and Ultra consume usage limits faster",
        "Ultra — For demanding work using multiple agents · highest usage",
      ],
    });
    await fire(harness.handlers, "session_start", { type: "session_start", reason: "new" }, harness.ctx);
    harness.setEditorText("/model sol");
    expect(harness.fireTerminal("\r")).toEqual({ consume: true });
    await flushPicker();

    expect(harness.pi.setModel).toHaveBeenCalledWith(sol);
    expect(harness.getModel()).toBe(sol);
    expect(harness.getCurrent()).toBe("max");
    expect(harness.entries.at(-1)?.data).toEqual({ enabled: true, fallbackLevel: "medium" });
  });

  it("rejects invalid levels and completes status/ultra", async () => {
    const { pi, ctx, commands, notifications } = createHarness();
    await commands.get("effort").handler("turbo", ctx);
    expect(pi.setThinkingLevel).not.toHaveBeenCalled();
    expect(notifications[0].level).toBe("warning");
    expect(commands.get("effort").getArgumentCompletions("st")).toEqual([
      { value: "status", label: "status" },
    ]);
    expect(commands.get("effort").getArgumentCompletions("ul")).toEqual([
      { value: "ultra", label: "ultra" },
    ]);
  });
});
