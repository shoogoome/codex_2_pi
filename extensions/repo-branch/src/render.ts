import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { RepoBranchAction, RepoBranchToolDetails } from "./types.js";

export interface RepoBranchCallArgs {
  action?: RepoBranchAction;
  repo?: string;
  branch?: string;
}

export function renderRepoBranchCall(args: RepoBranchCallArgs, theme: Theme): Text {
  const action = args.action ?? "record";
  const parts = [theme.fg("toolTitle", theme.bold("record_repo_branch")), theme.fg("muted", action)];
  if (args.repo) parts.push(theme.fg("dim", args.repo));
  if (args.branch) parts.push(theme.fg("accent", args.branch));
  return new Text(parts.join(" "), 0, 0);
}

export function renderRepoBranchResult(
  result: AgentToolResult<RepoBranchToolDetails>,
  expanded: boolean,
  theme: Theme,
): Text {
  const details = result.details;
  if (!details) {
    const fallback = result.content
      ?.filter((item): item is { type: "text"; text: string } => item.type === "text")
      .map((item) => item.text)
      .join("\n") ?? "";
    return new Text(fallback, 0, 0);
  }

  const lines: string[] = [];
  if (details.action === "record" && details.record) {
    const prefix = details.changed ? "✓ 已记录" : "• 未变更";
    lines.push(`${theme.fg("success", prefix)} ${theme.fg("text", details.record.name)} ${theme.fg("dim", "→")} ${theme.fg("accent", details.record.branch)}`);
  } else if (details.action === "remove") {
    if (details.removed) {
      lines.push(`${theme.fg("warning", "✓ 已移除")} ${theme.fg("text", details.removed.name)} ${theme.fg("dim", `(${details.removed.branch})`)}`);
    } else {
      lines.push(theme.fg("dim", "• 未找到匹配的仓库记录"));
    }
  } else if (details.action === "clear") {
    lines.push(theme.fg("warning", `✓ 已清空 ${details.clearedCount ?? 0} 条仓库分支记录`));
  } else {
    lines.push(theme.fg("toolTitle", `• 当前记录 ${details.records.length} 个仓库`));
  }

  if ((expanded || details.action === "list") && details.records.length > 0) {
    for (const record of details.records) {
      const location = record.path ? theme.fg("dim", ` (${record.path})`) : "";
      lines.push(`  ${theme.fg("accent", "●")} ${theme.fg("text", record.name)}  ${theme.fg("success", record.branch)}${location}`);
    }
  }

  return new Text(lines.join("\n"), 0, 0);
}
