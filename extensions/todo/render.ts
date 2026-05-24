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
