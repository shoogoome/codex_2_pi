import { keyHint, type Theme, type ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";

export const COORDINATOR_PREVIEW_LINES = 8;

type RenderableResult = {
  content: ReadonlyArray<{ type: string; text?: string }>;
};

/** Like codemode's VisualLinePreview: cap wrapped rows, not JSON/logical lines. */
class TaskPreview implements Component {
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;
  private readonly text: Text;

  constructor(
    text: string,
    private readonly maxLines: number,
    private readonly formatHint?: (hidden: number) => string,
  ) {
    this.text = new Text(text, 0, 0);
  }

  render(width: number): string[] {
    const columns = Math.max(1, width);
    if (this.cachedLines === undefined || this.cachedWidth !== columns) {
      const rows = this.text.render(columns);
      this.cachedLines = rows.slice(0, this.maxLines);
      if (rows.length > this.maxLines && this.formatHint) {
        this.cachedLines.push(truncateToWidth(this.formatHint(rows.length - this.maxLines), columns, "…"));
      }
      this.cachedWidth = columns;
    }
    return this.cachedLines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    this.text.invalidate();
  }
}

export function renderCoordinatorCall(
  args: { action?: string; task_id?: string; section?: string },
  theme: Theme,
): Component {
  // Contracts and patches can be huge. Keep the call itself to one visual row.
  const summary = [args.action, args.task_id, args.section].filter(Boolean).join(" ").replace(/[\r\n\t]/g, " ");
  const title = theme.fg("toolTitle", theme.bold("coordinator_task"));
  const line = `${title}${summary ? ` ${theme.fg("muted", summary)}` : ""}`;
  return {
    render: width => [truncateToWidth(line, Math.max(1, width), "…")],
    invalidate() {},
  };
}

export function renderCoordinatorResult(
  result: RenderableResult,
  options: ToolRenderResultOptions,
  theme: Theme,
  isError = false,
): Component {
  // Use the existing model-facing content, never reserialize unbounded details.
  const output = result.content.filter(item => item.type === "text").map(item => item.text ?? "").join("\n");
  const text = output || (options.isPartial ? "Updating task…" : "(no output)");
  const styled = text.replace(/\r/g, "").replace(/\t/g, "    ").split("\n")
    .map(line => theme.fg(isError ? "error" : "toolOutput", line)).join("\n");
  if (options.expanded) return new Text(styled, 0, 0);
  return new TaskPreview(styled, COORDINATOR_PREVIEW_LINES, hidden =>
    `${theme.fg("muted", `… (${hidden} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`,
  );
}
