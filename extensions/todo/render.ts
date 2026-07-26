import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
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

export function renderUpdatePlanResult(result: AgentToolResult<UpdatePlanDetails>, _expanded: boolean, theme: Theme): Text {
  const details = result.details;
  const lines = formatPlanUpdateLines(details);
  // Plain Text, no backgrounded Box — matches claude-ui's native-tool look.
  return new Text(lines.map((line, index) => colorPlanLine(line, index, theme)).join("\n"), 0, 0);
}

function colorPlanLine(line: string, index: number, theme: Theme): string {
  if (index === 0) return theme.fg("toolTitle", theme.bold(line));
  if (line.includes("✓ ")) return theme.fg("success", line);
  if (line.includes("◐ ")) return theme.fg("warning", line);
  if (line.includes("○ ")) return theme.fg("dim", line);
  return theme.fg("dim", line);
}
