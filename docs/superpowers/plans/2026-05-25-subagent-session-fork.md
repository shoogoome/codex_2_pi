# Subagent Session Fork Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add explicit opt-in session-clone fork support to `spawn_agent` while keeping ordinary no-session subagents as the default.

**Architecture:** The subagents extension will create a forked Pi session only when `spawn_agent` receives `fork_context: true`. Fork creation uses Pi's exported `SessionManager.open(...).createBranchedSession(leafId)` API, and the RPC child process starts with `--session <forkedSessionPath>` instead of `--no-session`. Existing registry/RPC plumbing stays unchanged except for carrying optional fork metadata.

**Tech Stack:** TypeScript ESM, Pi extension API, `@earendil-works/pi-coding-agent` `SessionManager`, TypeBox schemas, Vitest.

---

## File Structure

- Modify `extensions/subagents/types.ts`
  - Add optional `sessionPath` and `forked` metadata to spawn inputs, registry entries, and summaries.
- Modify `extensions/subagents/rpc-client.ts`
  - Allow RPC child processes to start with either `--no-session` or `--session <path>`.
- Modify `extensions/subagents/registry.ts`
  - Store and expose optional fork metadata.
- Modify `extensions/subagents/tools.ts`
  - Add `fork_context` to `spawn_agent` schema.
  - Add a small session-fork helper injected via optional dependencies for tests.
  - Create forked sessions only when explicitly requested.
- Modify `extensions/subagents/render.ts`
  - Show forked session path in expanded tool details.
- Modify tests near changed files.
- Modify `README.md`
  - Document explicit fork behavior and default ordinary behavior.

---

### Task 1: RPC process args support `--session`

**Files:**
- Modify: `extensions/subagents/rpc-client.ts`
- Modify: `extensions/subagents/rpc-client.test.ts`
- Modify: `extensions/subagents/types.ts`

- [ ] **Step 1: Write failing tests for RPC args**

Replace the final `describe("buildRpcProcessArgs", ...)` block in `extensions/subagents/rpc-client.test.ts` with:

```ts
describe("buildRpcProcessArgs", () => {
  it("starts codex-style rpc process with no session by default", () => {
    expect(buildRpcProcessArgs("test-model")).toEqual(["--mode", "rpc", "--no-session", "--model", "test-model"]);
  });

  it("starts rpc process with a session when sessionPath is provided", () => {
    expect(buildRpcProcessArgs(undefined, "/tmp/subagent.jsonl")).toEqual(["--mode", "rpc", "--session", "/tmp/subagent.jsonl"]);
  });

  it("keeps model override with sessionPath", () => {
    expect(buildRpcProcessArgs("test-model", "/tmp/subagent.jsonl")).toEqual([
      "--mode",
      "rpc",
      "--session",
      "/tmp/subagent.jsonl",
      "--model",
      "test-model",
    ]);
  });
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
npm test -- extensions/subagents/rpc-client.test.ts
```

Expected: FAIL because `buildRpcProcessArgs` currently accepts only one argument and always emits `--no-session`.

- [ ] **Step 3: Add session metadata types**

In `extensions/subagents/types.ts`, change `SubagentEntry` by adding these fields after `cwd: string;`:

```ts
  sessionPath?: string;
  forked?: boolean;
```

Change `SubagentSummary` by adding the same fields after `cwd: string;`:

```ts
  sessionPath?: string;
  forked?: boolean;
```

Change `SpawnSubagentInput` to:

```ts
export interface SpawnSubagentInput {
  taskName: string;
  message: string;
  cwd: string;
  model?: string;
  sessionPath?: string;
  forked?: boolean;
}
```

Change `CreateEntryInput` to:

```ts
export interface CreateEntryInput {
  taskName: string;
  cwd: string;
  sessionPath?: string;
  forked?: boolean;
}
```

- [ ] **Step 4: Implement RPC process args**

In `extensions/subagents/rpc-client.ts`, replace `spawnRpcProcess` and `buildRpcProcessArgs` with:

```ts
export function spawnRpcProcess(cwd: string, model: string | undefined, sessionPath?: string): ChildProcessWithoutNullStreams {
  return spawn(resolvePiCommand(), buildRpcProcessArgs(model, sessionPath), { cwd, stdio: "pipe", shell: false });
}

export function buildRpcProcessArgs(model: string | undefined, sessionPath?: string): string[] {
  const args = sessionPath ? ["--mode", "rpc", "--session", sessionPath] : ["--mode", "rpc", "--no-session"];
  if (model) args.push("--model", model);
  return args;
}
```

- [ ] **Step 5: Run RPC tests**

Run:

```bash
npm test -- extensions/subagents/rpc-client.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 1**

Run:

```bash
git add extensions/subagents/rpc-client.ts extensions/subagents/rpc-client.test.ts extensions/subagents/types.ts
git commit -m "feat: allow subagent rpc sessions"
```

---

### Task 2: Registry carries fork metadata

**Files:**
- Modify: `extensions/subagents/registry.ts`
- Modify: `extensions/subagents/registry.test.ts`
- Modify: `extensions/subagents/render.ts`
- Modify: `extensions/subagents/render.test.ts`

- [ ] **Step 1: Write failing registry test**

In `extensions/subagents/registry.test.ts`, add this test inside the existing `describe` block:

```ts
  it("stores forked session metadata", () => {
    const registry = new SubagentRegistry({ ...options });

    registry.createEntry({ taskName: "worker", cwd: "/repo", sessionPath: "/tmp/subagent.jsonl", forked: true });

    expect(registry.resolve("worker")).toMatchObject({
      sessionPath: "/tmp/subagent.jsonl",
      forked: true,
    });
    expect(registry.list()[0]).toMatchObject({
      sessionPath: "/tmp/subagent.jsonl",
      forked: true,
    });
  });
```

If the file does not define `options`, add this near the top after imports:

```ts
const options = { maxAgents: 8, maxEventLogEntries: 100, defaultWaitTimeoutMs: 30_000, minWaitTimeoutMs: 1_000, maxWaitTimeoutMs: 300_000 };
```

- [ ] **Step 2: Write failing render test**

In `extensions/subagents/render.test.ts`, add a test for expanded rendering details. Use the local test patterns already present in this file. The assertion should check that rendering an expanded result containing an agent summary with `forked: true` and `sessionPath: "/tmp/subagent.jsonl"` includes `forked session: /tmp/subagent.jsonl` in the rendered text. If this file uses helper flattening, use the existing helper. The core test data should include:

```ts
const result = {
  content: [{ type: "text" as const, text: "Spawned worker" }],
  details: {
    action: "spawn" as const,
    agents: [{
      id: "agent_1",
      taskName: "worker",
      cwd: "/repo",
      sessionPath: "/tmp/subagent.jsonl",
      forked: true,
      status: "running" as const,
      lastTurnStatus: "none" as const,
      startedAt: 1,
      updatedAt: 1,
      usage: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
      eventCount: 0,
      recentEvents: [],
      mailboxVersion: 1,
    }],
  },
};
```

- [ ] **Step 3: Run failing tests**

Run:

```bash
npm test -- extensions/subagents/registry.test.ts extensions/subagents/render.test.ts
```

Expected: FAIL because metadata is not stored/rendered yet.

- [ ] **Step 4: Store metadata in registry**

In `extensions/subagents/registry.ts`, in `createEntry`, add fields to the created entry after `cwd: input.cwd,`:

```ts
      sessionPath: input.sessionPath,
      forked: input.forked,
```

In `toSummary`, add fields after `cwd: entry.cwd,`:

```ts
      sessionPath: entry.sessionPath,
      forked: entry.forked,
```

- [ ] **Step 5: Render fork metadata**

In `extensions/subagents/render.ts`, inside `renderSubagentResult`, after:

```ts
    box.addChild(new Text(theme.fg("accent", formatAgentSummary(agent)), 0, 0));
```

insert:

```ts
    if (agent.forked && agent.sessionPath) {
      box.addChild(new Text(theme.fg("dim", `  forked session: ${agent.sessionPath}`), 0, 0));
    }
```

- [ ] **Step 6: Run registry/render tests**

Run:

```bash
npm test -- extensions/subagents/registry.test.ts extensions/subagents/render.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 2**

Run:

```bash
git add extensions/subagents/registry.ts extensions/subagents/registry.test.ts extensions/subagents/render.ts extensions/subagents/render.test.ts
git commit -m "feat: track subagent fork metadata"
```

---

### Task 3: `spawn_agent` explicit `fork_context` creates cloned session

**Files:**
- Modify: `extensions/subagents/tools.ts`
- Modify: `extensions/subagents/tools.test.ts`
- Modify: `extensions/subagents/index.ts`

- [ ] **Step 1: Write failing tests for default ordinary spawn and fork spawn**

In `extensions/subagents/tools.test.ts`, update imports:

```ts
import type { RpcClient, RpcResponse, SubagentRpcFactory, SubagentSessionForker } from "./types.js";
```

Add helper:

```ts
function makeForkableCtx(overrides: Record<string, unknown> = {}) {
  return {
    ...makeCtx(),
    sessionManager: {
      getSessionFile: vi.fn(() => "/parent/session.jsonl"),
      getSessionDir: vi.fn(() => "/parent"),
      getLeafId: vi.fn(() => "leaf_1"),
    },
    ...overrides,
  } as any;
}
```

In the first test `spawn_agent creates a running entry and sends prompt`, after the execute call, add:

```ts
    expect((factory.spawn as any).mock.calls[0][0]).toMatchObject({ sessionPath: undefined, forked: false });
```

Add a new test:

```ts
  it("spawn_agent forks parent session only when fork_context is true", async () => {
    const registry = new SubagentRegistry({ ...options });
    const forkSession: SubagentSessionForker = vi.fn(() => "/parent/forked-subagent.jsonl");
    const spawned: any[] = [];
    const factory: SubagentRpcFactory = {
      spawn: vi.fn((input) => {
        spawned.push(input);
        return makeRpcClient("agent_1", input.taskName);
      }),
    };
    const tools = createSubagentTools(registry, factory, { forkSession });
    const spawnTool = tools.find((tool) => tool.name === "spawn_agent")!;

    const result = await spawnTool.execute(
      "call_1",
      { task_name: "worker", message: "Use current context", fork_context: true },
      undefined,
      undefined,
      makeForkableCtx(),
    );

    expect(forkSession).toHaveBeenCalledWith({
      sessionFile: "/parent/session.jsonl",
      sessionDir: "/parent",
      leafId: "leaf_1",
    });
    expect(spawned[0]).toMatchObject({ sessionPath: "/parent/forked-subagent.jsonl", forked: true });
    expect(registry.resolve("worker")).toMatchObject({ sessionPath: "/parent/forked-subagent.jsonl", forked: true });
    expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("forked session");
  });
```

Add error tests:

```ts
  it("spawn_agent returns an error when fork_context has no parent session file", async () => {
    const registry = new SubagentRegistry({ ...options });
    const factory: SubagentRpcFactory = { spawn: vi.fn((input) => makeRpcClient("agent_1", input.taskName)) };
    const tools = createSubagentTools(registry, factory, { forkSession: vi.fn() });
    const spawnTool = tools.find((tool) => tool.name === "spawn_agent")!;

    const result = await spawnTool.execute(
      "call_1",
      { task_name: "worker", message: "Use current context", fork_context: true },
      undefined,
      undefined,
      makeForkableCtx({ sessionManager: { getSessionFile: () => undefined, getSessionDir: () => "/parent", getLeafId: () => "leaf_1" } }),
    );

    expect(factory.spawn).not.toHaveBeenCalled();
    expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("requires a persisted parent session");
  });

  it("spawn_agent returns an error when fork_context has no leaf entry", async () => {
    const registry = new SubagentRegistry({ ...options });
    const factory: SubagentRpcFactory = { spawn: vi.fn((input) => makeRpcClient("agent_1", input.taskName)) };
    const tools = createSubagentTools(registry, factory, { forkSession: vi.fn() });
    const spawnTool = tools.find((tool) => tool.name === "spawn_agent")!;

    const result = await spawnTool.execute(
      "call_1",
      { task_name: "worker", message: "Use current context", fork_context: true },
      undefined,
      undefined,
      makeForkableCtx({ sessionManager: { getSessionFile: () => "/parent/session.jsonl", getSessionDir: () => "/parent", getLeafId: () => null } }),
    );

    expect(factory.spawn).not.toHaveBeenCalled();
    expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("requires a current parent session entry");
  });
```

- [ ] **Step 2: Run failing tools tests**

Run:

```bash
npm test -- extensions/subagents/tools.test.ts
```

Expected: FAIL because `fork_context`, `SubagentSessionForker`, and dependency injection do not exist.

- [ ] **Step 3: Add fork helper types**

In `extensions/subagents/types.ts`, add after `SubagentRpcFactory`:

```ts
export interface SubagentSessionForkInput {
  sessionFile: string;
  sessionDir: string;
  leafId: string;
}

export type SubagentSessionForker = (input: SubagentSessionForkInput) => string | undefined;
```

- [ ] **Step 4: Implement default fork helper**

In `extensions/subagents/tools.ts`, update imports:

```ts
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { RpcClient, SubagentRpcFactory, SubagentSessionForker, SubagentSummary, SubagentToolDetails } from "./types.js";
```

Add below `const clients = new Map<string, RpcClient>();`:

```ts
export interface CreateSubagentToolsOptions {
  forkSession?: SubagentSessionForker;
}

const FORK_CONTEXT_GUIDELINE =
  "Only set spawn_agent.fork_context to true when the user explicitly asks for a forked/cloned/current-context subagent. Omit it for normal independent subagents.";

export const defaultForkSession: SubagentSessionForker = ({ sessionFile, sessionDir, leafId }) => {
  const sourceManager = SessionManager.open(sessionFile, sessionDir);
  return sourceManager.createBranchedSession(leafId);
};
```

- [ ] **Step 5: Add `fork_context` schema and prompt guideline**

In `SpawnAgentParams`, add field:

```ts
  fork_context: Type.Optional(Type.Boolean({
    description: "When true, clone the current parent session and start the subagent from that cloned context. Only set this when the user explicitly asks for a forked/cloned/current-context subagent. Omit or set false for normal independent subagents.",
  })),
```

In the `spawn_agent` tool definition, add or extend `promptGuidelines`:

```ts
      promptGuidelines: [FORK_CONTEXT_GUIDELINE],
```

Keep existing `promptSnippet` unchanged.

- [ ] **Step 6: Update `createSubagentTools` signature**

Change function signature to:

```ts
export function createSubagentTools(
  registry: SubagentRegistry,
  rpcFactory: SubagentRpcFactory,
  options: CreateSubagentToolsOptions = {},
): ToolDefinition<any, SubagentToolDetails>[] {
  const forkSession = options.forkSession ?? defaultForkSession;
```

Ensure the returned array remains inside this function after the new `forkSession` line.

- [ ] **Step 7: Implement fork resolution inside spawn execute**

In `spawn_agent` execute, change params type to include `fork_context`:

```ts
        const params = rawParams as { task_name: string; message: string; model?: string; cwd?: string; fork_context?: boolean };
```

Before `registry.createEntry`, insert:

```ts
        const forked = params.fork_context === true;
        const sessionPath = forked ? createForkedSession(ctx, forkSession) : undefined;
        if (forked && typeof sessionPath !== "string") {
          return errorResult("spawn", sessionPathToErrorText(sessionPath), registry.list());
        }
```

Do not keep this exact snippet if TypeScript complains that `sessionPath` cannot be non-string; use the helper below instead.

Add helper functions near `sendToTarget`:

```ts
function resolveForkedSession(ctx: ExtensionContext, forkSession: SubagentSessionForker): { sessionPath?: string; error?: string } {
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) {
    return { error: "spawn_agent fork_context requires a persisted parent session; omit fork_context for a normal subagent." };
  }
  const leafId = ctx.sessionManager.getLeafId();
  if (!leafId) {
    return { error: "spawn_agent fork_context requires a current parent session entry; omit fork_context for a normal subagent." };
  }
  const sessionDir = ctx.sessionManager.getSessionDir();
  const sessionPath = forkSession({ sessionFile, sessionDir, leafId });
  if (!sessionPath) {
    return { error: "failed to create forked subagent session." };
  }
  return { sessionPath };
}
```

Then in execute use:

```ts
        const forked = params.fork_context === true;
        const forkResult = forked ? resolveForkedSession(ctx, forkSession) : {};
        if (forkResult.error) return errorResult("spawn", forkResult.error, registry.list());
        const sessionPath = forkResult.sessionPath;
        const entry = registry.createEntry({ taskName, cwd, sessionPath, forked });
        const client = rpcFactory.spawn({ taskName, message, cwd, model: params.model, sessionPath, forked });
```

Replace the existing `registry.createEntry({ taskName, cwd });` and `rpcFactory.spawn({ taskName, message, cwd, model: params.model });` lines with the lines above.

Change the final ok text to mention forked session only when present:

```ts
        const suffix = sessionPath ? ` (forked session: ${sessionPath})` : "";
        return okResult("spawn", `Spawned ${taskName}${suffix}: ${previewText(message, 160)}`, registry.list(), taskName);
```

- [ ] **Step 8: Pass sessionPath into real RPC factory**

In `extensions/subagents/index.ts`, change:

```ts
      const proc = spawnRpcProcess(input.cwd, input.model);
```

to:

```ts
      const proc = spawnRpcProcess(input.cwd, input.model, input.sessionPath);
```

- [ ] **Step 9: Run tools tests**

Run:

```bash
npm test -- extensions/subagents/tools.test.ts
```

Expected: PASS.

- [ ] **Step 10: Commit Task 3**

Run:

```bash
git add extensions/subagents/tools.ts extensions/subagents/tools.test.ts extensions/subagents/index.ts extensions/subagents/types.ts
git commit -m "feat: add explicit subagent session fork"
```

---

### Task 4: Documentation and full verification

**Files:**
- Modify: `README.md`
- Optional modify: `AGENTS.md` only if project guidance must mention the new subagent fork behavior; otherwise leave it unchanged.

- [ ] **Step 1: Update README subagent section**

In `README.md`, under `## Subagent 工具`, update the `spawn_agent` bullet to:

```md
- `spawn_agent` 启动一个后台 `pi --mode rpc --no-session` 子 agent，并立即返回任务名和状态。默认不继承主 agent 会话上下文。只有当工具调用显式传入 `fork_context: true` 时，扩展会 clone 当前 Pi session 的 active branch，并用 `pi --mode rpc --session <forked-session>` 启动子 agent。
```

Add this paragraph after the tool list:

```md
`fork_context` 是显式 opt-in。模型不应因为任务复杂或需要并行分析就自动启用它；只有当用户明确要求 fork、clone、继承当前完整上下文，或让 subagent 使用当前会话上下文时才应设置为 `true`。如果当前主会话没有持久化 session 文件，fork 模式会报错；普通模式仍可使用。
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

Expected: no TypeScript errors.

- [ ] **Step 4: Inspect git diff**

Run:

```bash
git diff --stat && git diff -- README.md extensions/subagents
```

Expected: diff only contains planned subagent fork changes and docs.

- [ ] **Step 5: Commit Task 4**

Run:

```bash
git add README.md extensions/subagents
git commit -m "docs: document subagent fork context"
```

---

## Self-Review

- Spec coverage: The plan implements default ordinary spawn, explicit `fork_context`, session clone using `SessionManager.createBranchedSession`, `--session` child startup, registry metadata, error handling, tests, and README documentation.
- Placeholder scan: No task relies on unspecified implementation. Code snippets provide exact functions, fields, and commands.
- Type consistency: `sessionPath` and `forked` are consistently used across `SpawnSubagentInput`, `CreateEntryInput`, `SubagentEntry`, `SubagentSummary`, registry, RPC factory, and tools.
