# Task Progress Visibility (TUI/RPC) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface sub-agent / sub-shell progress (tool calls, streaming text snapshots, kill signals) to the TUI and RPC channels in real time, **without polluting the parent LLM's context**.

**Architecture:**
- New customType `tasks/progress` published via `pi.sendMessage(..., {triggerTurn:false, deliverAs:"nextTurn"})` — verified by spike `extensions/spike-progress-context/` to NOT enter the next provider request.
- Producers: `spawnLocalAgent` (wires its existing `session.subscribe` listener to also emit progress messages) and `spawnLocalShell` (emits start / stall / kill / terminal milestone messages).
- Consumer: `tasks/notifications.ts` adds a sibling `registerMessageRenderer("tasks/progress", ...)` so TUI renders structured rows.
- RPC mode: same `display:true` flag means the message lands in stdout — RPC clients can switch on `customType` to filter.

**Tech Stack:** TypeScript ESM, Vitest, `@earendil-works/pi-coding-agent` `sendMessage` + `registerMessageRenderer` APIs.

---

## File Structure

**New files:**
- `extensions/tasks/progress.ts` — `TASK_PROGRESS_CUSTOM_TYPE` constant + `TaskProgressDetails` interface + `emitTaskProgress(pi, details)` helper + `registerTaskProgressRenderer(pi)`.
- `extensions/tasks/progress.test.ts` — emit/render unit tests.

**Modified files:**
- `extensions/tasks/index.ts` — re-export `TASK_PROGRESS_CUSTOM_TYPE` + `emitTaskProgress` + `registerTaskProgressRenderer`.
- `extensions/tasks/index.test.ts` — assert progress renderer registered.
- `extensions/localagent/spawnLocalAgent.ts` — inside `session.subscribe` listener, call `emitTaskProgress` on `tool_execution_start` / `tool_execution_end` / `agent_end`. Description text comes from existing `previewJson` helper extracted from `outputTranslator.ts`.
- `extensions/localagent/spawnLocalAgent.test.ts` — assert progress messages emitted (mock `pi.sendMessage`).
- `extensions/localagent/index.ts` — call `registerTaskProgressRenderer(pi)` once in `session_start`.
- `extensions/localshell/spawnLocalShell.ts` (extracted from `localShellTask.ts`) OR directly inside `localShellTask.ts:spawnLocalShell` — emit progress at `start` / `output_chunk` (throttled) / `terminal`. Reuse stallWatchdog's customMessage structure.
- `extensions/localshell/localShellTask.test.ts` — assert progress emitted in spawn path.
- `extensions/localshell/index.ts` — call `registerTaskProgressRenderer(pi)` (skip if already registered by tasks ext — pattern: idempotent).

**Decisions locked in by user:**
1. Method = `sendMessage(deliverAs:"nextTurn", triggerTurn:false)` — spike-validated to NOT enter LLM context.
2. RPC distinguishability — solved by dedicated `customType: "tasks/progress"`.
3. LocalShell also gets progress (user accepted "B + 顺便给 LocalShell 也加").

**Out of scope (future / deferred):**
- Foldable component renderer (claude-style nested tree). Plain text renderer is sufficient for now.
- Throttling progress for very chatty tools (>20/sec). YAGNI until observed.
- Persisting progress to disk separately from `outputFile` — `outputFile` is already the truth of record.

---

## Task 0: Lock Down customMessage→LLM-context Behavior

> **Status:** Already complete via the spike at `extensions/spike-progress-context/`. **Skip implementation, but**:
> - [ ] **Step 0.1**: confirm spike still exists and `npm test` passes.
> - [ ] **Step 0.2**: copy the key spike conclusion into `docs/superpowers/specs/2026-06-03-task-progress-visibility-design.md` (write a 1-page spec referencing the spike's verification result + the design decisions).

Decision summary the spec must capture:
- `sendMessage({deliverAs:"nextTurn", triggerTurn:false})` writes the customMessage to the session jsonl and emits to TUI/RPC, but the message does NOT appear in `payload.messages[]` of the next `before_provider_request` event.
- This is the correct primitive for TUI-only progress.

---

## Task 1: `tasks/progress` customType + helper

**Files:**
- Create: `extensions/tasks/progress.ts`
- Create: `extensions/tasks/progress.test.ts`
- Modify: `extensions/tasks/index.ts` (add re-exports)

- [ ] **Step 1.1: Write the failing test** — `extensions/tasks/progress.test.ts`

```ts
import { describe, it, expect, vi } from "vitest";
import { emitTaskProgress, TASK_PROGRESS_CUSTOM_TYPE } from "./progress.js";

describe("emitTaskProgress", () => {
  it("calls pi.sendMessage with triggerTurn:false + deliverAs:nextTurn", () => {
    const sendMessage = vi.fn();
    const pi = { sendMessage } as never;
    emitTaskProgress(pi, {
      taskId: "ax12",
      taskType: "local_agent",
      kind: "tool_start",
      summary: "grep(\"foo\")",
      details: { toolName: "grep" },
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [msg, opts] = sendMessage.mock.calls[0]!;
    expect(msg.customType).toBe(TASK_PROGRESS_CUSTOM_TYPE);
    expect(msg.display).toBe(true);
    expect(msg.content).toContain("grep(\"foo\")");
    expect(msg.details).toMatchObject({ taskId: "ax12", kind: "tool_start" });
    expect(opts).toEqual({ triggerTurn: false, deliverAs: "nextTurn" });
  });

  it("ignores throwing sendMessage (defensive)", () => {
    const sendMessage = vi.fn(() => { throw new Error("boom"); });
    const pi = { sendMessage } as never;
    expect(() => emitTaskProgress(pi, {
      taskId: "ax12",
      taskType: "local_agent",
      kind: "tool_start",
      summary: "x",
    })).not.toThrow();
  });
});
```

- [ ] **Step 1.2: Run — expect FAIL** (`progress.ts` doesn't exist)

```bash
npx vitest run extensions/tasks/progress.test.ts
# Expected: import error or test failure
```

- [ ] **Step 1.3: Implement `progress.ts`**

```ts
// Task progress messages — pushed to TUI/RPC via sendMessage(deliverAs:"nextTurn", triggerTurn:false).
// Spike-verified to NOT enter the parent LLM's next provider request.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { logError } from "./logging.js";
import type { TaskType } from "./Task.js";

export const TASK_PROGRESS_CUSTOM_TYPE = "tasks/progress";

export type TaskProgressKind =
  | "task_start"
  | "tool_start"
  | "tool_end"
  | "stream"
  | "task_end"
  | "kill";

export interface TaskProgressDetails {
  taskId: string;
  taskType: TaskType;
  kind: TaskProgressKind;
  summary: string;            // human-readable line, e.g. `grep("foo")` or `[ok] grep → 12 results`
  description?: string;       // task description (slug from prompt)
  agentType?: string;         // local_agent only
  toolName?: string;          // tool_start / tool_end only
  isError?: boolean;          // tool_end only
  exitCode?: number;          // local_bash terminal only
  durationMs?: number;        // task_end only
  toolCallCount?: number;     // task_end only
  tokenCount?: number;        // task_end only
  ts: number;
}

export function emitTaskProgress(
  pi: Pick<ExtensionAPI, "sendMessage">,
  d: Omit<TaskProgressDetails, "ts"> & { ts?: number },
): void {
  const details: TaskProgressDetails = { ts: Date.now(), ...d };
  try {
    pi.sendMessage(
      {
        customType: TASK_PROGRESS_CUSTOM_TYPE,
        content: details.summary,
        display: true,
        details,
      } as never,
      { triggerTurn: false, deliverAs: "nextTurn" },
    );
  } catch (e) {
    logError(e, "emitTaskProgress");
  }
}
```

- [ ] **Step 1.4: Run — expect PASS** (2 tests green)
- [ ] **Step 1.5: Update `extensions/tasks/index.ts` re-exports**

```ts
export {
  emitTaskProgress,
  TASK_PROGRESS_CUSTOM_TYPE,
  type TaskProgressDetails,
  type TaskProgressKind,
} from "./progress.js";
```

- [ ] **Step 1.6: Typecheck + full test suite — expect 492 + 2 = 494 passing**

```bash
npx tsc --noEmit && npm test 2>&1 | tail -3
```

- [ ] **Step 1.7: Commit**

```bash
git add extensions/tasks/progress.ts extensions/tasks/progress.test.ts extensions/tasks/index.ts
git commit -m "feat(tasks): add tasks/progress customType + emitTaskProgress helper"
```

---

## Task 2: Progress renderer registration in `tasks` ext

**Files:**
- Modify: `extensions/tasks/notifications.ts` (add `registerTaskProgressRenderer` function)
- Modify: `extensions/tasks/progress.ts` (alternatively keep renderer here; pick one — recommend `progress.ts` for cohesion)
- Modify: `extensions/tasks/index.ts` (re-export it)
- Modify: `extensions/tasks/index.test.ts` (assert renderer registered)

> **Decision**: keep the renderer in `progress.ts` next to `emitTaskProgress` (high cohesion), not in `notifications.ts`.

- [ ] **Step 2.1: Add failing test in `progress.test.ts`**

```ts
it("registerTaskProgressRenderer registers a renderer for the customType", () => {
  const registerMessageRenderer = vi.fn();
  const pi = { registerMessageRenderer } as never;
  registerTaskProgressRenderer(pi);
  expect(registerMessageRenderer).toHaveBeenCalledTimes(1);
  const [customType, renderer] = registerMessageRenderer.mock.calls[0]!;
  expect(customType).toBe(TASK_PROGRESS_CUSTOM_TYPE);
  expect(typeof renderer).toBe("function");
});

it("renderer returns a Component-like object (smoke)", () => {
  // We can't fully test pi-tui Component here; just assert renderer doesn't throw on a typical message.
  let captured: unknown;
  const pi = { registerMessageRenderer: (_t: string, r: unknown) => { captured = r; } } as never;
  registerTaskProgressRenderer(pi);
  const renderer = captured as (msg: unknown, opts: unknown, theme: unknown) => unknown;
  const out = renderer(
    { customType: TASK_PROGRESS_CUSTOM_TYPE, content: "grep(\"foo\")",
      display: true, details: { taskId: "ax12", taskType: "local_agent",
      kind: "tool_start", summary: "grep(\"foo\")", ts: 1 } },
    { expanded: false },
    { fg: "#fff", dim: "#888" } as never,
  );
  expect(out).toBeDefined();
});
```

- [ ] **Step 2.2: Run — expect FAIL**
- [ ] **Step 2.3: Implement `registerTaskProgressRenderer`**

Append to `extensions/tasks/progress.ts`:

```ts
import type { Component, MessageRenderer } from "@earendil-works/pi-coding-agent";
// (import already exists for ExtensionAPI; just extend)
import { Box, Text } from "@earendil-works/pi-tui";

export function registerTaskProgressRenderer(
  pi: Pick<ExtensionAPI, "registerMessageRenderer">,
): void {
  const renderer: MessageRenderer<TaskProgressDetails> = (message, _opts, theme) => {
    const d = message.details;
    if (!d) return undefined;
    const prefix = renderPrefix(d);
    return Box(
      { dir: "row" },
      Text(prefix, { color: theme.dim ?? "#888" }),
      Text(d.summary ?? message.content ?? "", { color: theme.fg ?? "#fff" }),
    ) as unknown as Component;
  };
  pi.registerMessageRenderer<TaskProgressDetails>(TASK_PROGRESS_CUSTOM_TYPE, renderer);
}

function renderPrefix(d: TaskProgressDetails): string {
  const tag = d.taskType === "local_agent" ? "agent" : "bash";
  const kindIcon: Record<TaskProgressKind, string> = {
    task_start: "▶",
    tool_start: "  ↳",
    tool_end: "  ✓",
    stream: "  ·",
    task_end: "■",
    kill: "✗",
  };
  return `[${tag} ${d.taskId}] ${kindIcon[d.kind] ?? "·"} `;
}
```

> **Note**: Look up exact `pi-tui` API names before committing — fall back to a plain string-returning renderer if Box/Text don't match. Inspect `node_modules/@earendil-works/pi-tui/dist/*.d.ts` first.

- [ ] **Step 2.4: Run — expect PASS**
- [ ] **Step 2.5: Wire into `tasks/index.ts` `session_start`**

In `extensions/tasks/index.ts`, locate the existing line that calls `registerTaskNotificationRenderer(pi)`. Add right after:

```ts
registerTaskProgressRenderer(pi);
```

Update `extensions/tasks/index.test.ts`'s "registers a renderer" test to assert **both** calls happen.

- [ ] **Step 2.6: Typecheck + full test — expect 494 + 2 = 496 passing (counting both new tests)**
- [ ] **Step 2.7: Commit**

```bash
git commit -m "feat(tasks): register renderer for tasks/progress customType"
```

---

## Task 3: LocalAgent emits progress on tool start/end + agent_end

**Files:**
- Modify: `extensions/localagent/spawnLocalAgent.ts` (subscribe block)
- Modify: `extensions/localagent/spawnLocalAgent.test.ts` (add assertion)

- [ ] **Step 3.1: Add failing test** in `spawnLocalAgent.test.ts`

```ts
it("emits tasks/progress messages on tool_execution_start, tool_execution_end, and agent_end", async () => {
  const sendMessage = vi.fn();
  const pi = makeFakePi({ sendMessage }); // existing helper
  // ... build fake AgentSession that fires tool_execution_start, tool_execution_end, agent_end ...
  await spawnLocalAgent(pi, store, { /* ...args... */ });

  const progressCalls = sendMessage.mock.calls.filter(
    ([msg]) => (msg as { customType?: string }).customType === "tasks/progress",
  );
  // 1 task_start + 1 tool_start + 1 tool_end + 1 task_end = 4
  expect(progressCalls.length).toBeGreaterThanOrEqual(4);
  const kinds = progressCalls.map(([msg]) => (msg as { details: { kind: string } }).details.kind);
  expect(kinds).toContain("task_start");
  expect(kinds).toContain("tool_start");
  expect(kinds).toContain("tool_end");
  expect(kinds).toContain("task_end");
});
```

- [ ] **Step 3.2: Run — expect FAIL**
- [ ] **Step 3.3: Implement progress emission in `spawnLocalAgent.ts`**

Add `emitTaskProgress` import. Inside the subscribe listener:

```ts
// After registerTask(initial, store) / before subscribe:
emitTaskProgress(pi, {
  taskId, taskType: "local_agent", kind: "task_start",
  summary: `${opts.agentDef.agentType} → ${opts.prompt.slice(0, 60)}`,
  description: opts.description,
  agentType: opts.agentDef.agentType,
});

// Inside subscribe listener:
if (e.type === "tool_execution_start" && e.toolName) {
  emitTaskProgress(pi, {
    taskId, taskType: "local_agent", kind: "tool_start",
    toolName: e.toolName,
    summary: `${e.toolName}(${previewJson(e.args, 60)})`,
    agentType: opts.agentDef.agentType,
  });
}
if (e.type === "tool_execution_end" && e.toolName) {
  emitTaskProgress(pi, {
    taskId, taskType: "local_agent", kind: "tool_end",
    toolName: e.toolName,
    isError: !!e.isError,
    summary: e.isError
      ? `[err] ${e.toolName}: ${shorten(String(e.result), 100)}`
      : `[ok] ${e.toolName} → ${previewJson(e.result, 60)}`,
    agentType: opts.agentDef.agentType,
  });
}
if (e.type === "agent_end") {
  // emit AFTER setting agentEnded so finalize/runBackgroundFinalizer race resolves consistently.
  emitTaskProgress(pi, {
    taskId, taskType: "local_agent", kind: "task_end",
    summary: `done (turns=${turnCount}, tools=${toolCount})`,
    agentType: opts.agentDef.agentType,
    toolCallCount: toolCount,
    tokenCount: getProgress(taskId)?.tokenCount ?? 0,
  });
}
```

> **Note**: Move `previewJson` and `shorten` from `outputTranslator.ts` to a shared `formatPreview.ts` (in `extensions/localagent/`) since both files now use them. Keep behavior identical — pure refactor + re-export.

- [ ] **Step 3.4: Run failing test — expect PASS**
- [ ] **Step 3.5: Typecheck + full test — expect 496 + 1 = 497 passing**
- [ ] **Step 3.6: Commit**

```bash
git commit -m "feat(localagent): emit tasks/progress on tool/agent lifecycle events"
```

---

## Task 4: LocalShell emits progress on start / chunk / terminal

**Files:**
- Modify: `extensions/localshell/localShellTask.ts` (or a new `progress.ts` helper)
- Modify: `extensions/localshell/localShellTask.test.ts`

> **Decision**: Inline emission inside `spawnLocalShell` is fine — the function is already large but `emitTaskProgress` calls are ~3 lines each.

- [ ] **Step 4.1: Add failing tests in `localShellTask.test.ts`**

```ts
it("emits task_start progress on spawn", async () => {
  const sendMessage = vi.fn();
  const pi = makeFakePi({ sendMessage });
  await spawnLocalShell(pi, store, { command: "echo hi", description: "hi" });
  const starts = sendMessage.mock.calls.filter(
    ([m]) => (m as { details?: { kind?: string } }).details?.kind === "task_start"
  );
  expect(starts.length).toBe(1);
  expect((starts[0]![0] as { details: { taskType: string } }).details.taskType).toBe("local_bash");
});

it("emits task_end progress on completion", async () => {
  // ...same setup...
  const ends = sendMessage.mock.calls.filter(
    ([m]) => (m as { details?: { kind?: string } }).details?.kind === "task_end"
  );
  expect(ends.length).toBeGreaterThanOrEqual(1);
});
```

- [ ] **Step 4.2: Run — expect FAIL**
- [ ] **Step 4.3: Implement emissions in `spawnLocalShell`**

Inside `spawnLocalShell`, right after `registerTask(initial, store)`:

```ts
emitTaskProgress(pi, {
  taskId, taskType: "local_bash", kind: "task_start",
  summary: opts.description, description: opts.description,
});
```

Inside `onSyncFinish` and `onBackgroundedTerminal`, just before `notifyTaskTerminal`:

```ts
emitTaskProgress(pi, {
  taskId, taskType: "local_bash", kind: "task_end",
  summary: `${finalStatus}${r.exitCode != null ? ` (exit ${r.exitCode})` : ""}`,
  description: opts.description,
  exitCode: r.exitCode ?? undefined,
});
```

In `kill.ts:killLocalShellTask`, just after status flip:

```ts
emitTaskProgress(pi, {
  taskId, taskType: "local_bash", kind: "kill",
  summary: "killed by user request",
});
```

- [ ] **Step 4.4: Run — expect PASS**
- [ ] **Step 4.5: Mirror kill emission in `extensions/localagent/kill.ts`**

```ts
emitTaskProgress(pi, {
  taskId, taskType: "local_agent", kind: "kill",
  summary: "killed by user request",
});
```

Add an assertion to `extensions/localagent/kill.test.ts` if the file exists and has fakes for `pi.sendMessage`.

- [ ] **Step 4.6: Typecheck + full test — expect 497 + ~3 = ~500 passing**
- [ ] **Step 4.7: Commit**

```bash
git commit -m "feat(localshell,localagent): emit tasks/progress on spawn/terminal/kill"
```

---

## Task 5: End-to-end RPC verification + spike cleanup

**Files:**
- Delete: `extensions/spike-progress-context/` (after verification confirms behavior in real Pi)
- Modify: `docs/superpowers/specs/2026-06-03-task-progress-visibility-design.md` (close out, link to commits)

- [ ] **Step 5.1: Real RPC test (token recovered, with --no-session)**

```bash
pi --no-extensions -e . -p "Use task_agent with subagent_type='explore' and prompt='count files in extensions/localagent/'." 2>&1 | tee /tmp/rpc-test.log
```

Manually inspect: should see lines whose `customType: tasks/progress` appears in stdout (RPC mode) — confirm `kind: task_start`, several `tool_start`/`tool_end`, `task_end`.

- [ ] **Step 5.2: Real TUI test**

```bash
pi --no-extensions -e .
# Then in TUI: ask "Use task_agent with subagent_type='explore' and prompt='find any .md files in /tmp'"
# Verify: progress lines render in real time (not just after sub-agent finishes).
```

- [ ] **Step 5.3: Confirm parent-LLM context unchanged**

Use the spike's `before_provider_request` log path (`/tmp/pi-spike-provider-requests.jsonl`) **once more** with the new progress emission active:

```bash
rm /tmp/pi-spike-provider-requests.jsonl
pi --no-extensions -e .,extensions/spike-progress-context -p "Use task_agent..."
grep -c '"customType":"tasks/progress"' /tmp/pi-spike-provider-requests.jsonl
# Expected: 0 (NEVER appears in any provider payload)
```

- [ ] **Step 5.4: Delete spike + final commit**

```bash
rm -rf extensions/spike-progress-context
git add -A
git commit -m "chore: clean up progress-context spike (verification complete)"
```

- [ ] **Step 5.5: Final typecheck + test sweep — must be ~500 passing, 0 typecheck errors**

---

## Verification

- [ ] Phase 1 (Tasks 1-2): `tasks/progress` customType registered, helper + renderer tested with mocks. **494-496 passing.**
- [ ] Phase 2 (Task 3): LocalAgent emits 4 progress kinds on a real spawn. **497 passing.**
- [ ] Phase 3 (Task 4): LocalShell emits 3 progress kinds on real spawn + kill. **~500 passing.**
- [ ] Phase 4 (Task 5): RPC stdout shows progress messages with `customType: tasks/progress`; TUI renders them; spike re-confirms zero leakage into LLM context.

## Risks

1. **`pi-tui` Box/Text API mismatch** — mitigation: check `pi-tui` `.d.ts` before Task 2.3; fall back to single `Text(combined-string)` if Box/Text shape differs.
2. **Large args / results overwhelm progress lines** — mitigation: `previewJson(_, 60)` already truncates; if observed bloat, add throttling in a follow-up.
3. **`sendMessage` failure during `session_start` (tasks ext loaded but no UI yet)** — mitigation: `emitTaskProgress` is wrapped in try/catch + `logError`. The ext-load order (`tasks` < `localagent`/`localshell` alphabetically) is already correct.
4. **Renderer registration order** — `tasks` ext must register the renderer before `localagent` / `localshell` emit. Already guaranteed by alphabetical dir-load order.

## Out of Scope

- Foldable nested rendering (claude-style tree). Plain text is enough; structured `details` field lets us upgrade later without changing emit sites.
- Per-task progress widget overlay via `pi.ui.setWidget`. Considered; rejected because messages-stream rendering is the cheaper, more familiar UX.
- Throttling chatty tools. Add only if observed in practice.
- Unifying `localshell` stallWatchdog notification with `tasks/progress`. The two carry different semantics (stall is a USER PROMPT, progress is a UI feed); leave separate.
