import type { ExtensionAPI, ExtensionCommandContext, SessionEntry, Theme } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import extension from "./index.js";
import { ContextPanel } from "./panel.js";
import { buildSections } from "./sections.js";

const hidden = (content: unknown, display = false) => ({
  type: "custom_message", customType: "agents-context", content, display,
}) as SessionEntry;

describe("context sections", () => {
  it("includes system and hidden context but excludes conversation, tools and state", () => {
    const entries = [
      hidden("项目规则"), hidden("可见消息", true),
      hidden([{ type: "text", text: "记忆" }, { type: "image", data: "secret" }]),
      { type: "message", message: { role: "user", content: "聊天" } },
      { type: "message", message: { role: "assistant", content: [] } },
      { type: "message", message: { role: "toolResult", content: [] } },
      { type: "custom", customType: "state", data: "不属于上下文" },
      { type: "compaction", summary: "多轮摘要" },
    ] as SessionEntry[];
    expect(buildSections("系统正文", entries)).toEqual([
      { title: "系统提示词", content: "系统正文" },
      { title: "注入上下文 · agents-context", content: "项目规则" },
      { title: "注入上下文 · agents-context", content: "记忆" },
    ]);
  });

  it("uses active entries across compaction and tree branches", () => {
    const manager = SessionManager.inMemory();
    const old = manager.appendCustomMessageEntry("rules", "旧规则", false);
    const kept = manager.appendMessage({ role: "user", content: "保留对话", timestamp: 1 });
    manager.appendCompaction("历史对话摘要", kept, 100);
    manager.appendCustomMessageEntry("memory", "当前记忆", false);
    expect(buildSections("系统", manager.buildContextEntries()).map((s) => s.content)).toEqual(["系统", "当前记忆"]);
    manager.branch(old);
    expect(buildSections("系统", manager.buildContextEntries()).map((s) => s.content)).toEqual(["系统", "旧规则"]);
  });

  it("supports custom messages stored as message entries and omits empty blocks", () => {
    const entry = { type: "message", message: {
      role: "custom", customType: "memory", content: "回忆正文", display: false,
    } } as SessionEntry;
    expect(buildSections("", [hidden("  "), entry])).toEqual([
      { title: "系统提示词", content: "（当前系统提示词为空）" },
      { title: "注入上下文 · memory", content: "回忆正文" },
    ]);
  });
});

const theme = { fg: (_color: string, text: string) => text } as Theme;

describe("context panel", () => {
  it("scrolls, switches, closes and respects narrow widths", () => {
    const done = vi.fn();
    const panel = new ContextPanel([
      { title: "系统", content: Array.from({ length: 100 }, (_, i) => `line-${i}`).join("\n") },
      { title: "记忆", content: "第二块中文上下文" },
    ], theme, () => 20, vi.fn(), done);
    expect(panel.render(80).join("\n")).toContain("line-0");
    panel.handleInput("j");
    expect(panel.render(80).join("\n")).not.toContain("\nline-0\n");
    panel.handleInput("\t");
    expect(panel.render(80).join("\n")).toContain("第二块中文上下文");
    for (const width of [1, 8, 25, 80]) {
      expect(panel.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
    }
    panel.invalidate();
    panel.handleInput("q");
    expect(done).toHaveBeenCalledOnce();
  });
});

describe("context commands", () => {
  function harness(mode = "tui") {
    const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
    const pi = { registerCommand: vi.fn((name, spec) => commands.set(name, spec)) };
    extension(pi as unknown as ExtensionAPI);
    const ctx = {
      mode, getSystemPrompt: vi.fn(() => "实时系统正文"),
      sessionManager: { buildContextEntries: vi.fn(() => [hidden("有效注入")]) },
      ui: {
        notify: vi.fn(),
        custom: vi.fn(async (factory) => {
          const panel = factory({ terminal: { rows: 24 }, requestRender: vi.fn() }, theme, {}, vi.fn());
          return panel.render(100).join("\n");
        }),
      },
    };
    return { commands, ctx, typed: ctx as unknown as ExtensionCommandContext };
  }

  it("reads fresh session data every time", async () => {
    const h = harness();
    await h.commands.get("context")!.handler("", h.typed);
    expect(h.ctx.sessionManager.buildContextEntries).toHaveBeenCalledOnce();
    h.ctx.getSystemPrompt.mockReturnValue("新会话系统正文");
    await h.commands.get("context")!.handler("", h.typed);
    expect(h.ctx.getSystemPrompt).toHaveBeenCalledTimes(2);
    await expect(h.ctx.ui.custom.mock.results[1].value).resolves.toContain("新会话系统正文");
  });

  it("system-prompt does not read conversation entries", async () => {
    const h = harness();
    await h.commands.get("system-prompt")!.handler("", h.typed);
    expect(h.ctx.sessionManager.buildContextEntries).not.toHaveBeenCalled();
    expect(h.ctx.ui.custom).toHaveBeenCalledOnce();
  });

  it("guards RPC mode", async () => {
    const h = harness("rpc");
    await h.commands.get("context")!.handler("", h.typed);
    expect(h.ctx.ui.custom).not.toHaveBeenCalled();
    expect(h.ctx.ui.notify).toHaveBeenCalledOnce();
  });
});
