import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import type { SubagentInternalEvent, SubagentSummary, SubagentToolDetails } from "./types.js";
import { previewJson, previewText } from "./text.js";

export function formatToolCallTitle(toolName: string, args: Record<string, unknown>): string {
  const target = String(args.task_name ?? args.target ?? "").trim();
  const message = String(args.message ?? "").trim();
  const head = target ? `${toolName} ${target}` : toolName;
  return message ? `${head} — ${previewText(message, 80)}` : head;
}

export function formatAgentSummary(summary: SubagentSummary): string {
  const suffix = summary.lastAssistantPreview ? ` - ${summary.lastAssistantPreview}` : summary.lastError ? ` - Error: ${summary.lastError}` : "";
  return `${summary.taskName}: ${summary.status}/${summary.lastTurnStatus}${suffix}`;
}

export function formatEventSummary(event: SubagentInternalEvent): string {
  return `${event.kind}: ${event.summary}`;
}

export function renderSubagentCall(toolName: string, args: Record<string, unknown>, theme: Theme): Text {
  const title = formatToolCallTitle(toolName, args);
  return new Text(theme.fg("toolTitle", theme.bold(title)), 0, 0);
}

export function renderSubagentResult(result: AgentToolResult<SubagentToolDetails>, expanded: boolean, theme: Theme): Text | Box {
  const details = result.details;
  const firstContent = result.content[0];
  const text = firstContent?.type === "text" ? firstContent.text : "";

  if (!expanded || !details?.agents?.length) {
    const color = text.startsWith("Error:") ? "error" : details?.timedOut ? "warning" : "toolOutput";
    return new Text(theme.fg(color, text), 0, 0);
  }

  const box = new Box(1, 1, (value: string) => theme.bg("customMessageBg", value));
  box.addChild(new Text(theme.fg(text.startsWith("Error:") ? "error" : "toolTitle", text), 0, 0));
  for (const agent of details.agents) {
    box.addChild(new Text(theme.fg("accent", formatAgentSummary(agent)), 0, 0));
    if (agent.forked && agent.sessionPath) {
      box.addChild(new Text(theme.fg("dim", `  forked session: ${agent.sessionPath}`), 0, 0));
    }
    for (const event of agent.recentEvents.slice(-10)) {
      const rendered = formatEventSummary(event);
      box.addChild(new Text(theme.fg(event.isError ? "error" : "dim", `  ${rendered}`), 0, 0));
    }
    if (agent.stderrPreview) {
      box.addChild(new Text(theme.fg("warning", `  stderr: ${previewText(agent.stderrPreview, 160)}`), 0, 0));
    }
    const usage = previewJson(agent.usage, 160);
    box.addChild(new Text(theme.fg("dim", `  usage: ${usage}`), 0, 0));
  }
  return box;
}
