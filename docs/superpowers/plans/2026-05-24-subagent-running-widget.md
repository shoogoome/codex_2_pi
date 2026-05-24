# Subagent Running Widget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show currently starting/running Pi subagents in a live widget below the chat input editor.

**Architecture:** Extend the existing `SubagentRegistry` with a small change-subscription API, then bind the `extensions/subagents` extension to Pi's `ctx.ui.setWidget(..., { placement: "belowEditor" })` on `session_start`. Rendering stays pure in a new helper file so widget text is testable and does not couple UI code to registry internals.

**Tech Stack:** TypeScript ESM, Pi extension API, Vitest globals, TypeBox-based existing subagent tools.

---

## File Structure

- Modify `extensions/subagents/registry.ts`: add registry change listeners and invoke them whenever subagent summaries change.
- Modify `extensions/subagents/registry.test.ts`: cover listener notification and unsubscribe behavior.
- Create `extensions/subagents/status-widget.ts`: pure formatting helpers for the below-editor running-subagent widget.
- Create `extensions/subagents/status-widget.test.ts`: cover empty, active, elapsed time, truncation, and overflow rendering.
- Modify `extensions/subagents/index.ts`: subscribe to registry changes on session start, update/clear the below-editor widget, and clean up on shutdown.
- Modify `README.md`: document the new live subagent widget.

---

### Task 1: Add registry change subscriptions

**Files:**
- Modify: `extensions/subagents/registry.ts`
- Modify: `extensions/subagents/registry.test.ts`

- [ ] **Step 1: Write failing registry subscription tests**

Add these imports and tests to `extensions/subagents/registry.test.ts`.

Change the first import from:

```ts
import { describe, expect, it, vi } from "vitest";
```

to:

```ts
import { describe, expect, it, vi } from "vitest";
```

The import line is already correct; append these tests near the end of the `describe("SubagentRegistry", ...)` block before the closing `});`:

```ts
  it("notifies subscribers with current summaries when entries change", () => {
    const registry = new SubagentRegistry({ ...options });
    const listener = vi.fn();

    const unsubscribe = registry.subscribe(listener);
    const entry = registry.createEntry({ taskName: "worker", cwd: "/repo" });
    registry.markRunning(entry.id);

    expect(listener).toHaveBeenCalledTimes(3);
    expect(listener.mock.calls[0][0]).toEqual([]);
    expect(listener.mock.calls[1][0]).toEqual([
      expect.objectContaining({ taskName: "worker", status: "starting" }),
    ]);
    expect(listener.mock.calls[2][0]).toEqual([
      expect.objectContaining({ taskName: "worker", status: "running" }),
    ]);

    unsubscribe();
  });

  it("stops notifying subscribers after unsubscribe", () => {
    const registry = new SubagentRegistry({ ...options });
    const listener = vi.fn();

    const unsubscribe = registry.subscribe(listener);
    unsubscribe();
    registry.createEntry({ taskName: "worker", cwd: "/repo" });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith([]);
  });
```

- [ ] **Step 2: Run registry tests and verify they fail**

Run:

```bash
npx vitest run extensions/subagents/registry.test.ts
```

Expected: FAIL with a TypeScript/runtime error equivalent to `registry.subscribe is not a function` or `Property 'subscribe' does not exist`.

- [ ] **Step 3: Implement registry subscriptions**

In `extensions/subagents/registry.ts`, add this type after the `Waiter` interface:

```ts
type RegistryListener = (summaries: SubagentSummary[]) => void;
```

Add this field inside `SubagentRegistry` next to the existing maps/sets:

```ts
  private readonly listeners = new Set<RegistryListener>();
```

Add this public method after `list()`:

```ts
  subscribe(listener: RegistryListener): () => void {
    this.listeners.add(listener);
    listener(this.list());
    return () => {
      this.listeners.delete(listener);
    };
  }
```

Replace the current `notify` method:

```ts
  private notify(_entry: SubagentEntry): void {
    for (const waiter of Array.from(this.waiters)) this.flushWaiter(waiter);
  }
```

with:

```ts
  private notify(_entry: SubagentEntry): void {
    for (const waiter of Array.from(this.waiters)) this.flushWaiter(waiter);
    const summaries = this.list();
    for (const listener of Array.from(this.listeners)) listener(summaries);
  }
```

- [ ] **Step 4: Run registry tests and verify they pass**

Run:

```bash
npx vitest run extensions/subagents/registry.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit registry subscription support**

Run:

```bash
git add extensions/subagents/registry.ts extensions/subagents/registry.test.ts
git commit -m "feat: notify subagent registry subscribers"
```

Expected: commit succeeds. If the user does not want commits in this session, skip the commit command and mention the skipped commit in the handoff.

---

### Task 2: Add pure running-widget renderer

**Files:**
- Create: `extensions/subagents/status-widget.ts`
- Create: `extensions/subagents/status-widget.test.ts`

- [ ] **Step 1: Write failing widget renderer tests**

Create `extensions/subagents/status-widget.test.ts` with this content:

```ts
import { describe, expect, it } from "vitest";
import { formatRunningSubagentWidget } from "./status-widget.js";
import type { SubagentSummary } from "./types.js";

function summary(overrides: Partial<SubagentSummary> = {}): SubagentSummary {
  return {
    id: "agent_1",
    taskName: "worker",
    cwd: "/repo",
    status: "running",
    lastTurnStatus: "none",
    startedAt: 1_000,
    updatedAt: 2_000,
    usage: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    eventCount: 0,
    recentEvents: [],
    mailboxVersion: 1,
    ...overrides,
  };
}

describe("running subagent widget", () => {
  it("returns undefined when no subagents are active", () => {
    expect(formatRunningSubagentWidget([summary({ status: "idle" })], 5_000)).toBeUndefined();
    expect(formatRunningSubagentWidget([summary({ status: "closed" })], 5_000)).toBeUndefined();
    expect(formatRunningSubagentWidget([summary({ status: "failed" })], 5_000)).toBeUndefined();
  });

  it("renders starting and running subagents in start order", () => {
    expect(
      formatRunningSubagentWidget(
        [
          summary({ id: "agent_2", taskName: "second", status: "running", startedAt: 2_000 }),
          summary({ id: "agent_1", taskName: "first", status: "starting", startedAt: 1_000 }),
        ],
        62_000,
      ),
    ).toEqual([
      "Subagents running (2):",
      "● first — starting — 1m01s",
      "● second — running — 1m00s",
    ]);
  });

  it("includes assistant or error previews when present", () => {
    expect(
      formatRunningSubagentWidget(
        [
          summary({ taskName: "review", lastAssistantPreview: "checking tests" }),
          summary({ taskName: "debug", lastError: "temporary stderr" }),
        ],
        5_000,
      ),
    ).toEqual([
      "Subagents running (2):",
      "● review — running — 4s — checking tests",
      "● debug — running — 4s — Error: temporary stderr",
    ]);
  });

  it("limits long lists and shows overflow count", () => {
    const agents = Array.from({ length: 6 }, (_, index) =>
      summary({ id: `agent_${index + 1}`, taskName: `worker_${index + 1}`, startedAt: index + 1 }),
    );

    expect(formatRunningSubagentWidget(agents, 10_000, { maxRows: 3 })).toEqual([
      "Subagents running (6):",
      "● worker_1 — running — 9s",
      "● worker_2 — running — 9s",
      "● worker_3 — running — 9s",
      "… 3 more running",
    ]);
  });
});
```

- [ ] **Step 2: Run widget tests and verify they fail**

Run:

```bash
npx vitest run extensions/subagents/status-widget.test.ts
```

Expected: FAIL because `extensions/subagents/status-widget.ts` does not exist.

- [ ] **Step 3: Implement widget renderer**

Create `extensions/subagents/status-widget.ts` with this content:

```ts
import type { SubagentLifecycleStatus, SubagentSummary } from "./types.js";
import { previewText } from "./text.js";

const ACTIVE_STATUSES = new Set<SubagentLifecycleStatus>(["starting", "running"]);
const DEFAULT_MAX_ROWS = 5;
const PREVIEW_LIMIT = 72;

export interface RunningSubagentWidgetOptions {
  maxRows?: number;
}

export function formatRunningSubagentWidget(
  summaries: SubagentSummary[],
  now = Date.now(),
  options: RunningSubagentWidgetOptions = {},
): string[] | undefined {
  const active = summaries
    .filter((summary) => ACTIVE_STATUSES.has(summary.status))
    .sort((left, right) => left.startedAt - right.startedAt || left.taskName.localeCompare(right.taskName));

  if (active.length === 0) return undefined;

  const maxRows = Math.max(1, Math.floor(options.maxRows ?? DEFAULT_MAX_ROWS));
  const visible = active.slice(0, maxRows);
  const title = active.length === 1 ? "Subagent running:" : `Subagents running (${active.length}):`;
  const lines = [title, ...visible.map((summary) => formatRunningSubagentLine(summary, now))];
  const hidden = active.length - visible.length;
  if (hidden > 0) lines.push(`… ${hidden} more running`);
  return lines;
}

function formatRunningSubagentLine(summary: SubagentSummary, now: number): string {
  const parts = [`● ${summary.taskName}`, summary.status, formatElapsed(now - summary.startedAt)];
  const preview = summary.lastAssistantPreview
    ? previewText(summary.lastAssistantPreview, PREVIEW_LIMIT)
    : summary.lastError
      ? `Error: ${previewText(summary.lastError, PREVIEW_LIMIT)}`
      : undefined;
  if (preview) parts.push(preview);
  return parts.join(" — ");
}

function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) return `${totalMinutes}m${seconds.toString().padStart(2, "0")}s`;

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h${minutes.toString().padStart(2, "0")}m`;
}
```

- [ ] **Step 4: Run widget tests and verify they pass**

Run:

```bash
npx vitest run extensions/subagents/status-widget.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit widget renderer**

Run:

```bash
git add extensions/subagents/status-widget.ts extensions/subagents/status-widget.test.ts
git commit -m "feat: render running subagent widget"
```

Expected: commit succeeds. If commits are not desired, skip and document that.

---

### Task 3: Bind the widget to the subagents extension lifecycle

**Files:**
- Modify: `extensions/subagents/index.ts`
- Create: `extensions/subagents/index.test.ts`

- [ ] **Step 1: Write failing extension lifecycle tests**

Create `extensions/subagents/index.test.ts` with this content:

```ts
import { describe, expect, it, vi } from "vitest";
import subagentsExtension from "./index.js";

describe("subagents extension running widget", () => {
  it("registers a below-editor widget on session start and clears it on shutdown", async () => {
    const handlers = new Map<string, Function[]>();
    const setWidget = vi.fn();
    const closeAll = vi.fn();

    const pi: any = {
      registerTool: vi.fn(),
      registerMessageRenderer: vi.fn(),
      on: vi.fn((event: string, handler: Function) => {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      }),
    };

    subagentsExtension(pi, {
      registryFactory: () => ({
        subscribe: vi.fn((listener) => {
          listener([
            {
              id: "agent_1",
              taskName: "worker",
              cwd: "/repo",
              status: "running",
              lastTurnStatus: "none",
              startedAt: 1_000,
              updatedAt: 1_000,
              usage: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
              eventCount: 0,
              recentEvents: [],
              mailboxVersion: 1,
            },
          ]);
          return vi.fn();
        }),
        resolve: vi.fn(),
        createEntry: vi.fn(),
        markRunning: vi.fn(),
        markFailed: vi.fn(),
        list: vi.fn(() => []),
        waitForUpdate: vi.fn(),
        markClosed: vi.fn(),
        closeAll,
      }),
    });

    const sessionStart = handlers.get("session_start")?.[0];
    const shutdown = handlers.get("session_shutdown")?.[0];
    expect(sessionStart).toBeDefined();
    expect(shutdown).toBeDefined();

    await sessionStart?.({ type: "session_start", reason: "startup" }, { hasUI: true, ui: { setWidget } });

    expect(setWidget).toHaveBeenCalledWith(
      "codex-subagents-running",
      expect.arrayContaining(["Subagent running:", expect.stringContaining("worker")]),
      { placement: "belowEditor" },
    );

    await shutdown?.({ type: "session_shutdown" }, { hasUI: true, ui: { setWidget } });

    expect(setWidget).toHaveBeenLastCalledWith("codex-subagents-running", undefined, { placement: "belowEditor" });
    expect(closeAll).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the new extension test and verify it fails**

Run:

```bash
npx vitest run extensions/subagents/index.test.ts
```

Expected: FAIL because `subagentsExtension` does not accept the optional test dependency object and does not register the widget lifecycle handlers yet.

- [ ] **Step 3: Implement lifecycle binding**

Replace `extensions/subagents/index.ts` with this content:

```ts
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SubagentRegistry } from "./registry.js";
import { createRpcClientFromProcess, spawnRpcProcess } from "./rpc-client.js";
import { createSubagentTools } from "./tools.js";
import { DEFAULT_SUBAGENT_OPTIONS, type SubagentRpcFactory, type SubagentToolDetails } from "./types.js";
import { renderSubagentResult } from "./render.js";
import { formatRunningSubagentWidget } from "./status-widget.js";

const RUNNING_WIDGET_KEY = "codex-subagents-running";

interface SubagentsExtensionDeps {
  registryFactory?: () => SubagentRegistry;
}

export default function subagentsExtension(pi: ExtensionAPI, deps: SubagentsExtensionDeps = {}) {
  const registry = deps.registryFactory?.() ?? new SubagentRegistry(DEFAULT_SUBAGENT_OPTIONS);
  let unsubscribeWidget: (() => void) | undefined;
  let widgetContext: Pick<ExtensionContext, "hasUI" | "ui"> | undefined;

  const rpcFactory: SubagentRpcFactory = {
    spawn(input) {
      const entry = registry.resolve(input.taskName);
      if (!entry) throw new Error(`subagent not found after create: ${input.taskName}`);
      const proc = spawnRpcProcess(input.cwd, input.model);
      return createRpcClientFromProcess(entry.id, input.taskName, proc, registry);
    },
  };

  for (const tool of createSubagentTools(registry, rpcFactory)) {
    pi.registerTool(tool);
  }

  pi.registerMessageRenderer("codex-subagent-update", (message, { expanded }, theme) => {
    const text = typeof message.content === "string" ? message.content : "";
    const result = {
      content: [{ type: "text" as const, text }],
      details: message.details as SubagentToolDetails,
    };
    return renderSubagentResult(result, expanded, theme);
  });

  pi.on("session_start", async (_event, ctx) => {
    widgetContext = ctx;
    unsubscribeWidget?.();
    unsubscribeWidget = registry.subscribe((summaries) => {
      updateRunningWidget(widgetContext, summaries);
    });
  });

  pi.on("session_shutdown", async () => {
    unsubscribeWidget?.();
    unsubscribeWidget = undefined;
    clearRunningWidget(widgetContext);
    widgetContext = undefined;
    registry.closeAll();
  });
}

function updateRunningWidget(ctx: Pick<ExtensionContext, "hasUI" | "ui"> | undefined, summaries: Parameters<typeof formatRunningSubagentWidget>[0]): void {
  if (!ctx?.hasUI) return;
  ctx.ui.setWidget(RUNNING_WIDGET_KEY, formatRunningSubagentWidget(summaries), { placement: "belowEditor" });
}

function clearRunningWidget(ctx: Pick<ExtensionContext, "hasUI" | "ui"> | undefined): void {
  if (!ctx?.hasUI) return;
  ctx.ui.setWidget(RUNNING_WIDGET_KEY, undefined, { placement: "belowEditor" });
}
```

- [ ] **Step 4: Run extension lifecycle test and fix type mismatches if any**

Run:

```bash
npx vitest run extensions/subagents/index.test.ts
```

Expected: PASS. If TypeScript reports that the test fake registry does not match `SubagentRegistry`, change the test `registryFactory` return to `() => fakeRegistry as unknown as SubagentRegistry` and import `SubagentRegistry` as a type:

```ts
import type { SubagentRegistry } from "./registry.js";
```

Then use:

```ts
const fakeRegistry = { /* same object as above */ };
registryFactory: () => fakeRegistry as unknown as SubagentRegistry,
```

- [ ] **Step 5: Run existing subagent tests**

Run:

```bash
npx vitest run extensions/subagents/*.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit lifecycle binding**

Run:

```bash
git add extensions/subagents/index.ts extensions/subagents/index.test.ts
git commit -m "feat: show running subagents below editor"
```

Expected: commit succeeds. If commits are not desired, skip and document that.

---

### Task 4: Document and verify the feature

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update README subagent section**

In `README.md`, after this paragraph:

```md
折叠后的 TUI 行使用 Codex 风格摘要：已启动 agent、已发送输入、等待中、等待结束、已关闭 agent。展开后的行显示 Pi 特定的调试信息，例如最近的子进程工具调用、stderr 预览和用量计数。这些信息只用于 UI 可观测性，不会作为完整日志返回给父模型。
```

add:

```md
在交互式 TUI 中，`extensions/subagents` 还会在聊天输入框下方显示当前 `starting` / `running` 的 subagent 列表。列表只作为 UI 状态提示，不会写入模型上下文；所有 subagent 都结束后该提示会自动消失。
```

- [ ] **Step 2: Run full test suite**

Run:

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 3: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: `tsc --noEmit` exits successfully.

- [ ] **Step 4: Inspect working tree**

Run:

```bash
git status --short
```

Expected: only intended files are modified/created, plus any pre-existing user changes that were present before implementation.

- [ ] **Step 5: Commit documentation and final verification**

Run:

```bash
git add README.md
git commit -m "docs: document running subagent widget"
```

Expected: commit succeeds. If commits are not desired, skip and document that.

---

## Self-Review

- Spec coverage: The plan implements the selected Option A by using Pi `setWidget` with `placement: "belowEditor"`, rendering only `starting` and `running` subagents, clearing when no active agents remain, and avoiding model-context pollution.
- Placeholder scan: No `TBD`, `TODO`, or vague implementation steps remain; all code steps include concrete snippets.
- Type consistency: `SubagentRegistry.subscribe`, `formatRunningSubagentWidget`, `RUNNING_WIDGET_KEY`, and status names match existing TypeScript types and the planned test code.
