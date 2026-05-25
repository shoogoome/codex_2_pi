import type { AgentToolResult, ToolDefinition, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

interface RenderThemeLike {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export type CompactResultMode = "hidden" | "summary" | "preview";

class CompactText implements Component {
  constructor(private readonly text: string) {}

  render(_width: number): string[] {
    return [this.text];
  }

  invalidate(): void {}
}

export interface CompactToolOptions {
  renderCallSummary(args: unknown): string;
  resultMode: CompactResultMode;
  maxCollapsedLines?: number;
}

export function compactLines(lines: string[]): string[] {
  const out: string[] = [];
  let previousBlank = false;
  for (const line of lines) {
    const blank = line.trim().length === 0;
    if (blank && previousBlank) continue;
    out.push(line);
    previousBlank = blank;
  }
  return out;
}

function pluralize(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}

function extractText(result: AgentToolResult<unknown>): string {
  return result.content
    .filter((entry): entry is { type: "text"; text: string } => entry.type === "text")
    .map((entry) => entry.text)
    .join("\n");
}

export function renderCompactCallLine(name: string, detail: string, theme: RenderThemeLike): Component {
  const title = theme.fg("toolTitle", theme.bold(name));
  const suffix = detail ? ` ${theme.fg("accent", detail)}` : "";
  return new CompactText(`${title}${suffix}`);
}

export function renderCompactTextResult(
  text: string,
  options: { expanded: boolean; maxLines: number },
  theme: RenderThemeLike,
): Component {
  const lines = compactLines(text.split("\n")).filter((line, index, array) => !(index === array.length - 1 && line === ""));
  if (lines.length === 0) {
    return new CompactText(theme.fg("muted", "↳ (no output)"));
  }

  const maxLines = options.expanded ? lines.length : Math.max(0, options.maxLines);
  const shown = lines.slice(0, maxLines);
  const remaining = lines.length - shown.length;
  let output = shown.join("\n");
  if (remaining > 0) {
    output += `\n${theme.fg("muted", `... (${remaining} more ${pluralize(remaining, "line")})`)}`;
  }
  return new CompactText(output);
}

function renderSummaryResult(result: AgentToolResult<unknown>, theme: RenderThemeLike): Component {
  const text = extractText(result);
  const lines = compactLines(text.split("\n")).filter((line) => line.trim().length > 0);
  return new CompactText(theme.fg("muted", `↳ ${lines.length} ${pluralize(lines.length, "line")} returned`));
}

export function createCompactToolDefinition<TDetails>(
  nativeTool: ToolDefinition<any, TDetails>,
  options: CompactToolOptions,
): ToolDefinition<any, TDetails> {
  return {
    ...nativeTool,
    renderCall(args, theme) {
      const summary = options.renderCallSummary(args);
      return renderCompactCallLine(nativeTool.name, summary, theme as unknown as RenderThemeLike);
    },
    renderResult(result, renderOptions: ToolRenderResultOptions, theme) {
      if (renderOptions.isPartial) {
        return new CompactText(theme.fg("warning", `${nativeTool.name}...`));
      }

      if (options.resultMode === "hidden") {
        return new CompactText(theme.fg("muted", "↳ output hidden"));
      }
      if (options.resultMode === "summary") {
        return renderSummaryResult(result as AgentToolResult<unknown>, theme as unknown as RenderThemeLike);
      }
      return renderCompactTextResult(extractText(result as AgentToolResult<unknown>), {
        expanded: renderOptions.expanded,
        maxLines: options.maxCollapsedLines ?? 8,
      }, theme as unknown as RenderThemeLike);
    },
  };
}
