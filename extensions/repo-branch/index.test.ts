import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import repoBranchExtension from "./index.js";
import { REPO_BRANCH_WIDGET_KEY } from "./src/overlay.js";
import { REPO_BRANCH_ENTRY } from "./src/types.js";

function setup(options: {
  cwd?: string;
  hasUI?: boolean;
  sessionId?: string;
  branch?: any[];
  gitResponses?: Record<string, { root: string; branch: string }>;
  argv?: string[];
  flagValue?: boolean;
} = {}) {
  const handlers = new Map<string, Function[]>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const appended: Array<{ customType: string; data: unknown }> = [];
  const widgets = new Map<string, any>();
  const requestRender = vi.fn();
  const notify = vi.fn();

  const setWidget = vi.fn((key: string, factory: any, _opts: any) => {
    if (factory === undefined) {
      widgets.delete(key);
    } else {
      const comp = factory({ requestRender }, { fg: (_c: string, t: string) => t, bold: (t: string) => t });
      widgets.set(key, comp);
    }
  });

  const pi = {
    registerFlag: vi.fn(),
    getFlag: vi.fn(() => options.flagValue ?? true),
    registerTool: vi.fn((def) => tools.set(def.name, def)),
    registerCommand: vi.fn((name, def) => commands.set(name, def)),
    appendEntry: vi.fn((customType, data) => appended.push({ customType, data })),
    on: vi.fn((event, fn) => {
      handlers.set(event, [...(handlers.get(event) ?? []), fn]);
    }),
  };

  const gitResponses = options.gitResponses ?? {
    "/workspace/app": { root: "/workspace/app", branch: "main" },
  };

  const runner = {
    async run(_cmd: string, args: string[], runOpts: { cwd: string }) {
      const hit = Object.entries(gitResponses).find(([prefix]) => runOpts.cwd.startsWith(prefix));
      if (!hit) return { code: 128, stdout: "", stderr: "not a git repo" };
      const [, info] = hit;
      if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return { code: 0, stdout: "true\n", stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return { code: 0, stdout: `${info.root}\n`, stderr: "" };
      if (args[0] === "symbolic-ref") return { code: 0, stdout: `${info.branch}\n`, stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    },
  };

  repoBranchExtension(pi as unknown as ExtensionAPI, {
    createRunner: () => runner,
    argv: options.argv ?? [],
  });

  const branchEntries = options.branch ?? [];
  const ctx = {
    cwd: options.cwd ?? "/workspace/app",
    hasUI: options.hasUI ?? true,
    ui: { setWidget, notify },
    sessionManager: {
      getSessionId: () => options.sessionId ?? "session-1",
      getBranch: () => branchEntries,
    },
  } as unknown as ExtensionContext;

  async function emit(event: string, eventPayload: any = {}, targetCtx: ExtensionContext = ctx) {
    for (const fn of handlers.get(event) ?? []) {
      await fn(eventPayload, targetCtx);
    }
  }

  const tool = tools.get("record_repo_branch");
  const command = commands.get("repo-branch");

  return { pi, tool, command, ctx, appended, widgets, setWidget, requestRender, notify, emit };
}

describe("repo-branch extension", () => {
  it("registers tool and mounts persistent aboveEditor widget on session_start", async () => {
    const { tool, widgets, setWidget, emit } = setup();
    expect(tool.name).toBe("record_repo_branch");
    expect(tool.parameters.additionalProperties).toBe(false);
    expect(tool.promptGuidelines.join("")).toContain("record_repo_branch");

    await emit("session_start", { reason: "startup" });
    expect(setWidget).toHaveBeenCalledWith(REPO_BRANCH_WIDGET_KEY, expect.any(Function), { placement: "aboveEditor" });
    const rendered = widgets.get(REPO_BRANCH_WIDGET_KEY).render(60).join("\n");
    expect(rendered).toContain("仓库分支 · 0");
    expect(rendered).toContain("暂无记录");
  });

  it("records, updates, lists, removes, and clears repositories and updates the widget", async () => {
    const { tool, ctx, widgets, appended, emit } = setup({
      gitResponses: {
        "/workspace/app": { root: "/workspace/app", branch: "main" },
        "/workspace/api": { root: "/workspace/api", branch: "develop" },
      },
    });
    await emit("session_start", { reason: "startup" });

    // Record default cwd + auto-detected branch
    const res1 = await tool.execute("c1", {}, undefined, undefined, ctx);
    expect(res1.details.record).toMatchObject({ name: "app", path: "/workspace/app", branch: "main" });
    expect(appended).toHaveLength(1);
    expect(appended[0]?.customType).toBe(REPO_BRANCH_ENTRY);

    // Record second repo with explicit branch
    const res2 = await tool.execute("c2", { repo: "/workspace/api", branch: "feat/oauth" }, undefined, undefined, ctx);
    expect(res2.details.records).toHaveLength(2);
    const widgetText = widgets.get(REPO_BRANCH_WIDGET_KEY).render(60).join("\n");
    expect(widgetText).toContain("app");
    expect(widgetText).toContain("main");
    expect(widgetText).toContain("api");
    expect(widgetText).toContain("feat/oauth");

    // Update branch for current repo
    const res3 = await tool.execute("c3", { branch: "feat/ui" }, undefined, undefined, ctx);
    expect(res3.details.changed).toBe(true);
    expect(widgets.get(REPO_BRANCH_WIDGET_KEY).render(60).join("\n")).toContain("feat/ui");

    // List does not append
    const appendsBeforeList = appended.length;
    const resList = await tool.execute("c4", { action: "list" }, undefined, undefined, ctx);
    expect(resList.details.records).toHaveLength(2);
    expect(appended).toHaveLength(appendsBeforeList);

    // Remove one repo
    const resRemove = await tool.execute("c5", { action: "remove", repo: "api" }, undefined, undefined, ctx);
    expect(resRemove.details.removed?.name).toBe("api");
    expect(resRemove.details.records).toHaveLength(1);

    // Clear all
    const resClear = await tool.execute("c6", { action: "clear" }, undefined, undefined, ctx);
    expect(resClear.details.clearedCount).toBe(1);
    expect(widgets.get(REPO_BRANCH_WIDGET_KEY).render(60).join("\n")).toContain("暂无记录");
  });

  it("restores state on session_start/session_tree/session_compact and cleans up on shutdown", async () => {
    const savedState = {
      version: 1,
      visible: true,
      records: [{ key: "/workspace/app", name: "app", path: "/workspace/app", branch: "release/1.0", updatedAt: 10 }],
    };
    const { widgets, setWidget, emit } = setup({
      branch: [{ type: "custom", customType: REPO_BRANCH_ENTRY, data: savedState }],
    });

    await emit("session_start", { reason: "resume" });
    expect(widgets.get(REPO_BRANCH_WIDGET_KEY).render(60).join("\n")).toContain("release/1.0");

    await emit("session_shutdown", { reason: "quit" });
    expect(widgets.has(REPO_BRANCH_WIDGET_KEY)).toBe(false);
    expect(setWidget).toHaveBeenLastCalledWith(REPO_BRANCH_WIDGET_KEY, undefined, { placement: "aboveEditor" });
  });

  it("supports /repo-branch command and respects --repo-branch=false without touching headless workers", async () => {
    const disabled = setup({ argv: ["--repo-branch=false"], flagValue: true });
    await disabled.emit("session_start", { reason: "startup" });
    expect(disabled.setWidget).not.toHaveBeenCalled();

    const headless = setup({ hasUI: false });
    await headless.emit("session_start", { reason: "startup" });
    expect(headless.setWidget).not.toHaveBeenCalled();

    const interactive = setup();
    await interactive.emit("session_start", { reason: "startup" });
    await interactive.command.handler("record feat/cmd", interactive.ctx);
    expect(interactive.widgets.get(REPO_BRANCH_WIDGET_KEY).render(60).join("\n")).toContain("feat/cmd");

    await interactive.command.handler("off", interactive.ctx);
    expect(interactive.widgets.has(REPO_BRANCH_WIDGET_KEY)).toBe(false);

    await interactive.command.handler("toggle", interactive.ctx);
    expect(interactive.widgets.has(REPO_BRANCH_WIDGET_KEY)).toBe(true);
  });

  it("isolates state across independent extension instances", async () => {
    const first = setup({ sessionId: "root" });
    const second = setup({ sessionId: "worker", hasUI: false });
    await first.emit("session_start");
    await second.emit("session_start");

    await second.tool.execute("w1", { repo: "worker-repo", branch: "feat/worker" }, undefined, undefined, second.ctx);
    const firstList = await first.tool.execute("r1", { action: "list" }, undefined, undefined, first.ctx);
    expect(firstList.details.records).toEqual([]);
    expect(second.setWidget).not.toHaveBeenCalled();
  });

  it("renders tool calls and results cleanly", async () => {
    const { tool, ctx, emit } = setup();
    await emit("session_start");
    const result = await tool.execute("c1", { branch: "feat/render" }, undefined, undefined, ctx);
    const theme: any = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
    const callComp = tool.renderCall({ action: "record", branch: "feat/render" }, theme);
    const resultComp = tool.renderResult(result, { expanded: true }, theme);
    expect(callComp.render(80).join("\n")).toContain("record_repo_branch");
    expect(resultComp.render(80).join("\n")).toContain("feat/render");
  });

  it("restores on session_tree and session_compact, respects PI_REPO_BRANCH=0, and requires branch when undetectable", async () => {
    const savedV1 = {
      version: 1,
      visible: true,
      records: [{ key: "/workspace/app", name: "app", path: "/workspace/app", branch: "tree-branch", updatedAt: 1 }],
    };
    const branch = [{ type: "custom", customType: REPO_BRANCH_ENTRY, data: savedV1 }];
    const { tool, ctx, widgets, emit } = setup({ cwd: "/non-git", branch, gitResponses: {} });

    await emit("session_tree");
    expect(widgets.get(REPO_BRANCH_WIDGET_KEY).render(60).join("\n")).toContain("tree-branch");

    branch.push({
      type: "custom",
      customType: REPO_BRANCH_ENTRY,
      data: {
        version: 1,
        visible: true,
        records: [{ key: "/workspace/app", name: "app", path: "/workspace/app", branch: "compact-branch", updatedAt: 2 }],
      },
    });
    await emit("session_compact");
    expect(widgets.get(REPO_BRANCH_WIDGET_KEY).render(60).join("\n")).toContain("compact-branch");

    await expect(tool.execute("c-err", { repo: "plain-name" }, undefined, undefined, ctx)).rejects.toThrow(/branch is required/);

    const prevEnv = process.env.PI_REPO_BRANCH;
    process.env.PI_REPO_BRANCH = "0";
    try {
      const envHidden = setup();
      await envHidden.emit("session_start");
      expect(envHidden.setWidget).not.toHaveBeenCalled();
    } finally {
      if (prevEnv === undefined) delete process.env.PI_REPO_BRANCH;
      else process.env.PI_REPO_BRANCH = prevEnv;
    }
  });
});
