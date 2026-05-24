# Codex Todo / `update_plan` Extension Design

## Goal

Add a Pi extension that replicates Codex CLI's core todo capability: the model calls `update_plan` with a full checklist snapshot, Pi renders the update, and Pi keeps a compact always-visible plan widget above the input editor. The extension should replace CRUD-style todo tooling for Codex-like task progress tracking while preserving the Pi UI affordance the user likes from `@juicesharp/rpiv-todo`.

## Source Behavior from Codex

Codex implements todo tracking as the `update_plan` tool, not as a CRUD todo manager.

Relevant reference files:

- `codex/codex-rs/protocol/src/plan_tool.rs`
  - `UpdatePlanArgs` contains optional `explanation` and a `plan` array.
  - Each plan item contains `step` and `status`.
  - `status` is one of `pending`, `in_progress`, or `completed`.
- `codex/codex-rs/core/src/tools/handlers/plan_spec.rs`
  - Registers the function tool named `update_plan`.
  - The schema requires `plan` and allows optional `explanation`.
- `codex/codex-rs/core/src/tools/handlers/plan.rs`
  - Parses the full payload, emits a plan update event, and returns `Plan updated` to the model.
- `codex/codex-rs/protocol/src/prompts/base_instructions/default.md`
  - Instructs the model when to use `update_plan`, to keep exactly one in-progress step while work remains, and not to repeat the full plan after tool calls.
- `codex/codex-rs/tui/src/history_cell/plans.rs`
  - Renders plan updates as a checklist in the transcript.

Codex supports batch updates by replacing the entire plan snapshot in one tool call. A single call can add steps, remove steps, reorder steps, and change multiple statuses. It is not id-based CRUD.

## Scope

### In scope

- Add `extensions/todo` to this package.
- Register an LLM-callable `update_plan` tool.
- Match Codex's core schema:
  ```ts
  {
    explanation?: string;
    plan: Array<{
      step: string;
      status: "pending" | "in_progress" | "completed";
    }>;
  }
  ```
- Treat every `update_plan` call as the latest full plan snapshot.
- Return only `Plan updated` as model-visible tool content.
- Render the tool result as a Codex-style checklist in transcript.
- Persist the latest plan snapshot in Pi session custom entries.
- Restore the latest active plan on session resume/reload/tree switch/compaction.
- Show a persistent `aboveEditor` plan widget while there is unfinished work.
- Use only the visual style pattern from `@juicesharp/rpiv-todo`'s overlay: heading, tree connectors, glyphs, colors, truncation behavior.

### Out of scope

- Task ids.
- CRUD actions such as create/update/delete/list/get/clear.
- Deleted tombstones.
- Dependency graph / `blockedBy`.
- `/todos` command.
- Localization.
- Replacing Pi core plan mode or Codex proposed-plan streaming.

## User Experience

### Tool result in transcript

When the model calls `update_plan`, the transcript shows a compact update:

```text
• Updated Plan
  └ Implementation phase finished; moving to verification.
    ✓ Inspect Codex source
    ✓ Design Pi extension
    ◐ Implement update_plan
    ○ Run verification
```

If there is no explanation, only the checklist appears under the `Updated Plan` heading.

### Persistent overlay

The overlay appears above the editor when the latest restored plan contains at least one `pending` or `in_progress` step.

Example:

```text
● Plan (2/4)
├─ ✓ Inspect Codex source
├─ ✓ Design Pi extension
├─ ◐ Implement update_plan
└─ ○ Run verification
```

Visual rules:

- Header:
  - `● Plan (completed/total)` when any item is `in_progress`.
  - `○ Plan (completed/total)` when there is no `in_progress` item but unfinished work remains.
- Row connectors:
  - `├─` for intermediate rows.
  - `└─` for the final visible row or overflow row.
- Status glyphs:
  - `pending`: `○`
  - `in_progress`: `◐`
  - `completed`: `✓`
- Colors:
  - Header with active work uses `accent`.
  - In-progress rows use `warning`.
  - Completed glyph uses `success`; completed text is dim and struck through when supported by the theme.
  - Pending rows are dim/normal text.
- Truncation:
  - Maximum widget height is 12 lines including the header.
  - Long lines are truncated to current terminal width with `…`.
  - If rows overflow, show a final `+N more` summary.

The overlay auto-hides when there is no unfinished work. Immediately after a tool call marks all steps `completed`, the overlay may remain visible until the next `agent_start`, mirroring the pleasant part of `rpiv-todo`: users can see the final completed state before it disappears.

## Persistence and Resume Restore

Pi extension state must not rely on process memory. The extension persists the latest plan snapshot as a custom session entry:

```ts
pi.appendEntry<PlanSnapshot>("codex-plan", snapshot);
```

Snapshot shape:

```ts
interface PlanItem {
  step: string;
  status: "pending" | "in_progress" | "completed";
}

interface PlanSnapshot {
  explanation?: string;
  plan: PlanItem[];
  updatedAt: number;
}
```

Restore algorithm:

1. Read `ctx.sessionManager.getBranch()`.
2. Scan entries in branch order.
3. For each valid `type === "custom" && customType === "codex-plan"` entry, normalize it as a `PlanSnapshot`.
4. The last valid snapshot wins.
5. If no valid snapshot exists, clear memory state and hide the overlay.
6. If the last snapshot contains at least one `pending` or `in_progress` item, restore it and show the overlay.
7. If the last snapshot is empty or all `completed`, restore memory state for correctness but hide the overlay on resume/reload.

Hooks using restore:

- `session_start`: covers startup, reload, resume, new session, and fork.
- `session_tree`: branch navigation should show that branch's latest plan.
- `session_compact`: compaction should rebuild state from the compacted branch.

Tool calls use the same snapshot shape and update memory immediately after persistence.

## Model Prompt Guidance

`update_plan` registers `promptSnippet` and `promptGuidelines` mirroring Codex:

- Use `update_plan` for non-trivial, multi-step, ambiguous, or long-running work.
- Do not use it for simple one-step tasks.
- Create a plan with short one-sentence steps, ideally no more than 5-7 words.
- Keep the plan current as work progresses.
- Mark completed steps as `completed` before moving on.
- Keep exactly one `in_progress` item while there is unfinished work.
- Mark all steps `completed` when the task is done.
- When the plan changes structurally, include `explanation` with the rationale.
- Do not repeat the full plan after an `update_plan` call; Pi displays it already.

## Architecture

Files:

```text
extensions/todo/
  package.json
  index.ts
  schema.ts
  state.ts
  render.ts
  overlay.ts
  schema.test.ts
  state.test.ts
  render.test.ts
  overlay.test.ts
```

### `schema.ts`

Responsibilities:

- Define `StepStatus`, `PlanItem`, `PlanSnapshot`, and `UpdatePlanDetails` types.
- Define TypeBox schema for `update_plan`.
- Normalize raw custom entry data into a valid `PlanSnapshot`.
- Reject unknown statuses and non-string steps.
- Trim step text and explanation.

The TypeBox schema should use `Type.Union([Type.Literal(...)])` or `StringEnum` equivalent already available in Pi dependencies. The schema should disallow extra properties on plan items and on the root object to match Codex's deny-unknown-fields behavior.

### `state.ts`

Responsibilities:

- Hold the current in-memory `PlanSnapshot | null`.
- Provide `setPlan`, `getPlan`, `clearPlan`, and `restorePlanFromBranch` helpers.
- Provide selectors:
  - `hasUnfinishedPlan(snapshot)`
  - `planCounts(snapshot)`
  - `hasInProgress(snapshot)`

`restorePlanFromBranch(ctx)` must be pure with respect to UI. It returns the restored snapshot and lets `index.ts` decide whether to show/hide overlay.

### `render.ts`

Responsibilities:

- Render tool call summary.
- Render tool result checklist.
- Format status glyphs and colors.
- Provide pure string helpers where possible for tests.

Transcript rendering should stay simple and Codex-like:

```text
• Updated Plan
  └ <explanation if present>
    ✓ <completed step>
    ◐ <in-progress step>
    ○ <pending step>
```

### `overlay.ts`

Responsibilities:

- Manage the `aboveEditor` widget lifecycle.
- Render the persistent plan overlay based on current state at render time.
- Register once per UI context and call `requestRender()` for updates.
- Hide when there is no active unfinished plan.
- Truncate to 12 lines.
- Keep completed-all plan visible until the next `agent_start`, then hide it.

Implementation pattern follows `@juicesharp/rpiv-todo`'s widget lifecycle:

- Store the current `ExtensionUIContext`.
- Re-register if the UI context identity changes.
- Use factory-form `ctx.ui.setWidget(key, (tui, theme) => component, { placement: "aboveEditor" })`.
- Keep `tui` and call `requestRender()` on updates.
- Dispose by calling `setWidget(key, undefined)`.

The code should not copy rpiv-todo logic wholesale; it should reuse only the style approach.

### `index.ts`

Responsibilities:

- Register `update_plan`.
- Register overlay lifecycle hooks.
- Persist snapshots via `pi.appendEntry("codex-plan", snapshot)`.
- Restore on session lifecycle events.
- Clear overlay on shutdown.

Event behavior:

- `update_plan.execute`:
  1. Normalize validated params into snapshot.
  2. Persist with `appendEntry`.
  3. Update memory state.
  4. Refresh overlay.
  5. Return `{ content: [{ type: "text", text: "Plan updated" }], details: snapshot }`.
- `session_start`, `session_tree`, `session_compact`:
  1. Restore from branch.
  2. Update memory state.
  3. Show overlay only if unfinished work exists.
- `agent_start`:
  - If current plan has all steps completed and is being held for final visibility, hide it.
- `session_shutdown`:
  - Dispose overlay.

## Package Integration

Update root `package.json`:

```json
"pi": {
  "extensions": [
    "extensions/diff",
    "extensions/review",
    "extensions/user-input",
    "extensions/subagents",
    "extensions/init",
    "extensions/imagegen",
    "extensions/todo"
  ]
}
```

Add `extensions/todo/package.json` with the usual package fields used by existing extensions.

Update `README.md`:

- Add `extensions/todo` to the extension table.
- Document `update_plan` tool.
- Document persistent overlay and resume restore behavior.
- Mention that this is Codex-style plan snapshots, not CRUD todo management.

## Error Handling

- Empty plan is allowed and clears/hides the overlay.
- Empty step after trim is invalid.
- Invalid status is rejected by schema and guarded during normalization.
- More than one `in_progress` should not throw. Codex says “at most one” in the description and prompt guidance, but the handler does not enforce it. Pi should mirror that: accept the payload, render it, and rely on prompt guidance.
- Unknown custom entry data during replay is ignored rather than crashing session resume.
- UI widget failures should not affect model tool execution; rendering helpers should be defensive.

## Testing

### Schema tests

- Accepts valid `update_plan` payload.
- Accepts optional `explanation`.
- Rejects unknown root fields.
- Rejects unknown plan item fields.
- Rejects invalid statuses.

### State tests

- Last valid `codex-plan` custom entry wins.
- Invalid custom entries are ignored.
- `hasUnfinishedPlan` is true for `pending` and `in_progress`.
- `hasUnfinishedPlan` is false for empty/all-completed plans.
- Resume restore returns the last snapshot even if all completed, while overlay selection hides it.

### Render tests

- Renders heading and checklist glyphs.
- Renders explanation when present.
- Uses final connector for last line.
- Handles empty plan.

### Overlay tests

- Shows widget for unfinished plan.
- Hides widget for no plan or all-completed restore.
- Keeps all-completed plan visible immediately after tool update until next `agent_start`.
- Truncates at 12 lines and adds `+N more`.
- Re-registers when UI context identity changes.

## Acceptance Criteria

- A model can call `update_plan` with multiple changed items in one call.
- The tool result to the model is exactly `Plan updated`.
- The transcript shows a Codex-style updated plan checklist.
- The editor overlay shows the current unfinished plan above the input box.
- Resume/reload of a session with unfinished latest plan restores the overlay from session history.
- Resume/reload of a session whose latest plan is all completed does not show stale overlay.
- Existing extensions continue to pass tests and typecheck.
