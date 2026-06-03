# D1 — InProcessTeammate Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement core team-of-agents primitives — Team / Teammate spawn / Mailbox / Shutdown handshake / Reload hydration / TUI widget. Defers team task list, plan-mode approval, permission sync, and TUI view-swap to D2.

**Architecture:** New `extensions/teammate/` extension with:
- AsyncLocalStorage-isolated long-lived AgentSessions (one per teammate)
- In-memory Mailbox for same-process message routing
- Session jsonl `customMessage{customType:"teammate/event"}` derivation for persistence
- Reload via `SessionManager.open(<teammate's-jsonl>)` for transparent recovery
- `task_agent` extension routes to `spawnTeammate` when `team_name` + `name` are passed

**Tech Stack:** TypeScript ESM, Vitest, `@earendil-works/pi-coding-agent` SDK, `node:async_hooks`.

**Spec:** `docs/superpowers/specs/2026-06-03-d1-teammate-core-design.md`

**Pre-validated risks (spike at extensions/spike-als-teammate, deleted):**
1. ✅ `AsyncLocalStorage` context survives session.subscribe callbacks AND prompt() awaits.
2. ✅ `SessionManager.open(file)` re-opens a written jsonl and `prompt()` continues the conversation (entries:4 → +new turn).
3. ✅ `SessionManager.create(cwd, sessionDir)` is the right factory for new isolated teammate sessions (verified in SDK d.ts).

---

## File Structure

**New files** under `extensions/teammate/`:
- `package.json` — `pi-teammate-extension`
- `index.ts` — extension entrypoint
- `types.ts` — TeammateIdentity / InProcessTeammateTaskState / TeamState / MailboxMessage / TeammateEvent
- `als.ts` — `runAsTeammate` / `getCurrentTeammate` / `_resetForTest`
- `teamStore.ts` — in-memory team registry with subscribe
- `handle.ts` — cross-extension `getTeammateHandle(pi)` (mirror tasks/handle.ts)
- `jsonlEvents.ts` — TeammateEvent definitions + reducer
- `eventEmit.ts` — `emitTeammateEvent(pi, event)` writes via sendMessage(triggerTurn:false)
- `eventFilter.ts` — `installTeammateEventContextFilter(pi)` (filter from LLM context)
- `mailbox.ts` — Mailbox class
- `teammateLoop.ts` — turn loop driving prompt → idle → wait → prompt
- `spawnTeammate.ts` — main spawn function
- `killTeammate.ts` — graceful kill + force kill
- `shutdownHandshake.ts` — encode/decode shutdown protocol
- `hydrate.ts` — session_start scan + rebuild
- `tools/teamCreate.ts` — `team_create` tool
- `tools/teamDelete.ts` — `team_delete` tool (cascade kill)
- `tools/sendMessage.ts` — `send_message` tool
- `ui/teamWidget.ts` — `pi.ui.setWidget` renderer

Plus per-file colocated tests (`*.test.ts`).

**Modified files:**
- `extensions/localagent/tools/taskAgent.ts` — extend with `team_name` + `name` route
- `extensions/localagent/tools/taskAgent.test.ts` — assert routing

---

## Phase 0 — Infrastructure (no functionality yet)

### Task 0.1: Create extension scaffold + register empty session_start

**Files:**
- Create: `extensions/teammate/package.json`
- Create: `extensions/teammate/index.ts`
- Create: `extensions/teammate/index.test.ts`

- [ ] **Step 1: Write failing test** — `index.test.ts`

```ts
import { describe, it, expect, vi } from "vitest";
import teammateExtension from "./index.js";

describe("teammateExtension entrypoint", () => {
  it("registers session_start and session_shutdown handlers", () => {
    const handlers = new Map<string, unknown>();
    const pi = {
      on: vi.fn((evt: string, handler: unknown) => handlers.set(evt, handler)),
      events: {},
    } as never;
    teammateExtension(pi);
    expect(handlers.has("session_start")).toBe(true);
    expect(handlers.has("session_shutdown")).toBe(true);
  });
});
```

- [ ] **Step 2: Run** — expect fail (no file)
- [ ] **Step 3: Implement** — minimal `index.ts`:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function teammateExtension(pi: ExtensionAPI): void {
  pi.on("session_start", () => {
    // wired in later tasks
  });
  pi.on("session_shutdown", async () => {
    // wired in later tasks
  });
}
```

`package.json`:
```json
{
  "name": "pi-teammate-extension",
  "version": "0.1.0",
  "type": "module",
  "main": "index.ts",
  "pi": { "extensions": ["index.ts"] },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
    "typebox": "*"
  }
}
```

- [ ] **Step 4: Run** — pass
- [ ] **Step 5: typecheck + full test** — 506 + 1 = 507 passing
- [ ] **Step 6: Commit**

```bash
git commit -m "feat(teammate): extension scaffold (no functionality yet)"
```

---

### Task 0.2: types.ts — all D1 type shapes

**Files:** Create `extensions/teammate/types.ts` + `types.test.ts`

- [ ] **Step 1: Write tests** — assert shape compatibility (compile-time + runtime guards):

```ts
import { describe, it, expect } from "vitest";
import { isInProcessTeammateTask, type InProcessTeammateTaskState } from "./types.js";
import { createTaskStateBase } from "../tasks/Task.js";

describe("isInProcessTeammateTask", () => {
  it("returns true for InProcessTeammateTaskState", () => {
    const t: InProcessTeammateTaskState = {
      ...createTaskStateBase({
        id: "tabc",
        type: "in_process_teammate",
        description: "researcher",
        outputFile: "/tmp/x",
      }),
      type: "in_process_teammate",
      identity: {
        agentId: "researcher@team1",
        agentName: "researcher",
        teamName: "team1",
        agentType: "general-purpose",
      },
      prompt: "find code",
      sessionFile: "/tmp/researcher.jsonl",
      isIdle: false,
      pendingMessages: [],
      shutdownRequested: false,
      shutdownAcknowledged: false,
      toolCallCount: 0,
      tokenCount: 0,
      turnCount: 0,
    };
    expect(isInProcessTeammateTask(t)).toBe(true);
  });

  it("returns false for other task types", () => {
    expect(isInProcessTeammateTask({ type: "local_agent" } as never)).toBe(false);
    expect(isInProcessTeammateTask(null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run** — fail
- [ ] **Step 3: Implement** — full `types.ts` with TeammateIdentity, InProcessTeammateTaskState (extends TaskStateBase), TeamState, MailboxMessage, TeammateEvent (union of 7 kinds per spec § 5.5).
- [ ] **Step 4: Run** — pass
- [ ] **Step 5: typecheck + full test**
- [ ] **Step 6: Commit** — `feat(teammate): add D1 type shapes`

---

### Task 0.3: ALS module

**Files:** Create `als.ts` + `als.test.ts`

- [ ] **Step 1: Tests**
```ts
import { describe, it, expect } from "vitest";
import { runAsTeammate, getCurrentTeammate, _resetForTest } from "./als.js";

describe("AsyncLocalStorage isolation", () => {
  it("getCurrentTeammate returns undefined outside runAsTeammate", () => {
    _resetForTest();
    expect(getCurrentTeammate()).toBeUndefined();
  });

  it("getCurrentTeammate returns identity inside runAsTeammate", () => {
    const id = { agentId: "a@t", agentName: "a", teamName: "t", agentType: "general-purpose" };
    runAsTeammate(id, () => {
      expect(getCurrentTeammate()?.agentName).toBe("a");
    });
  });

  it("survives across awaits and microtasks", async () => {
    const id = { agentId: "x@y", agentName: "x", teamName: "y", agentType: "general-purpose" };
    await new Promise<void>((resolve) => {
      runAsTeammate(id, async () => {
        await Promise.resolve();
        await new Promise((r) => setTimeout(r, 0));
        expect(getCurrentTeammate()?.agentName).toBe("x");
        resolve();
      });
    });
  });

  it("nested runs override correctly", () => {
    const a = { agentId: "a@t", agentName: "a", teamName: "t", agentType: "general-purpose" };
    const b = { agentId: "b@t", agentName: "b", teamName: "t", agentType: "general-purpose" };
    runAsTeammate(a, () => {
      runAsTeammate(b, () => {
        expect(getCurrentTeammate()?.agentName).toBe("b");
      });
      expect(getCurrentTeammate()?.agentName).toBe("a");
    });
  });
});
```

- [ ] **Step 2: Run — fail**
- [ ] **Step 3: Implement**
```ts
import { AsyncLocalStorage } from "node:async_hooks";
import type { TeammateIdentity } from "./types.js";

const storage = new AsyncLocalStorage<TeammateIdentity>();

export function runAsTeammate<T>(identity: TeammateIdentity, fn: () => T): T {
  return storage.run(identity, fn);
}

export function getCurrentTeammate(): TeammateIdentity | undefined {
  return storage.getStore();
}

/** Test only — clear any leaked context between tests. */
export function _resetForTest(): void {
  // ALS doesn't have explicit clear; tests that need it should use runAsTeammate
  // to scope. This export exists for symmetry with other test resets.
}
```

- [ ] **Step 4: Run — pass (4)**
- [ ] **Step 5: typecheck + full**
- [ ] **Step 6: Commit** — `feat(teammate): AsyncLocalStorage identity isolation`

---

### Task 0.4: jsonlEvents — event types + reducer

**Files:** Create `jsonlEvents.ts` + `jsonlEvents.test.ts`

- [ ] **Step 1: Tests** — assert reducer is idempotent and correctly builds final state.

```ts
import { describe, it, expect } from "vitest";
import { reduceTeammateEvents, type TeammateEvent } from "./jsonlEvents.js";

const t1id = { agentId: "r@t1", agentName: "r", teamName: "t1", agentType: "general-purpose" };

describe("reduceTeammateEvents", () => {
  it("rebuilds team + members from event sequence", () => {
    const events: TeammateEvent[] = [
      { kind: "team_create", teamName: "t1", description: "ds" },
      { kind: "teammate_spawn", identity: t1id, sessionFile: "/tmp/r.jsonl", initialPrompt: "go" },
    ];
    const state = reduceTeammateEvents(events);
    expect(state.teams["t1"]).toBeDefined();
    expect(state.teams["t1"]!.memberAgentIds).toEqual(["r@t1"]);
    expect(state.teammates["r@t1"]).toBeDefined();
    expect(state.teammates["r@t1"]!.lastStatus).toBe("running");
  });

  it("teammate_terminal flips status to completed/killed", () => {
    const events: TeammateEvent[] = [
      { kind: "team_create", teamName: "t1" },
      { kind: "teammate_spawn", identity: t1id, sessionFile: "/tmp/r.jsonl", initialPrompt: "x" },
      { kind: "teammate_terminal", agentId: "r@t1", status: "killed" },
    ];
    const state = reduceTeammateEvents(events);
    expect(state.teammates["r@t1"]!.lastStatus).toBe("killed");
  });

  it("team_delete removes team and marks members terminal", () => {
    const events: TeammateEvent[] = [
      { kind: "team_create", teamName: "t1" },
      { kind: "teammate_spawn", identity: t1id, sessionFile: "/tmp/r.jsonl", initialPrompt: "x" },
      { kind: "team_delete", teamName: "t1" },
    ];
    const state = reduceTeammateEvents(events);
    expect(state.teams["t1"]).toBeUndefined();
    expect(state.teammates["r@t1"]!.lastStatus).toBe("killed");
  });

  it("idempotent — same event twice doesn't duplicate", () => {
    const events: TeammateEvent[] = [
      { kind: "team_create", teamName: "t1" },
      { kind: "teammate_spawn", identity: t1id, sessionFile: "/tmp/r.jsonl", initialPrompt: "x" },
      { kind: "teammate_spawn", identity: t1id, sessionFile: "/tmp/r.jsonl", initialPrompt: "x" },
    ];
    const state = reduceTeammateEvents(events);
    expect(state.teams["t1"]!.memberAgentIds).toEqual(["r@t1"]);
  });
});
```

- [ ] **Step 2: Run — fail**
- [ ] **Step 3: Implement** — TeammateEvent union, `reduceTeammateEvents(events) → { teams, teammates }`. Reducer is pure / idempotent / handles unknown kind defensively.
- [ ] **Step 4: Pass**
- [ ] **Step 5: typecheck + full**
- [ ] **Step 6: Commit** — `feat(teammate): jsonlEvents types + reducer`

---

### Task 0.5: teamStore — in-memory team registry with subscribe

**Files:** Create `teamStore.ts` + `teamStore.test.ts`

> Mirror pattern of `extensions/tasks/taskStore.ts` — Map-based with subscribe/get/set.

- [ ] Tests: createTeamStore() returns a store with createTeam/getTeam/listTeams/deleteTeam/subscribe — assert subscribe fires on mutate, not on no-op.
- [ ] Implement.
- [ ] typecheck + full
- [ ] Commit — `feat(teammate): in-memory team registry`

---

### Task 0.6: eventEmit + eventFilter (LLM context)

**Files:** Create `eventEmit.ts`, `eventFilter.ts`, `eventEmit.test.ts`

- [ ] Tests:
  - `emitTeammateEvent` calls `pi.sendMessage` with `customType:"teammate/event", display:false, triggerTurn:false`
  - Defensive try/catch swallows sendMessage failures
  - `installTeammateEventContextFilter(pi)` registers `pi.on("context")` handler that filters role=custom + customType="teammate/event"
- [ ] Implement (mirror `extensions/tasks/progress.ts` pattern).
- [ ] Wire into `index.ts`: `installTeammateEventContextFilter(pi)` in body.
- [ ] typecheck + full
- [ ] Commit — `feat(teammate): jsonl event emit + LLM context filter`

---

## Phase 1 — Mailbox

### Task 1.1: Mailbox class

**Files:** Create `mailbox.ts` + `mailbox.test.ts`

- [ ] Tests:
  - send to online receiver → immediate dispatch
  - send to offline → buffered; on `registerReceiver` flush
  - broadcast `to:"*"` fans out to all receivers
  - unsubscribe (returned by registerReceiver) removes the entry
  - sender's own name excluded from `*` (avoid loop)
- [ ] Implement (per spec § 5.3).
- [ ] typecheck + full
- [ ] Commit — `feat(teammate): in-memory mailbox`

---

### Task 1.2: Wire mailbox singleton + handle

**Files:**
- Modify `index.ts` — create singleton mailbox + teamStore, attach to handle on `pi.events`
- Create `handle.ts` — `getTeammateHandle(pi)` (mirror `extensions/tasks/handle.ts`)
- `handle.test.ts`

- [ ] Tests: getTeammateHandle returns the same {teamStore, mailbox} attached during session_start.
- [ ] Implement.
- [ ] typecheck + full
- [ ] Commit — `feat(teammate): cross-extension handle (teamStore + mailbox)`

---

## Phase 2 — Spawn + Loop

### Task 2.1: shutdownHandshake encode/decode

**Files:** Create `shutdownHandshake.ts` + `.test.ts`

- [ ] Tests:
  - `parseShutdownRequest(content)` returns `{requestId}` for valid `{type:"shutdown_request",request_id}` JSON; undefined otherwise
  - `parseShutdownResponse(content)` mirrors
  - `buildShutdownRequest(requestId)` / `buildShutdownResponse(requestId, approve, feedback?)` produce JSON-string round-trippable
- [ ] Implement.
- [ ] typecheck + full
- [ ] Commit — `feat(teammate): shutdown handshake protocol`

---

### Task 2.2: teammateLoop — core idle loop

**Files:** Create `teammateLoop.ts` + `.test.ts`

- [ ] Tests using fake AgentSession + fake Mailbox:
  - initial prompt fired; agent_end → enter idle
  - after idle, mailbox delivers a message → loop fires `session.prompt(formatted)`
  - on shutdown_request received + acknowledged → loop exits cleanly
  - kill abort → loop exits without further prompts
- [ ] Implement (per spec § 5.4):
  ```ts
  startTeammateLoop({
    identity,
    initialPrompt,
    session,
    mailbox,
    onIdle,
    onTurnStart,
    onTerminal,
    abortSignal,
  })
  ```
  Wraps each turn in `runAsTeammate(identity, ...)`. Handles shutdown handshake parse before deciding to dispatch as user message.
- [ ] typecheck + full
- [ ] Commit — `feat(teammate): teammate idle/turn loop`

---

### Task 2.3: spawnTeammate — orchestration

**Files:** Create `spawnTeammate.ts` + `.test.ts`

> SDK injection pattern (mirror `spawnLocalAgent.ts:_setSdkForTest`) for test isolation.

- [ ] Tests:
  - new spawn:
    - calls `SessionManager.create(cwd, sessionDir)` — sessionDir uses `~/.pi/agent/teammates/<sanitized-team>/<sanitized-agent>/`
    - registers task in TaskStore
    - emits `teammate_spawn` event
    - registers receiver on mailbox
    - starts teammateLoop
    - returns `{taskId, agentId, sessionFile}`
  - duplicate `agentId` (same name in same team) → error
  - parent team doesn't exist → error
- [ ] Implement.
- [ ] typecheck + full
- [ ] Commit — `feat(teammate): spawn long-lived teammate`

---

### Task 2.4: killTeammate — graceful + force

**Files:** Create `killTeammate.ts` + `.test.ts`

> Sequence (mirror `extensions/localagent/kill.ts`):
> 1. status flip → "killed"
> 2. session.abort()
> 3. cleanup() (unsubscribe)
> 4. session.dispose()
> 5. mailbox unregister
> 6. emit `teammate_terminal` event
> 7. removeTeammateFromTeam in store
> 8. eviction

- [ ] Tests:
  - graceful (handshake-acked) path: status flip + dispose + emit terminal
  - force (no handshake): same sequence works without handshake state
  - already-terminal task → no-op
- [ ] Implement.
- [ ] typecheck + full
- [ ] Commit — `feat(teammate): kill teammate (graceful + force)`

---

## Phase 3 — Tools (LLM-facing)

### Task 3.1: team_create tool

**Files:** Create `tools/teamCreate.ts` + `.test.ts`

- [ ] Tests:
  - calling with valid `team_name` creates entry in teamStore + emits `team_create` event
  - duplicate team_name returns isError
  - team_name validation (non-empty, sanitizable)
- [ ] Implement (Type schema from typebox; description text instructs LLM).
- [ ] Wire into `index.ts` session_start.
- [ ] typecheck + full
- [ ] Commit — `feat(teammate): team_create tool`

---

### Task 3.2: send_message tool

**Files:** Create `tools/sendMessage.ts` + `.test.ts`

- [ ] Tests:
  - `to: "alpha"` → mailbox.send delivers MailboxMessage with `from = currentTeammate.agentName ?? "leader"`
  - `to: "*"` → broadcasts to all teammates in current team (excluding sender)
  - emit `message_sent` event
  - `from = "leader"` when called outside ALS context (i.e., main LLM)
  - protocol JSON message detection: if message.body parses as `{type:"shutdown_request"|"shutdown_response"}`, mark `isProtocol:true`
- [ ] Implement.
- [ ] Wire into `index.ts`.
- [ ] typecheck + full
- [ ] Commit — `feat(teammate): send_message tool`

---

### Task 3.3: team_delete tool (cascade kill)

**Files:** Create `tools/teamDelete.ts` + `.test.ts`

- [ ] Tests:
  - calling on existing team:
    - sends shutdown_request to each member
    - waits up to 5s for ack
    - force-kills any non-acked members
    - removes team from store + emits `team_delete` event
  - calling on non-existent team → isError
  - empty team → just removes team + emits event
- [ ] Implement (timeout configurable for tests).
- [ ] Wire into `index.ts`.
- [ ] typecheck + full
- [ ] Commit — `feat(teammate): team_delete cascade kill`

---

### Task 3.4: Extend task_agent — team_name + name route

**Files:**
- Modify `extensions/localagent/tools/taskAgent.ts`
- Modify `extensions/localagent/tools/taskAgent.test.ts`

- [ ] Tests:
  - `task_agent {team_name:"t", name:"x", subagent_type:"general-purpose", prompt:"hi"}` calls `spawnTeammate` (mock)
  - `task_agent {prompt:"hi"}` (no team) still hits `spawnLocalAgent` (existing behavior)
  - error: `team_name` without `name` → isError "name required when team_name set"
  - error: `team_name` without `team_create` first → isError from spawnTeammate
- [ ] Implement: import getTeammateHandle, branch at top of execute().
- [ ] Update tool description + parameter schema (mention team_name, name).
- [ ] typecheck + full
- [ ] Commit — `feat(localagent): task_agent extends to spawn teammates`

---

## Phase 4 — Hydration (reload)

### Task 4.1: hydrate.ts — scan jsonl + rebuild state

**Files:** Create `hydrate.ts` + `.test.ts`

- [ ] Tests using fake `ctx.sessionManager.getEntries()`:
  - filters entries to customType=`teammate/event`
  - calls `reduceTeammateEvents`
  - returns final state (no spawning yet — just state rebuild)
  - empty jsonl → empty state
- [ ] Implement.
- [ ] typecheck + full
- [ ] Commit — `feat(teammate): hydrate from session jsonl events`

---

### Task 4.2: Hydrate respawn — re-open AgentSession for running teammates

**Files:** Modify `hydrate.ts` + add `.test.ts` cases

- [ ] Tests:
  - state.teammates with `lastStatus === "running"` — call `SessionManager.open(sessionFile)` + spawn loop in `resume:true` mode
  - state.teammates with terminal status → skip
  - serialization: process teammates one at a time (`for await` not `Promise.all`)
- [ ] Implement (with SDK injection for test).
- [ ] typecheck + full
- [ ] Commit — `feat(teammate): hydrate respawns running teammates`

---

### Task 4.3: Wire hydrate into session_start

**Files:** Modify `index.ts` + `index.test.ts`

- [ ] Tests:
  - session_start handler calls hydrate after teamStore + mailbox setup
  - spike test in test file: build a fake jsonl with `team_create + teammate_spawn` events, fire session_start, assert teamStore has team and SessionManager.open mock was called
- [ ] Implement.
- [ ] typecheck + full
- [ ] Commit — `feat(teammate): hydrate on session_start`

---

## Phase 5 — TUI Widget

### Task 5.1: teamWidget — render team status as setWidget

**Files:** Create `ui/teamWidget.ts` + `.test.ts`

> Width-aware text rendering. Format per spec § 6.

- [ ] Tests:
  - `renderTeamWidget(teams, teammates)` returns array of strings
  - shows ▶ teamName + member count
  - per member: glyph (◌ idle | ● running) + name + last activity + counters
  - empty teams → returns `[]` (no widget shown)
  - long agent name truncates to fit width
- [ ] Implement (returns string[]; index.ts will wrap with setWidget call).
- [ ] typecheck + full
- [ ] Commit — `feat(teammate): TUI widget renderer`

---

### Task 5.2: Wire widget refresh on store changes

**Files:** Modify `index.ts`

- [ ] In session_start, after handle setup:
  ```ts
  let unsubAll: () => void = () => {};
  pi.on("session_start", (_e, ctx) => {
    // ... existing setup ...
    if (ctx.hasUI) {
      const refresh = () => {
        const lines = renderTeamWidget(teamStore.list(), getAllTeammateTasks(taskStore));
        if (lines.length === 0) ctx.ui.setWidget("teammate-team", undefined);
        else ctx.ui.setWidget("teammate-team", lines, { placement: "belowEditor" });
      };
      const u1 = teamStore.subscribe(refresh);
      const u2 = taskStore.subscribe(refresh);
      unsubAll = () => { u1(); u2(); };
      refresh();
    }
  });
  pi.on("session_shutdown", () => { unsubAll(); /* ... */ });
  ```
- [ ] Test: emit a team_create through the entrypoint and assert ctx.ui.setWidget was called with non-empty content.
- [ ] typecheck + full
- [ ] Commit — `feat(teammate): live widget on team/teammate changes`

---

## Phase 6 — Integration + cleanup

### Task 6.1: shutdown handshake integration in send_message + teammateLoop

**Files:** Modify `tools/sendMessage.ts` + `teammateLoop.ts`

- [ ] When sendMessage detects protocol body — emit `shutdown_request` event AND deliver via mailbox.
- [ ] When teammateLoop receives a `shutdown_request` — instead of regular prompt, call shutdown logic (teammate-side ack).
- [ ] When leader receives `shutdown_response` (in their own listener) → callback for waiting team_delete or for graceful task_kill.
- [ ] Tests: full handshake path (leader → teammate → ack → loop exits cleanly + emits teammate_terminal).
- [ ] typecheck + full
- [ ] Commit — `feat(teammate): wire shutdown handshake end-to-end`

---

### Task 6.2: session_shutdown — clean kill all teammates

**Files:** Modify `index.ts` + `index.test.ts`

- [ ] On session_shutdown:
  - for each running teammate task → killTeammate(force=true)
  - clear teamStore
  - Promise.all — they're independent kills
- [ ] Test: spawn 2 teammates (mock) + fire session_shutdown → both killed + emit terminal events.
- [ ] typecheck + full
- [ ] Commit — `feat(teammate): cleanup on session_shutdown`

---

### Task 6.3: End-to-end real LLM verification + spec close-out

**Files:**
- Modify `docs/superpowers/specs/2026-06-03-d1-teammate-core-design.md` — add Verification section with results

- [ ] Manual TUI test:
  ```bash
  pi --no-extensions -e .
  > use team_create to make a team called "research"
  > use task_agent with team_name="research", name="alice", subagent_type="explore", prompt="explore the codebase briefly and come back idle"
  > send_message to alice asking to count files in extensions/
  > # observe widget shows alice running, then idle, with token counts
  > # send_message to alice with shutdown_request JSON; verify she acks and disappears
  ```
- [ ] Reload test:
  ```bash
  # spawn a teammate, send a message, then `kill -9 <pi pid>`
  # restart pi with same session — assert widget shows the teammate already idle
  # send_message to it again, verify it picks up
  ```
- [ ] Update spec § 11 verification with actual numbers.
- [ ] **Final code review**: dispatch a code-reviewer subagent on entire D1 diff.
- [ ] Commit — `docs(d1): close out spec with real-LLM verification`

---

## Verification

Per-phase exit criteria:
- [ ] Phase 0 (Tasks 0.1–0.6): infrastructure in place. **~512 tests passing**.
- [ ] Phase 1 (Tasks 1.1–1.2): mailbox primitive complete. **~520**.
- [ ] Phase 2 (Tasks 2.1–2.4): spawn + loop + kill. **~545**.
- [ ] Phase 3 (Tasks 3.1–3.4): tools wired (team_create / send_message / team_delete / task_agent route). **~580**.
- [ ] Phase 4 (Tasks 4.1–4.3): hydration. **~605**.
- [ ] Phase 5 (Tasks 5.1–5.2): TUI widget. **~620**.
- [ ] Phase 6 (Tasks 6.1–6.3): integration + verification. **~635 final**.

Aggregate: D1 adds **~130 new tests**, ~2000 lines prod, ~1500 lines test, all green.

## Risks (post-spike)

| Risk | Status |
|---|---|
| ALS context across subscribe/prompt | ✅ spike-validated |
| SessionManager.open continues conversation | ✅ spike-validated |
| Multi-teammate concurrent rebuild | ✅ design-mitigated (serial in Task 4.2) |
| Mailbox `*` broadcast performance | acceptable (<10 members per spec) |

## Out of Scope (D2)

- team_task_create / update / list / get tools
- plan_mode_approval handshake
- permission sync (leader-centralized prompts)
- TUI view-swap (focus on a teammate's full conversation)
- k-key kill in widget
