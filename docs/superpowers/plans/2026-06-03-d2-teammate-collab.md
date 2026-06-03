# D2 — InProcessTeammate Collaboration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Implement 4 collaboration modules on top of D1: team task list / plan-mode approval / permission sync / TUI view-swap.

**Spec:** `docs/superpowers/specs/2026-06-03-d2-teammate-collab-design.md`

**Architecture:** Extends `extensions/teammate/` with 4 sub-modules. Each module is independently shippable but shares `TeammateHandle`, the protocol pattern, and the jsonl-derived persistence approach from D1.

**Tech Stack:** TypeScript ESM, Vitest, `@earendil-works/pi-coding-agent` SDK, AsyncLocalStorage, in-memory stores.

**Pre-conditions / D1 baseline:**
- 594 tests passing (D1 final)
- `extensions/teammate/` skeleton with handle / mailbox / store / spawn / kill / loop / hydrate / widget all in place
- `extensions/teammate/leaderNotification.ts` with stale-swallow

---

## Phase 0 — Spikes (validate D2-specific assumptions)

These are short investigative scripts that get deleted after their facts are recorded in this plan and the spec. **No commits to non-spike directories during Phase 0** — this is pure research.

### Task 0.1 — Spike permission API

**Goal:** Determine whether `createAgentSessionServices` / `createAgentSessionFromServices` lets us inject or hook a permission decision callback for the sub-session.

**Files (transient):** `extensions/spike-perm/`

- [ ] **Step 1: read SDK type defs**
  - `node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts` — search "permission" and "AgentSessionServices"
  - `node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.d.ts` — same
  - `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.d.ts` — same
  - Note: any `permissionHandler` / `permissionPolicy` / `requirePermission` callback shape

- [ ] **Step 2: build minimal spike**

```ts
// extensions/spike-perm/index.ts
// Goal: spawn a sub-session and try to call a write-tool. See what Pi does
// for permission. Try to override via services config.
import { createAgentSessionServices, createAgentSessionFromServices, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function spike(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "spike_perm",
    description: "Permission API spike",
    parameters: Type.Object({}),
    executionMode: "parallel",
    async execute() {
      const services = await createAgentSessionServices({
        cwd: process.cwd(),
      });
      const sm = SessionManager.create(process.cwd(), "/tmp/spike-perm-session");
      // Inspect services keys
      console.error("services keys:", Object.keys(services as object));
      // Print any permissionPolicy or auth-related properties
      const sChild = await createAgentSessionFromServices({
        services: services as never,
        sessionManager: sm as never,
        tools: ["read", "write"] as never,
      });
      console.error("session keys:", Object.keys(sChild.session as object));
      return { content: [{ type: "text", text: "see stderr" }], details: {} };
    },
  });
}
```

- [ ] **Step 3: run spike**

```bash
mkdir -p extensions/spike-perm
# write the package.json + index.ts above
timeout 60 pi --no-extensions -e extensions/spike-perm -p "Run spike_perm tool." 2>&1 | grep -E "(services keys|session keys|permission)"
```

- [ ] **Step 4: record findings in this file** (replace this Task's content with the discovered API or "N/A: hijacking not supported, fall back to dangerous-skip"). Then `rm -rf extensions/spike-perm`.

**Deliverable:** A 1-2 paragraph note appended to spec § 4 ("permission sync") capturing exact API shape OR confirming fallback path.

### Task 0.2 — Spike UI view-swap APIs

**Goal:** Determine whether `pi.ui.setEditorComponent` + `pi.ui.setWidget` (full overlay) is sufficient to implement claudecode-style view swap.

**Files (transient):** `extensions/spike-uiswap/`

- [ ] **Step 1: read SDK type defs**
  - `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts` — search "setEditorComponent" / "setWidget" / "EditorFactory" / "Component"
  - Note layouts, placement options, focus semantics

- [ ] **Step 2: build minimal spike**

```ts
// extensions/spike-uiswap/index.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function spike(pi: ExtensionAPI): void {
  pi.on("session_start", (_, ctx) => {
    if (!ctx.hasUI) return;
    // Try a "fullscreen overlay" widget
    ctx.ui.setWidget(
      "spike-overlay",
      ["─── overlay test ───", "press / to swap, Esc to exit"],
      { placement: "belowEditor" },
    );
    // Try replacing editor
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      // Need a CustomEditor extension. For spike, see if we get a hook.
      return {
        render() {
          return ["[ custom editor active ]"];
        },
        handleInput(data) {
          // Echo
          console.error("editor input:", data);
        },
        focus() {},
        blur() {},
      } as never;
    });
  });
}
```

- [ ] **Step 3: run spike in TUI mode**

```bash
mkdir -p extensions/spike-uiswap
# write files
pi --no-extensions -e extensions/spike-uiswap
# In TUI: try typing, see if custom editor is called. Press Esc, observe.
```

- [ ] **Step 4: record findings** in spec § 5 — capture API shape used and limitations. Note: if `setEditorComponent` requires a full `CustomEditor` class extending pi-tui's, factor that into the plan. `rm -rf extensions/spike-uiswap`.

**Deliverable:** Updated spec § 5 with concrete implementation strategy + any unsolvable gaps.

---

## Phase A — team_task list (Module A)

### Task A.1 — TeamTask types + reducer extension

**Files:**
- Create: `extensions/teammate/teamTasks/types.ts`
- Create: `extensions/teammate/teamTasks/types.test.ts`
- Modify: `extensions/teammate/types.ts` — extend `TeammateEvent` union with 3 new kinds: `team_task_create | team_task_update | team_task_delete`
- Modify: `extensions/teammate/jsonlEvents.ts` — extend reducer + extend `ReplayedState` to include `teamTasks: Record<string, TeamTask>`
- Modify: `extensions/teammate/jsonlEvents.test.ts` — add cases for the 3 new event kinds

- [ ] **Step 1: Write tests for `TeamTask` shape + isTeamTask guard** (small file). Plus reducer tests asserting create/update/delete idempotency.
- [ ] **Step 2: Run** — fail.
- [ ] **Step 3: Implement types.ts (per spec § 2.1) + extend reducer in jsonlEvents.ts.** Important: reducer treats unknown patches defensively (skip if task not found for update).
- [ ] **Step 4: Run** — pass.
- [ ] **Step 5: typecheck + full test**
- [ ] **Step 6: Commit** — `feat(teammate): TeamTask types + reducer events`

### Task A.2 — TeamTaskStore

**Files:**
- Create: `extensions/teammate/teamTasks/teamTaskStore.ts`
- Create: `extensions/teammate/teamTasks/teamTaskStore.test.ts`

Mirror `teamStore.ts` pattern. API:
```ts
export interface TeamTaskStore {
  get(): Record<string, TeamTask>;
  getTask(id: string): TeamTask | undefined;
  list(filter?: { teamName?: string; status?: TaskStatus; owner?: string }): TeamTask[];
  create(task: TeamTask): TeamTask | undefined;  // undefined if id collision
  update(id: string, patch: Partial<TeamTask>): TeamTask | undefined;
  delete(id: string): boolean;
  subscribe(listener: (snap: Record<string, TeamTask>) => void): () => void;
  _resetForTest(): void;
}
export function createTeamTaskStore(): TeamTaskStore;
```

- [ ] Tests: create/update/delete + filter combinations + subscribe semantics + idempotent no-op (same patch → no listener fire).
- [ ] Implement (immutable snapshot + listener Set, like teamStore).
- [ ] typecheck + full test
- [ ] Commit — `feat(teammate): TeamTaskStore in-memory registry`

### Task A.3 — Wire TeamTaskStore into TeammateHandle

**Files:**
- Modify: `extensions/teammate/handle.ts` — add `teamTaskStore` field
- Modify: `extensions/teammate/handle.test.ts`
- Modify: `extensions/teammate/index.ts` — create singleton + attach via handle
- Modify: `extensions/teammate/index.test.ts`

- [ ] Tests: getTeammateHandle returns handle with all 3 stores (teamStore, mailbox, teamTaskStore).
- [ ] Implement.
- [ ] typecheck + full test
- [ ] Commit — `feat(teammate): expose teamTaskStore via handle`

### Task A.4 — `team_task_create` tool

**Files:**
- Create: `extensions/teammate/teamTasks/tools/teamTaskCreate.ts`
- Create: `extensions/teammate/teamTasks/tools/teamTaskCreate.test.ts`
- Modify: `extensions/teammate/index.ts` — register tool in session_start

Parameters (typebox):
```ts
Type.Object({
  team_name: Type.Optional(Type.String({...})),  // defaults to ALS teammateCtx.teamName, errors if neither
  subject: Type.String({...}),
  description: Type.Optional(Type.String({...})),
  blocked_by: Type.Optional(Type.Array(Type.String({...}))),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
})
```

Behavior:
- Resolve teamName: param > ALS teammate ctx > error
- Generate task id: `tt-` + 8-char random
- Build TeamTask with createdAt/updatedAt = now, status = "pending"
- emitTeammateEvent({kind:"team_task_create", task})
- handle.teamTaskStore.create(task)
- Return success with task in details

- [ ] Tests: 6+ — happy path / id uniqueness / error on missing teamName / blocked_by validation / event emission / ALS-derived team
- [ ] Implement. Description text guides LLM ("use to dispatch work to teammates...").
- [ ] Wire into index.ts.
- [ ] typecheck + full test
- [ ] Commit — `feat(teammate): team_task_create tool`

### Task A.5 — `team_task_update` tool

Similar shape. Allowed fields to update: `subject? / description? / status? / owner? / blocked_by? / metadata?`. Also auto-stamp `updatedAt`.

Note: validate `status` enum, `owner` non-empty if set.

- [ ] Tests: full lifecycle (pending → in_progress → completed), set/clear owner, append blockedBy, error on unknown task_id.
- [ ] Implement + wire.
- [ ] Commit — `feat(teammate): team_task_update tool`

### Task A.6 — `team_task_list` tool

Filter parameters: `team_name? / status? / owner?`. Default ordering: id ascending (creation order). Resolve `blockedBy` chain — return tasks in dependency-order if status is pending (oldest unblocked first).

- [ ] Tests: filter combinations + dependency ordering + empty result.
- [ ] Implement + wire.
- [ ] Commit — `feat(teammate): team_task_list tool`

### Task A.7 — `team_task_get` tool

Trivial — by id. Returns full task or isError.

- [ ] Tests: happy + missing.
- [ ] Implement + wire.
- [ ] Commit — `feat(teammate): team_task_get tool`

### Task A.8 — Hydrate replays team tasks

**Files:**
- Modify: `extensions/teammate/hydrate.ts` — extend `hydrateTeammateState` callers + `respawnTeammates` to also push tasks into the new store
- Modify: `extensions/teammate/hydrate.test.ts`

- [ ] Tests: scan jsonl entries containing 3 task events → state.teamTasks populated correctly + handle.teamTaskStore reflects after hydrate wiring.
- [ ] Implement (hydrate.ts: after `hydrateTeammateState`, call `handle.teamTaskStore.create(task)` for each replayed task).
- [ ] typecheck + full test
- [ ] Commit — `feat(teammate): hydrate replays team_task events`

---

## Phase B — plan-mode approval handshake (Module B)

### Task B.1 — Refactor `shutdownHandshake.ts` → `protocol.ts`

**Files:**
- Move: `extensions/teammate/shutdownHandshake.ts` → `extensions/teammate/protocol.ts`
- Move: `extensions/teammate/shutdownHandshake.test.ts` → `extensions/teammate/protocol.test.ts`
- Update all imports across the project (search `from ".*shutdownHandshake.js"`)

Rename module-level export to keep code working:
- Existing: `parseShutdownRequest` / `parseShutdownResponse` / `buildShutdownRequest` / `buildShutdownResponse` / `detectShutdownProtocol`
- Add: `parsePlanApprovalRequest` / `parsePlanApprovalResponse` / `buildPlanApprovalRequest` / `buildPlanApprovalResponse`
- Generalize: `detectProtocol(body)` returns `"shutdown_request" | "shutdown_response" | "plan_approval_request" | "plan_approval_response" | undefined`
- Keep `detectShutdownProtocol` alias for backward compat (re-export)

- [ ] Tests: existing shutdown tests still pass + new plan_approval tests + detectProtocol union test.
- [ ] Implement.
- [ ] Update import sites. typecheck must be clean.
- [ ] Commit — `refactor(teammate): unify protocol module + add plan_approval`

### Task B.2 — `request_plan_approval` tool (teammate-side only)

**Files:**
- Create: `extensions/teammate/tools/requestPlanApproval.ts`
- Create: `extensions/teammate/tools/requestPlanApproval.test.ts`
- Modify: `extensions/teammate/spawnTeammate.ts` — register a per-session pending-plan-approval map; expose getter via TeammateHandle or via spawn-time closure
- Modify: `extensions/teammate/teammateLoop.ts` — protocol routing for `plan_approval_response` resolves the pending map entry

Behavior:
1. ALS guard: caller must be a teammate (`getCurrentTeammate()` defined). Else isError.
2. Generate request_id.
3. Build `buildPlanApprovalRequest(request_id, plan)` body.
4. Send via mailbox to "leader" (similar to send_message logic) + emit jsonl event.
5. Register a Promise into the per-teammate `pendingPlanApprovals` map.
6. `await` the Promise → resolves on plan_approval_response.
7. Return:
   - approve:true → `{content:[{type:"text",text:"Plan approved" + (feedback ? " — " + feedback : "")}]}`
   - approve:false → `{content:[{type:"text",text:"Plan rejected" + (feedback ? ": " + feedback : "")}], isError:true}`
8. **Reload caveat**: if the teammate's session reloads while a request is pending, the Promise is lost — the next time the teammate runs, this tool will be called again (the LLM will likely retry from the new turn).

- [ ] Tests: 6+ — sent via mailbox + protocol detected + approve resolves + reject rejects + reload-pending-loss behavior + ALS-required guard.
- [ ] Implement. The pending map is per-teammate, so it should live on the teammate task state OR a closure inside startTeammateLoop that's accessible via a side-channel.

  **Recommended approach**: extend `InProcessTeammateTaskState` with `pendingPlanApprovals?: Map<string, {resolve, reject}>`. The `request_plan_approval` tool uses `getCurrentTeammate()` to find the teammate's task in TaskStore and accesses this map. teammateLoop's protocol router reads the same map.

- [ ] Wire into index.ts.
- [ ] typecheck + full test
- [ ] Commit — `feat(teammate): request_plan_approval tool + loop routing`

### Task B.3 — `team_plan_approve` leader-side wrapper

**Files:**
- Create: `extensions/teammate/tools/teamPlanApprove.ts`
- Create: `extensions/teammate/tools/teamPlanApprove.test.ts`

Parameters:
```ts
Type.Object({
  teammate: Type.String({...}),  // "alice" or "alice@research"
  request_id: Type.String({...}),
  approve: Type.Boolean({...}),
  feedback: Type.Optional(Type.String({...})),
})
```

Behavior: thin wrapper over `send_message {to:<teammate>, message: buildPlanApprovalResponse(request_id, approve, feedback)}`. Mostly LLM-friendly description.

- [ ] Tests: 4 — wrapper invokes send_message with correct body / approve true & false / feedback included.
- [ ] Implement.
- [ ] Wire into index.ts.
- [ ] typecheck + full test
- [ ] Commit — `feat(teammate): team_plan_approve leader-side wrapper`

### Task B.4 — Loop protocol routing for plan_approval_response

**Files:**
- Modify: `extensions/teammate/teammateLoop.ts` — already routes shutdown_request; add a branch for plan_approval_response that resolves the pending map entry
- Modify: `extensions/teammate/teammateLoop.test.ts`

- [ ] Tests: send a fake plan_approval_response into the loop → pending map promise resolves with {approve, feedback}.
- [ ] Implement.
- [ ] typecheck + full test
- [ ] Commit — `feat(teammate): loop routes plan_approval_response`

---

## Phase C — Permission sync (Module C)

**Pre-condition:** Phase 0 Task 0.1 has determined whether Pi exposes a permission hook.

### Task C.1 — Conditional path

Two options based on spike result:

**Option C-A (Pi exposes a hook):**

#### Task C.1-A — Permission bridge

- Files: `extensions/teammate/permissionBridge.ts` + test
- The bridge intercepts permission requests in the teammate's services layer, sends `permission_request` via mailbox to leader, awaits `permission_response`, returns decision.
- Modify `spawnTeammate.ts` — wire bridge into services creation
- Modify `teammateLoop.ts` — protocol routing for `permission_response`
- Add `team_permission_grant` leader-side wrapper tool

Tests + implement + wire + commit.

**Option C-B (Pi does not expose hook — fallback):**

#### Task C.1-B — Dangerous-skip + prompt guidance

- spawnTeammate.ts: when creating sub-session, set whatever flag/option puts it in dangerous-skip mode (Pi may have a `--dangerously-skip-permissions` flag we can mirror at the SDK level).
- Update teammate's initial prompt boilerplate (in spawnTeammate.ts when crafting initialPrompt) to include "You are in autonomous mode. Apply your best judgment for permission-sensitive actions; the team leader has pre-approved sandboxed work."
- Document explicitly in spec § 4 that permission sync is degraded for D2.

This is a 1-Task-equivalent deliverable, simpler than C-A.

**Decision: pick A or B based on spike.**

- [ ] Run Phase 0 Task 0.1 (already done if Phase 0 finished).
- [ ] Pick A or B. Implement.
- [ ] Tests + commit.

---

## Phase D — TUI view-swap (Module D)

**Pre-condition:** Phase 0 Task 0.2 spike determined feasibility.

### Task D.1 — Selection state + keyboard handler

**Files:**
- Create: `extensions/teammate/ui/viewState.ts` — module-level state: `currentSelectedTeammate?: string` + `viewMode: "leader" | "teammate-focused"`
- Create: `extensions/teammate/ui/viewState.test.ts`

In-memory state with subscribe pattern. APIs: `setSelected(agentId)` / `setViewMode(mode)` / `getState()` / `subscribe(listener)`.

- [ ] Tests: state transitions + listener fires on change + listener does not fire on no-op.
- [ ] Implement.
- [ ] Commit — `feat(teammate): UI selection state`

### Task D.2 — Widget shows selected teammate (highlight)

**Files:**
- Modify: `extensions/teammate/ui/teamWidget.ts` — accept `selectedAgentId?` parameter, render highlighted (use brackets or distinct glyph)
- Modify: `extensions/teammate/ui/teamWidget.test.ts` — assert selected line has highlight marker
- Modify: `extensions/teammate/index.ts` — refresh function reads viewState too

- [ ] Tests: selectedAgentId present → that line is rendered differently from others.
- [ ] Implement.
- [ ] Commit — `feat(teammate): widget highlights selected teammate`

### Task D.3 — Keyboard input handler

**Files:**
- Create: `extensions/teammate/ui/keybindings.ts`
- Create: `extensions/teammate/ui/keybindings.test.ts`
- Modify: `extensions/teammate/index.ts` — register `pi.ui.onTerminalInput(handler)` in session_start when `ctx.hasUI`

Behavior:
- `Tab` or `↓` (in leader view): cycle selectedAgentId forward through team members
- `↑`: cycle backward
- `Enter` (with selected): swap to teammate-focused view
- `Enter` (in teammate-focused): swap back to leader view
- `k` (in leader view, with selected): kill that teammate (call InProcessTeammateTask.kill)
- `Esc` (in leader view): deselect
- All other keys: pass through to default editor

- [ ] Tests: each binding fires its action correctly. Use a fake terminal-input emitter.
- [ ] Implement.
- [ ] Commit — `feat(teammate): keyboard navigation in widget`

### Task D.4 — Conditional path based on Phase 0 Task 0.2

**Option D-A (full overlay supported):**

#### Task D.4-A — Full view-swap rendering

- Files: `extensions/teammate/ui/viewSwap.ts` (overlay renderer)
- When viewMode === "teammate-focused", render an overlay widget showing the selected teammate's session entries (read via `SessionManager.open`).
- Replace the editor via `setEditorComponent`: input becomes "send to <teammate>" — Enter triggers `send_message {to:<teammate>}`
- ESC or another Enter exits

Tests + implement + commit.

**Option D-B (fallback — Pi doesn't support full overlay):**

#### Task D.4-B — Quick-send dialog

- Files: `extensions/teammate/ui/quickSend.ts`
- When user presses Enter on selected teammate, show `ctx.ui.input(title, prompt)` dialog. Submit triggers `send_message`.
- Commits a meaningful subset of D2 module D's UX (less full-screen but functional).

**Decision: pick A or B based on spike result.**

- [ ] Pick branch.
- [ ] Tests + implement + commit.

---

## Phase E — Integration + Real LLM Verification

### Task E.1 — Cross-module integration test

**Files:** `extensions/teammate/integration.test.ts` (new)

Spec a end-to-end scenario in tests:
1. team_create
2. spawn 2 teammates (alice, bob)
3. team_task_create (3 tasks)
4. team_task_update — assign alice / bob
5. teammate alice calls request_plan_approval
6. leader calls team_plan_approve
7. alice marks task done via team_task_update
8. session_shutdown — clean

Use heavy mocking of AgentSession (similar to existing integration tests in spawnTeammate.test.ts). This is a **single** integration test file.

- [ ] Implement.
- [ ] Commit — `test(teammate): D2 integration scenario`

### Task E.2 — Real LLM end-to-end verification

**Files:**
- Modify: `docs/superpowers/specs/2026-06-03-d2-teammate-collab-design.md` — add Verification section results

Run real LLM scenarios:
1. `team_create` + `task_agent` + `team_task_create` × 3 + `send_message` to teammate → teammate accepts task → updates → completes
2. plan_approval round trip
3. (optional) view-swap manual test in TUI

Capture stdout/stderr + jsonl evidence. Update spec with actual test counts and findings.

- [ ] Run tests, capture results.
- [ ] Update spec.
- [ ] Commit — `docs(d2): close out spec with verification results`

---

## Verification Exit Criteria

- [ ] Phase 0 spikes done, fallbacks documented
- [ ] Phase A (Tasks A.1-A.8): team_task tools wired, hydrate replays them. **~+45 tests** (~640 baseline → ~685)
- [ ] Phase B (Tasks B.1-B.4): plan-mode handshake working end-to-end. **~+25 tests** (~685 → ~710)
- [ ] Phase C (Task C.1): permission sync (A or B). **~+15 tests** if A, ~+5 if B (~710 → ~720-725)
- [ ] Phase D (Tasks D.1-D.4): view-swap (A or B). **~+30 tests** (~720 → ~750)
- [ ] Phase E (Tasks E.1-E.2): integration + verification. **~+10 tests** (~750 → ~760)

Final estimated: **~760 tests passing** (D2 adds ~165 to D1's 594).

## Risks (post-spike)

| Risk | Status |
|---|---|
| Pi permission API not exposed | Plan has fallback C-B (dangerous-skip) — acceptable degradation |
| Pi setEditorComponent too constrained | Plan has fallback D-B (quick-send dialog) — acceptable subset |
| stale-ctx limit on leader notification (D1.5 deferred) | Mitigated by D2 design avoiding "wake immediately" — all flows tolerate eventual delivery |

## Out of Scope

- Cross-session UDS / remote bridge
- Plan-mode auto-detection (LLM 自动识别要写文件就触发 plan_approval)
- Permission persistence (每次都问 — 不存)
- Reload-time recovery of pending plan_approval / permission requests (lost is acceptable, document in tool description)
