# Codex Todo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Codex-compatible `update_plan` Pi extension with full-snapshot batch updates, transcript rendering, persistent above-editor overlay, and resume/reload restoration from session history.

**Architecture:** Implement a new `extensions/todo` package split into schema normalization, branch-replay state helpers, transcript render helpers, overlay widget controller, and extension registration. `update_plan` will persist each complete plan snapshot to a `codex-plan` custom session entry; lifecycle hooks replay the current branch and render an unfinished plan overlay. The tool API stays Codex-like and intentionally avoids CRUD task ids.

**Tech Stack:** TypeScript ESM, Pi extension API from `@earendil-works/pi-coding-agent`, `typebox`, Pi TUI `Text`/widget APIs, Vitest globals.

---

## File Structure

Create:

- `extensions/todo/package.json` — extension package metadata.
- `extensions/todo/schema.ts` — TypeBox schema, public plan types, runtime normalization, status helpers.
- `extensions/todo/state.ts` — module-local current snapshot store and branch replay selectors.
- `extensions/todo/render.ts` — Codex-style transcript rendering helpers and `renderCall`/`renderResult` components.
- `extensions/todo/overlay.ts` — `aboveEditor` widget lifecycle and pure overlay line formatting.
- `extensions/todo/index.ts` — Pi extension entry point registering `update_plan` and lifecycle hooks.
- `extensions/todo/schema.test.ts` — schema/normalization tests.
- `extensions/todo/state.test.ts` — branch replay and selector tests.
- `extensions/todo/render.test.ts` — transcript render helper tests.
- `extensions/todo/overlay.test.ts` — overlay formatter/controller tests.
- `extensions/todo/index.test.ts` — tool registration, persistence, and lifecycle tests.

Modify:

- `package.json` — add `extensions/todo` to `pi.extensions`.
- `README.md` — document the Codex todo extension and `update_plan` behavior.

---

### Task 1: Add schema and normalization

**Files:**
- Create: `extensions/todo/package.json`
- Create: `extensions/todo/schema.ts`
- Test: `extensions/todo/schema.test.ts`

- [ ] **Step 1: Create the todo extension package file**

Create `extensions/todo/package.json`:

```json
{
  "name": "pi-codex-todo-extension",
  "version": "0.1.0",
  "type": "module",
  "main": "./index.ts",
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
    "typebox": "*"
  }
}
```

- [ ] **Step 2: Write failing schema tests**

Create `extensions/todo/schema.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { UpdatePlanParamsSchema, normalizePlanSnapshot, PLAN_UPDATED_MESSAGE } from "./schema.js";

describe("todo schema", () => {
  it("accepts a valid update_plan payload", () => {
    const payload = {
      explanation: "Moving to verification.",
      plan: [
        { step: "Inspect Codex source", status: "completed" },
        { step: "Run tests", status: "in_progress" },
      ],
    };

    expect(Value.Check(UpdatePlanParamsSchema, payload)).toBe(true);
  });

  it("rejects unknown root and plan item fields", () => {
    expect(Value.Check(UpdatePlanParamsSchema, { plan: [], extra: true })).toBe(false);
    expect(Value.Check(UpdatePlanParamsSchema, { plan: [{ step: "A", status: "pending", id: 1 }] })).toBe(false);
  });

  it("rejects invalid statuses", () => {
    expect(Value.Check(UpdatePlanParamsSchema, { plan: [{ step: "A", status: "blocked" }] })).toBe(false);
  });

  it("normalizes snapshots by trimming explanation and step text", () => {
    expect(
      normalizePlanSnapshot({
        explanation: "  reason  ",
        plan: [{ step: "  Step A  ", status: "pending" }],
        updatedAt: 123,
      }),
    ).toEqual({
      explanation: "reason",
      plan: [{ step: "Step A", status: "pending" }],
      updatedAt: 123,
    });
  });

  it("omits blank explanations but rejects blank steps", () => {
    expect(normalizePlanSnapshot({ explanation: "   ", plan: [], updatedAt: 1 })).toEqual({ plan: [], updatedAt: 1 });
    expect(() => normalizePlanSnapshot({ plan: [{ step: " ", status: "pending" }], updatedAt: 1 })).toThrow(
      "plan item step must not be empty",
    );
  });

  it("exports Codex-compatible success text", () => {
    expect(PLAN_UPDATED_MESSAGE).toBe("Plan updated");
  });
});
```

- [ ] **Step 3: Run schema tests and verify they fail**

Run:

```bash
npx vitest run extensions/todo/schema.test.ts
```

Expected: FAIL because `extensions/todo/schema.ts` does not exist.

- [ ] **Step 4: Implement schema and normalization**

Create `extensions/todo/schema.ts`:

```ts
import { Type, type Static } from "typebox";

export const PLAN_UPDATED_MESSAGE = "Plan updated";
export const PLAN_CUSTOM_ENTRY = "codex-plan";

export const StepStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("in_progress"),
  Type.Literal("completed"),
]);

export const PlanItemSchema = Type.Object(
  {
    step: Type.String({ description: "One short plan step." }),
    status: StepStatusSchema,
  },
  { additionalProperties: false },
);

export const UpdatePlanParamsSchema = Type.Object(
  {
    explanation: Type.Optional(Type.String({ description: "Optional rationale for a structural plan change." })),
    plan: Type.Array(PlanItemSchema, { description: "The full latest list of plan steps." }),
  },
  { additionalProperties: false },
);

export type StepStatus = Static<typeof StepStatusSchema>;
export type PlanItem = Static<typeof PlanItemSchema>;
export type UpdatePlanParams = Static<typeof UpdatePlanParamsSchema>;

export interface PlanSnapshot {
  explanation?: string;
  plan: PlanItem[];
  updatedAt: number;
}

export type UpdatePlanDetails = PlanSnapshot;

export function isStepStatus(value: unknown): value is StepStatus {
  return value === "pending" || value === "in_progress" || value === "completed";
}

export function normalizeUpdatePlanParams(params: UpdatePlanParams, updatedAt = Date.now()): PlanSnapshot {
  return normalizePlanSnapshot({ ...params, updatedAt });
}

export function normalizePlanSnapshot(raw: unknown): PlanSnapshot {
  if (!isRecord(raw)) throw new Error("plan snapshot must be an object");
  if (!Array.isArray(raw.plan)) throw new Error("plan snapshot requires a plan array");

  const explanation = typeof raw.explanation === "string" ? raw.explanation.trim() : undefined;
  const updatedAt = typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now();
  const plan = raw.plan.map((item, index) => normalizePlanItem(item, index));

  return {
    ...(explanation ? { explanation } : {}),
    plan,
    updatedAt,
  };
}

function normalizePlanItem(raw: unknown, index: number): PlanItem {
  if (!isRecord(raw)) throw new Error(`plan item ${index} must be an object`);
  if (typeof raw.step !== "string") throw new Error(`plan item ${index} requires a string step`);
  const step = raw.step.trim();
  if (!step) throw new Error("plan item step must not be empty");
  if (!isStepStatus(raw.status)) throw new Error(`plan item ${index} has invalid status`);
  return { step, status: raw.status };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
```

- [ ] **Step 5: Run schema tests and verify they pass**

Run:

```bash
npx vitest run extensions/todo/schema.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit schema work**

Run:

```bash
git add extensions/todo/package.json extensions/todo/schema.ts extensions/todo/schema.test.ts
git commit -m "feat: add codex todo schema"
```

Expected: commit succeeds.

---

### Task 2: Add branch replay state helpers

**Files:**
- Create: `extensions/todo/state.ts`
- Test: `extensions/todo/state.test.ts`

- [ ] **Step 1: Write failing state tests**

Create `extensions/todo/state.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  clearPlan,
  getPlan,
  hasInProgress,
  hasUnfinishedPlan,
  planCounts,
  restorePlanFromBranch,
  setPlan,
  shouldShowRestoredOverlay,
} from "./state.js";
import type { PlanSnapshot } from "./schema.js";

function custom(data: unknown) {
  return { type: "custom", customType: "codex-plan", data };
}

function snapshot(plan: PlanSnapshot["plan"]): PlanSnapshot {
  return { plan, updatedAt: 10 };
}

describe("todo state", () => {
  it("stores and clears the current plan", () => {
    const plan = snapshot([{ step: "A", status: "pending" }]);
    setPlan(plan);
    expect(getPlan()).toEqual(plan);
    clearPlan();
    expect(getPlan()).toBeNull();
  });

  it("restores the last valid codex-plan entry from a branch", () => {
    const first = snapshot([{ step: "Old", status: "pending" }]);
    const second = snapshot([{ step: "New", status: "in_progress" }]);

    expect(restorePlanFromBranch([custom(first), custom({ bad: true }), { type: "message" }, custom(second)] as any)).toEqual(
      second,
    );
  });

  it("returns null when no valid plan exists", () => {
    expect(restorePlanFromBranch([{ type: "message" }, custom({ plan: [{ step: "A", status: "bad" }] })] as any)).toBeNull();
  });

  it("detects unfinished and in-progress plans", () => {
    expect(hasUnfinishedPlan(snapshot([]))).toBe(false);
    expect(hasUnfinishedPlan(snapshot([{ step: "Done", status: "completed" }]))).toBe(false);
    expect(hasUnfinishedPlan(snapshot([{ step: "Todo", status: "pending" }]))).toBe(true);
    expect(hasUnfinishedPlan(snapshot([{ step: "Doing", status: "in_progress" }]))).toBe(true);
    expect(hasInProgress(snapshot([{ step: "Doing", status: "in_progress" }]))).toBe(true);
  });

  it("counts completed and total plan items", () => {
    expect(
      planCounts(
        snapshot([
          { step: "A", status: "completed" },
          { step: "B", status: "pending" },
        ]),
      ),
    ).toEqual({ completed: 1, total: 2 });
  });

  it("shows restored overlays only for unfinished plans", () => {
    expect(shouldShowRestoredOverlay(snapshot([{ step: "A", status: "pending" }]))).toBe(true);
    expect(shouldShowRestoredOverlay(snapshot([{ step: "A", status: "completed" }]))).toBe(false);
    expect(shouldShowRestoredOverlay(null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run state tests and verify they fail**

Run:

```bash
npx vitest run extensions/todo/state.test.ts
```

Expected: FAIL because `extensions/todo/state.ts` does not exist.

- [ ] **Step 3: Implement state helpers**

Create `extensions/todo/state.ts`:

```ts
import { PLAN_CUSTOM_ENTRY, normalizePlanSnapshot, type PlanSnapshot } from "./schema.js";

let currentPlan: PlanSnapshot | null = null;

export function setPlan(snapshot: PlanSnapshot | null): void {
  currentPlan = snapshot;
}

export function getPlan(): PlanSnapshot | null {
  return currentPlan;
}

export function clearPlan(): void {
  currentPlan = null;
}

export function restorePlanFromBranch(branch: Iterable<unknown>): PlanSnapshot | null {
  let latest: PlanSnapshot | null = null;
  for (const entry of branch) {
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== PLAN_CUSTOM_ENTRY) continue;
    try {
      latest = normalizePlanSnapshot(entry.data);
    } catch {
      continue;
    }
  }
  return latest;
}

export function hasUnfinishedPlan(snapshot: PlanSnapshot | null): boolean {
  return !!snapshot?.plan.some((item) => item.status === "pending" || item.status === "in_progress");
}

export function hasInProgress(snapshot: PlanSnapshot | null): boolean {
  return !!snapshot?.plan.some((item) => item.status === "in_progress");
}

export function planCounts(snapshot: PlanSnapshot | null): { completed: number; total: number } {
  const plan = snapshot?.plan ?? [];
  return {
    completed: plan.filter((item) => item.status === "completed").length,
    total: plan.length,
  };
}

export function shouldShowRestoredOverlay(snapshot: PlanSnapshot | null): boolean {
  return hasUnfinishedPlan(snapshot);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
```

- [ ] **Step 4: Run state tests and verify they pass**

Run:

```bash
npx vitest run extensions/todo/state.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit state work**

Run:

```bash
git add extensions/todo/state.ts extensions/todo/state.test.ts
git commit -m "feat: restore codex todo state"
```

Expected: commit succeeds.

---

### Task 3: Add transcript rendering helpers

**Files:**
- Create: `extensions/todo/render.ts`
- Test: `extensions/todo/render.test.ts`

- [ ] **Step 1: Write failing render tests**

Create `extensions/todo/render.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { formatPlanUpdateLines, formatStatusGlyph, formatUpdatePlanCallTitle } from "./render.js";
import type { PlanSnapshot } from "./schema.js";

const snapshot: PlanSnapshot = {
  explanation: "Moving to verification.",
  plan: [
    { step: "Inspect Codex source", status: "completed" },
    { step: "Implement update_plan", status: "in_progress" },
    { step: "Run verification", status: "pending" },
  ],
  updatedAt: 1,
};

describe("todo render helpers", () => {
  it("formats status glyphs", () => {
    expect(formatStatusGlyph("completed")).toBe("✓");
    expect(formatStatusGlyph("in_progress")).toBe("◐");
    expect(formatStatusGlyph("pending")).toBe("○");
  });

  it("formats tool call titles", () => {
    expect(formatUpdatePlanCallTitle({ plan: [{ step: "A", status: "pending" }] })).toBe("update_plan 1 step");
    expect(formatUpdatePlanCallTitle({ plan: [{ step: "A", status: "pending" }, { step: "B", status: "pending" }] })).toBe(
      "update_plan 2 steps",
    );
  });

  it("formats Codex-style plan update lines", () => {
    expect(formatPlanUpdateLines(snapshot)).toEqual([
      "• Updated Plan",
      "  └ Moving to verification.",
      "    ✓ Inspect Codex source",
      "    ◐ Implement update_plan",
      "    ○ Run verification",
    ]);
  });

  it("handles empty plans", () => {
    expect(formatPlanUpdateLines({ plan: [], updatedAt: 1 })).toEqual(["• Updated Plan", "  └ (no steps provided)"]);
  });
});
```

- [ ] **Step 2: Run render tests and verify they fail**

Run:

```bash
npx vitest run extensions/todo/render.test.ts
```

Expected: FAIL because `extensions/todo/render.ts` does not exist.

- [ ] **Step 3: Implement render helpers and Pi components**

Create `extensions/todo/render.ts`:

```ts
import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import type { PlanSnapshot, StepStatus, UpdatePlanDetails, UpdatePlanParams } from "./schema.js";

export function formatStatusGlyph(status: StepStatus): string {
  switch (status) {
    case "completed":
      return "✓";
    case "in_progress":
      return "◐";
    case "pending":
      return "○";
  }
}

export function formatUpdatePlanCallTitle(args: Pick<UpdatePlanParams, "plan">): string {
  const count = Array.isArray(args.plan) ? args.plan.length : 0;
  return `update_plan ${count} ${count === 1 ? "step" : "steps"}`;
}

export function formatPlanUpdateLines(snapshot: PlanSnapshot): string[] {
  const lines = ["• Updated Plan"];
  const explanation = snapshot.explanation?.trim();
  if (explanation) lines.push(`  └ ${explanation}`);
  if (snapshot.plan.length === 0) {
    lines.push("  └ (no steps provided)");
    return lines;
  }
  for (const item of snapshot.plan) {
    lines.push(`    ${formatStatusGlyph(item.status)} ${item.step}`);
  }
  return lines;
}

export function renderUpdatePlanCall(args: UpdatePlanParams, theme: Theme): Text {
  return new Text(theme.fg("toolTitle", theme.bold(formatUpdatePlanCallTitle(args))), 0, 0);
}

export function renderUpdatePlanResult(result: AgentToolResult<UpdatePlanDetails>, _expanded: boolean, theme: Theme): Text | Box {
  const details = result.details;
  const lines = formatPlanUpdateLines(details);
  const box = new Box(1, 1, (value: string) => theme.bg("customMessageBg", value));
  lines.forEach((line, index) => {
    box.addChild(new Text(colorPlanLine(line, index, theme), 0, 0));
  });
  return box;
}

function colorPlanLine(line: string, index: number, theme: Theme): string {
  if (index === 0) return theme.fg("toolTitle", theme.bold(line));
  if (line.includes("✓ ")) return theme.fg("success", line);
  if (line.includes("◐ ")) return theme.fg("warning", line);
  if (line.includes("○ ")) return theme.fg("dim", line);
  return theme.fg("dim", line);
}
```

- [ ] **Step 4: Run render tests and verify they pass**

Run:

```bash
npx vitest run extensions/todo/render.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit render work**

Run:

```bash
git add extensions/todo/render.ts extensions/todo/render.test.ts
git commit -m "feat: render codex plan updates"
```

Expected: commit succeeds.

---

### Task 4: Add persistent overlay formatter and controller

**Files:**
- Create: `extensions/todo/overlay.ts`
- Test: `extensions/todo/overlay.test.ts`

- [ ] **Step 1: Write failing overlay tests**

Create `extensions/todo/overlay.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { CodexPlanOverlay, formatPlanOverlayLines } from "./overlay.js";
import { setPlan } from "./state.js";
import type { PlanSnapshot } from "./schema.js";

const plainTheme: any = {
  fg: (_color: string, text: string) => text,
  strikethrough: (text: string) => `~${text}~`,
};

function snapshot(count = 3): PlanSnapshot {
  return {
    plan: Array.from({ length: count }, (_, index) => ({
      step: `Step ${index + 1}`,
      status: index === 0 ? "completed" : index === 1 ? "in_progress" : "pending",
    })),
    updatedAt: 1,
  };
}

describe("plan overlay formatting", () => {
  it("returns undefined for no unfinished work unless completed display is held", () => {
    expect(formatPlanOverlayLines(null, plainTheme, 80)).toBeUndefined();
    expect(formatPlanOverlayLines({ plan: [{ step: "Done", status: "completed" }], updatedAt: 1 }, plainTheme, 80)).toBeUndefined();
    expect(formatPlanOverlayLines({ plan: [{ step: "Done", status: "completed" }], updatedAt: 1 }, plainTheme, 80, { forceVisible: true })).toEqual([
      "○ Plan (1/1)",
      "└─ ✓ ~Done~",
    ]);
  });

  it("formats unfinished plans with heading, connectors, and glyphs", () => {
    expect(formatPlanOverlayLines(snapshot(), plainTheme, 80)).toEqual([
      "● Plan (1/3)",
      "├─ ✓ ~Step 1~",
      "├─ ◐ Step 2",
      "└─ ○ Step 3",
    ]);
  });

  it("truncates long lists and adds an overflow summary", () => {
    const lines = formatPlanOverlayLines(snapshot(20), plainTheme, 80, { maxLines: 5 });
    expect(lines).toEqual(["● Plan (1/20)", "├─ ✓ ~Step 1~", "├─ ◐ Step 2", "├─ ○ Step 3", "└─ +17 more"]);
  });
});

describe("CodexPlanOverlay", () => {
  it("registers and clears an above-editor widget", () => {
    const setWidget = vi.fn();
    const requestRender = vi.fn();
    const ui: any = { setWidget };
    const overlay = new CodexPlanOverlay(() => snapshot());

    overlay.setUICtx(ui);
    overlay.update();

    expect(setWidget).toHaveBeenCalledWith("codex-plan-overlay", expect.any(Function), { placement: "aboveEditor" });
    const factory = setWidget.mock.calls[0][1];
    const component = factory({ requestRender }, plainTheme);
    expect(component.render(80)).toEqual(["● Plan (1/3)", "├─ ✓ ~Step 1~", "├─ ◐ Step 2", "└─ ○ Step 3"]);

    overlay.update();
    expect(requestRender).toHaveBeenCalledTimes(1);

    setPlan(null);
    overlay.hide();
    expect(setWidget).toHaveBeenLastCalledWith("codex-plan-overlay", undefined, { placement: "aboveEditor" });
  });

  it("holds completed plans until agent_start hides them", () => {
    const setWidget = vi.fn();
    const ui: any = { setWidget };
    const completed: PlanSnapshot = { plan: [{ step: "Done", status: "completed" }], updatedAt: 1 };
    const overlay = new CodexPlanOverlay(() => completed);

    overlay.setUICtx(ui);
    overlay.update({ holdCompleted: true });
    expect(setWidget).toHaveBeenCalledWith("codex-plan-overlay", expect.any(Function), { placement: "aboveEditor" });

    overlay.hideCompletedHold();
    expect(setWidget).toHaveBeenLastCalledWith("codex-plan-overlay", undefined, { placement: "aboveEditor" });
  });
});
```

- [ ] **Step 2: Run overlay tests and verify they fail**

Run:

```bash
npx vitest run extensions/todo/overlay.test.ts
```

Expected: FAIL because `extensions/todo/overlay.ts` does not exist.

- [ ] **Step 3: Implement overlay formatter and lifecycle controller**

Create `extensions/todo/overlay.ts`:

```ts
import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import type { PlanItem, PlanSnapshot } from "./schema.js";
import { hasInProgress, hasUnfinishedPlan, planCounts } from "./state.js";

const WIDGET_KEY = "codex-plan-overlay";
const DEFAULT_MAX_LINES = 12;

export interface PlanOverlayFormatOptions {
  maxLines?: number;
  forceVisible?: boolean;
}

export function formatPlanOverlayLines(
  snapshot: PlanSnapshot | null,
  theme: Pick<Theme, "fg" | "strikethrough">,
  width: number,
  options: PlanOverlayFormatOptions = {},
): string[] | undefined {
  if (!snapshot) return undefined;
  const forceVisible = options.forceVisible === true;
  if (!forceVisible && !hasUnfinishedPlan(snapshot)) return undefined;

  const maxLines = Math.max(1, Math.floor(options.maxLines ?? DEFAULT_MAX_LINES));
  const truncate = (line: string) => truncateToWidth(line, Math.max(1, width), "…");
  const counts = planCounts(snapshot);
  const active = hasInProgress(snapshot);
  const headerColor = active ? "accent" : "dim";
  const headerIcon = active ? "●" : "○";
  const lines = [truncate(`${theme.fg(headerColor, headerIcon)} ${theme.fg(headerColor, `Plan (${counts.completed}/${counts.total})`)}`)];

  if (maxLines === 1) return lines;

  const maxItems = Math.max(0, maxLines - 1);
  const visibleItems = snapshot.plan.slice(0, maxItems);
  const hidden = snapshot.plan.length - visibleItems.length;

  visibleItems.forEach((item, index) => {
    const isLast = hidden === 0 && index === visibleItems.length - 1;
    lines.push(truncate(`${theme.fg("dim", isLast ? "└─" : "├─")} ${formatOverlayItem(item, theme)}`));
  });

  if (hidden > 0) {
    if (lines.length >= maxLines) lines.pop();
    lines.push(truncate(`${theme.fg("dim", "└─")} ${theme.fg("dim", `+${hidden + 1} more`)}`));
  }

  return lines;
}

function formatOverlayItem(item: PlanItem, theme: Pick<Theme, "fg" | "strikethrough">): string {
  if (item.status === "completed") {
    return `${theme.fg("success", "✓")} ${theme.strikethrough(theme.fg("dim", item.step))}`;
  }
  if (item.status === "in_progress") {
    return `${theme.fg("warning", "◐")} ${theme.fg("text", item.step)}`;
  }
  return `${theme.fg("dim", "○")} ${theme.fg("text", item.step)}`;
}

export class CodexPlanOverlay {
  private uiCtx: ExtensionUIContext | undefined;
  private widgetRegistered = false;
  private tui: TUI | undefined;
  private holdCompleted = false;

  constructor(private readonly getSnapshot: () => PlanSnapshot | null) {}

  setUICtx(ctx: ExtensionUIContext): void {
    if (ctx !== this.uiCtx) {
      this.uiCtx = ctx;
      this.widgetRegistered = false;
      this.tui = undefined;
    }
  }

  update(options: { holdCompleted?: boolean } = {}): void {
    if (options.holdCompleted) this.holdCompleted = true;
    if (!this.uiCtx) return;
    const snapshot = this.getSnapshot();
    const visible = formatPlanOverlayLines(snapshot, fallbackTheme, 80, { forceVisible: this.holdCompleted });
    if (!visible) {
      this.hide();
      return;
    }

    if (!this.widgetRegistered) {
      this.uiCtx.setWidget(
        WIDGET_KEY,
        (tui, theme) => {
          this.tui = tui;
          return {
            render: (width: number) => formatPlanOverlayLines(this.getSnapshot(), theme, width, { forceVisible: this.holdCompleted }) ?? [],
            invalidate: () => {
              this.widgetRegistered = false;
              this.tui = undefined;
            },
          };
        },
        { placement: "aboveEditor" },
      );
      this.widgetRegistered = true;
    } else {
      this.tui?.requestRender();
    }
  }

  hideCompletedHold(): void {
    if (!this.holdCompleted) return;
    this.holdCompleted = false;
    if (!hasUnfinishedPlan(this.getSnapshot())) this.hide();
    else this.tui?.requestRender();
  }

  hide(): void {
    if (this.uiCtx && this.widgetRegistered) {
      this.uiCtx.setWidget(WIDGET_KEY, undefined, { placement: "aboveEditor" });
    }
    this.widgetRegistered = false;
    this.tui = undefined;
  }

  dispose(): void {
    this.hide();
    this.uiCtx = undefined;
    this.holdCompleted = false;
  }
}

const fallbackTheme = {
  fg: (_color: string, text: string) => text,
  strikethrough: (text: string) => text,
};
```

- [ ] **Step 4: Run overlay tests and verify they pass**

Run:

```bash
npx vitest run extensions/todo/overlay.test.ts
```

Expected: PASS, including the overflow assertion for 20 items and `maxLines: 5`:

```ts
["● Plan (1/20)", "├─ ✓ ~Step 1~", "├─ ◐ Step 2", "├─ ○ Step 3", "└─ +17 more"]
```

- [ ] **Step 5: Commit overlay work**

Run:

```bash
git add extensions/todo/overlay.ts extensions/todo/overlay.test.ts
git commit -m "feat: add codex plan overlay"
```

Expected: commit succeeds.

---

### Task 5: Register the extension and lifecycle hooks

**Files:**
- Create: `extensions/todo/index.ts`
- Test: `extensions/todo/index.test.ts`

- [ ] **Step 1: Write failing extension registration tests**

Create `extensions/todo/index.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import todoExtension from "./index.js";

function createPi() {
  const handlers = new Map<string, Function[]>();
  const pi: any = {
    registerTool: vi.fn(),
    appendEntry: vi.fn(),
    on: vi.fn((event: string, handler: Function) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    }),
  };
  return { pi, handlers };
}

describe("todo extension", () => {
  it("registers update_plan and persists full snapshots", async () => {
    const { pi } = createPi();
    todoExtension(pi);

    expect(pi.registerTool).toHaveBeenCalledTimes(1);
    const tool = pi.registerTool.mock.calls[0][0];
    expect(tool.name).toBe("update_plan");

    const result = await tool.execute(
      "tool-1",
      { plan: [{ step: "Run tests", status: "in_progress" }] },
      undefined,
      undefined,
      { hasUI: false, sessionManager: { getBranch: () => [] } },
    );

    expect(result.content).toEqual([{ type: "text", text: "Plan updated" }]);
    expect(result.details.plan).toEqual([{ step: "Run tests", status: "in_progress" }]);
    expect(pi.appendEntry).toHaveBeenCalledWith("codex-plan", expect.objectContaining({
      plan: [{ step: "Run tests", status: "in_progress" }],
    }));
  });

  it("restores unfinished plans on session_start and shows the overlay", async () => {
    const { pi, handlers } = createPi();
    const setWidget = vi.fn();
    todoExtension(pi);

    await handlers.get("session_start")?.[0]?.(
      { type: "session_start", reason: "resume" },
      {
        hasUI: true,
        ui: { setWidget },
        sessionManager: {
          getBranch: () => [
            { type: "custom", customType: "codex-plan", data: { plan: [{ step: "Continue", status: "pending" }], updatedAt: 1 } },
          ],
        },
      },
    );

    expect(setWidget).toHaveBeenCalledWith("codex-plan-overlay", expect.any(Function), { placement: "aboveEditor" });
  });

  it("does not show stale completed plans on resume", async () => {
    const { pi, handlers } = createPi();
    const setWidget = vi.fn();
    todoExtension(pi);

    await handlers.get("session_start")?.[0]?.(
      { type: "session_start", reason: "resume" },
      {
        hasUI: true,
        ui: { setWidget },
        sessionManager: {
          getBranch: () => [
            { type: "custom", customType: "codex-plan", data: { plan: [{ step: "Done", status: "completed" }], updatedAt: 1 } },
          ],
        },
      },
    );

    expect(setWidget).not.toHaveBeenCalledWith("codex-plan-overlay", expect.any(Function), { placement: "aboveEditor" });
  });

  it("hides held completed overlay on agent_start", async () => {
    const { pi, handlers } = createPi();
    const setWidget = vi.fn();
    todoExtension(pi);
    const tool = pi.registerTool.mock.calls[0][0];
    const ctx: any = { hasUI: true, ui: { setWidget }, sessionManager: { getBranch: () => [] } };

    await handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, ctx);
    await tool.execute("tool-1", { plan: [{ step: "Done", status: "completed" }] }, undefined, undefined, ctx);
    expect(setWidget).toHaveBeenCalledWith("codex-plan-overlay", expect.any(Function), { placement: "aboveEditor" });

    await handlers.get("agent_start")?.[0]?.({ type: "agent_start" }, ctx);
    expect(setWidget).toHaveBeenLastCalledWith("codex-plan-overlay", undefined, { placement: "aboveEditor" });
  });
});
```

- [ ] **Step 2: Run extension tests and verify they fail**

Run:

```bash
npx vitest run extensions/todo/index.test.ts
```

Expected: FAIL because `extensions/todo/index.ts` does not exist.

- [ ] **Step 3: Implement extension registration**

Create `extensions/todo/index.ts`:

```ts
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CodexPlanOverlay } from "./overlay.js";
import { renderUpdatePlanCall, renderUpdatePlanResult } from "./render.js";
import {
  PLAN_CUSTOM_ENTRY,
  PLAN_UPDATED_MESSAGE,
  UpdatePlanParamsSchema,
  normalizeUpdatePlanParams,
  type PlanSnapshot,
  type UpdatePlanDetails,
} from "./schema.js";
import { getPlan, restorePlanFromBranch, setPlan, shouldShowRestoredOverlay, hasUnfinishedPlan } from "./state.js";

const PROMPT_GUIDELINE = [
  "Use update_plan for non-trivial, multi-step, ambiguous, or long-running work; do not use it for simple one-step tasks.",
  "Call update_plan with the full latest plan snapshot, using short one-sentence steps and statuses pending, in_progress, or completed.",
  "Keep exactly one in_progress step while work remains, mark completed steps before moving on, and mark all steps completed when done.",
  "When changing plan structure, include explanation; after calling update_plan, do not repeat the full plan because Pi displays it already.",
];

export default function todoExtension(pi: ExtensionAPI) {
  const overlay = new CodexPlanOverlay(getPlan);

  function restore(ctx: ExtensionContext): PlanSnapshot | null {
    const snapshot = restorePlanFromBranch(ctx.sessionManager.getBranch());
    setPlan(snapshot);
    return snapshot;
  }

  function updateOverlayForRestored(ctx: ExtensionContext, snapshot: PlanSnapshot | null): void {
    if (!ctx.hasUI) return;
    overlay.setUICtx(ctx.ui);
    if (shouldShowRestoredOverlay(snapshot)) overlay.update();
    else overlay.hide();
  }

  pi.registerTool<typeof UpdatePlanParamsSchema, UpdatePlanDetails>({
    name: "update_plan",
    label: "Update Plan",
    description:
      "Updates the task plan. Provide an optional explanation and a full list of plan items, each with a step and status. At most one step should be in_progress at a time.",
    promptSnippet: "Track multi-step work with a Codex-style full-snapshot plan.",
    promptGuidelines: PROMPT_GUIDELINE,
    parameters: UpdatePlanParamsSchema,
    executionMode: "sequential",
    renderCall(args, theme) {
      return renderUpdatePlanCall(args, theme);
    },
    renderResult(result, { expanded }, theme) {
      return renderUpdatePlanResult(result, expanded, theme);
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const snapshot = normalizeUpdatePlanParams(params);
      pi.appendEntry<PlanSnapshot>(PLAN_CUSTOM_ENTRY, snapshot);
      setPlan(snapshot);
      if (ctx.hasUI) {
        overlay.setUICtx(ctx.ui);
        overlay.update({ holdCompleted: !hasUnfinishedPlan(snapshot) && snapshot.plan.length > 0 });
      }
      return { content: [{ type: "text", text: PLAN_UPDATED_MESSAGE }], details: snapshot };
    },
  });

  pi.on("session_start", async (_event, ctx) => updateOverlayForRestored(ctx, restore(ctx)));
  pi.on("session_tree", async (_event, ctx) => updateOverlayForRestored(ctx, restore(ctx)));
  pi.on("session_compact", async (_event, ctx) => updateOverlayForRestored(ctx, restore(ctx)));
  pi.on("agent_start", async () => overlay.hideCompletedHold());
  pi.on("session_shutdown", async () => overlay.dispose());
}
```

- [ ] **Step 4: Run extension tests and verify they pass**

Run:

```bash
npx vitest run extensions/todo/index.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run all todo extension tests**

Run:

```bash
npx vitest run extensions/todo
```

Expected: PASS.

- [ ] **Step 6: Commit extension registration work**

Run:

```bash
git add extensions/todo/index.ts extensions/todo/index.test.ts
git commit -m "feat: register codex update_plan tool"
```

Expected: commit succeeds.

---

### Task 6: Integrate package metadata and README

**Files:**
- Modify: `package.json`
- Modify: `README.md`

- [ ] **Step 1: Update root package extension list**

Modify the root `package.json` `pi.extensions` array so it includes `extensions/todo` after `extensions/imagegen`:

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

- [ ] **Step 2: Update README extension table**

In `README.md`, add this row to the “包含的扩展” table:

```markdown
| `extensions/todo` | 添加 Codex 风格 `update_plan` 工具、计划更新渲染和常驻 plan overlay。 |
```

- [ ] **Step 3: Add README section for Codex todo**

In `README.md`, add this section after the “Imagegen 生图” section and before “安装”:

```markdown
## Codex Todo / `update_plan`

`extensions/todo` 复刻 Codex CLI 的核心 todo 能力：模型调用 `update_plan`，传入当前完整计划快照，而不是对单个任务做 CRUD。一次调用可以同时新增、删除、重排多个步骤并批量更新状态。

工具参数：

```ts
{
  explanation?: string;
  plan: Array<{
    step: string;
    status: "pending" | "in_progress" | "completed";
  }>;
}
```

工具成功时只向模型返回 `Plan updated`。Pi TUI 会把计划渲染成 Codex 风格 checklist，并在输入框上方显示常驻 overlay：

```text
● Plan (2/4)
├─ ✓ Inspect Codex source
├─ ✓ Design Pi extension
├─ ◐ Implement update_plan
└─ ○ Run verification
```

最新计划会保存为 session custom entry。`/resume`、`/reload`、session tree 切换或 compaction 后，扩展会根据当前分支最后一次 `codex-plan` 快照恢复状态：如果仍有 `pending` 或 `in_progress` 步骤，则恢复 overlay；如果最后一次计划已经全部 `completed`，则不会显示陈旧的常驻列表。
```

- [ ] **Step 4: Run package/readme diff check**

Run:

```bash
git diff -- package.json README.md
```

Expected: diff shows only the new extension entry and README documentation.

- [ ] **Step 5: Commit metadata and docs**

Run:

```bash
git add package.json README.md
git commit -m "docs: document codex todo extension"
```

Expected: commit succeeds.

---

### Task 7: Final verification and cleanup

**Files:**
- Verify all modified files.

- [ ] **Step 1: Run the full test suite**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 2: Run TypeScript typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Inspect git status**

Run:

```bash
git status --short
```

Expected: only intentional files are modified or untracked. If the plan implementation followed the commit steps, todo extension changes should already be committed. Existing unrelated user changes such as `.gitignore` or older untracked docs must not be modified unless they were part of this task.

- [ ] **Step 4: Inspect recent commits**

Run:

```bash
git log --oneline -6
```

Expected: recent commits include the todo implementation commits from Tasks 1-6.

- [ ] **Step 5: Summarize verification evidence**

Prepare a final note containing:

```text
Implemented Codex-style update_plan extension.
Verification:
- npm test: PASS
- npm run typecheck: PASS
Key behavior:
- update_plan accepts full plan snapshots and batch status changes.
- Tool result content is Plan updated.
- Overlay restores unfinished plans on resume/reload from codex-plan custom entries.
- Completed latest plans do not show stale overlay on resume.
```

Do not claim PASS unless the commands above actually passed.
