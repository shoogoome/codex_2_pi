// Task progress messages — pushed to TUI/RPC via sendMessage(deliverAs:"nextTurn", triggerTurn:false).
//
// Spike-verified at extensions/spike-progress-context/ that this primitive does NOT enter
// the parent LLM's next provider request payload — the message lands in the session jsonl
// + TUI renderer + RPC stdout, but `messages[]` of `before_provider_request` never sees it.
//
// Use this for in-flight progress (sub-agent tool calls, sub-shell milestones). For terminal
// status, use `notifyTaskTerminal` in `notifications.ts` (it has CAS guard + LLM context routing).

import type { ExtensionAPI, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Box, Text, type Component } from "@earendil-works/pi-tui";
import { logError } from "./logging.js";
import type { TaskType } from "./Task.js";

export const TASK_PROGRESS_CUSTOM_TYPE = "tasks/progress";

export type TaskProgressKind =
  | "task_start"
  | "tool_start"
  | "tool_end"
  | "stream"
  | "task_end"
  | "kill";

export interface TaskProgressDetails {
  taskId: string;
  taskType: TaskType;
  kind: TaskProgressKind;
  /** Human-readable single-line summary, e.g. `grep("foo")` or `[ok] grep → 12 results`. */
  summary: string;
  description?: string;
  agentType?: string;
  toolName?: string;
  isError?: boolean;
  exitCode?: number;
  durationMs?: number;
  toolCallCount?: number;
  tokenCount?: number;
  ts: number;
}

/**
 * Emit a progress message to TUI/RPC.
 *
 * Mechanism (validated by spike `extensions/spike-progress-channels/`):
 *   - `display:true, triggerTurn:false` (no `deliverAs`) → message renders to TUI/RPC
 *     immediately AND is appended to the session jsonl as `{role:"custom", customType, ...}`.
 *   - That `role:"custom"` entry IS visible to the next provider request — it would enter
 *     the parent LLM's context.
 *   - `installProgressContextFilter(pi)` MUST be called once at extension load to register
 *     a `pi.on("context")` handler that strips these entries before LLM sees them.
 *
 * Why not `deliverAs:"nextTurn"`? Empirically the message gets queued silently — no TUI
 * render, no jsonl entry, no provider request entry — until the user types something and
 * then it's discarded. Useless for our purpose.
 *
 * Defensive try/catch — sendMessage failure must NOT propagate up to the producer (the
 * spawn function is mid-LLM-loop and we don't want a renderer crash to kill the agent).
 */
export function emitTaskProgress(
  pi: Pick<ExtensionAPI, "sendMessage">,
  d: Omit<TaskProgressDetails, "ts"> & { ts?: number },
): void {
  const details: TaskProgressDetails = { ts: Date.now(), ...d };
  try {
    pi.sendMessage(
      {
        customType: TASK_PROGRESS_CUSTOM_TYPE,
        content: details.summary,
        display: true,
        details,
      } as never,
      { triggerTurn: false },
    );
  } catch (e) {
    logError(e, "emitTaskProgress");
  }
}

/**
 * Install the `context` event filter that strips progress messages from the LLM's
 * provider request payload. Pair with `emitTaskProgress` — if you emit but don't
 * install the filter, the LLM will see the progress entries.
 *
 * AgentMessage shape for custom messages: `{role:"custom", customType, content, ...}`.
 * This filter drops any message with `role==="custom"` and our customType.
 */
export function installProgressContextFilter(
  pi: Pick<ExtensionAPI, "on">,
): void {
  pi.on("context", (event) => {
    const e = event as { messages: unknown[] };
    const filtered = e.messages.filter((m: unknown) => {
      const msg = m as { role?: string; customType?: string };
      return !(msg.role === "custom" && msg.customType === TASK_PROGRESS_CUSTOM_TYPE);
    });
    return { messages: filtered as never };
  });
}

// ---------- TUI Renderer ----------
//
// Visual style inspired by `pi-subagents` (npm:pi-subagents@0.27.0) — kind-glyph + bold
// title + statJoin separator (`{dim "·"}`) + nested `⎿` indent for tool call previews.
// We do NOT reuse pi-subagents' data structures or business logic; only the formatting
// idioms.

const SAFE_TASK_TYPE_LABEL: Record<TaskType, string> = {
  local_bash: "bash",
  local_agent: "agent",
  in_process_teammate: "teammate",
  dream: "dream",
  remote_agent: "remote",
  local_workflow: "workflow",
  monitor_mcp: "mcp",
};

function shortTypeLabel(t: TaskType): string {
  return SAFE_TASK_TYPE_LABEL[t] ?? t;
}

/** Glyph + theme-color key for each progress kind. */
function kindStyle(d: TaskProgressDetails): { glyph: string; color: ThemeColor } {
  switch (d.kind) {
    case "task_start":
      return { glyph: "▶", color: "accent" };
    case "tool_start":
      return { glyph: "●", color: "accent" };
    case "tool_end":
      return d.isError ? { glyph: "✗", color: "error" } : { glyph: "✓", color: "success" };
    case "task_end":
      // Distinguish failed exit codes for local_bash.
      if (d.exitCode !== undefined && d.exitCode !== 0) {
        return { glyph: "✗", color: "error" };
      }
      return { glyph: "✓", color: "success" };
    case "kill":
      return { glyph: "■", color: "warning" };
    case "stream":
      return { glyph: "·", color: "dim" };
    default:
      return { glyph: "·", color: "dim" };
  }
}

/** Join short stat parts with `dim "·"` separators, mirroring pi-subagents `statJoin`. */
function statJoin(theme: Theme, parts: string[]): string {
  return parts
    .filter((s) => s && s.length > 0)
    .map((part) => theme.fg("dim", part))
    .join(` ${theme.fg("dim", "·")} `);
}

function formatTaskEndStats(d: TaskProgressDetails): string[] {
  const parts: string[] = [];
  if (d.toolCallCount !== undefined && d.toolCallCount > 0) {
    parts.push(`${d.toolCallCount} tool use${d.toolCallCount === 1 ? "" : "s"}`);
  }
  if (d.tokenCount !== undefined && d.tokenCount > 0) {
    const tk = d.tokenCount;
    parts.push(tk >= 1000 ? `${(tk / 1000).toFixed(1)}k token` : `${tk} token`);
  }
  if (d.durationMs !== undefined && d.durationMs > 0) {
    const ms = d.durationMs;
    parts.push(ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);
  }
  return parts;
}

function themeBold(theme: Theme, text: string): string {
  return ((theme as { bold?: (value: string) => string }).bold?.(text)) ?? text;
}

/**
 * Build the headline ANSI-colored string for a single progress entry.
 *
 * Visual layouts:
 *   task_start →  ▶ {bold(agent-type or description)}  ·  {dim taskId}
 *   tool_start →    ⎿  {bold(tool)}  {dim "(args)"}    (indented under task_start)
 *   tool_end   →    ⎿  {ok-glyph} {dim ("[ok]" or err)}  {dim(short result)}
 *   task_end   →  ✓ {bold(label)}  ·  {dim "N tool uses"}  ·  {dim "X token"}
 *   kill       →  ■ {bold(label)}  ·  {dim "killed"}
 */
function renderHeadline(d: TaskProgressDetails, theme: Theme): string {
  const { glyph, color } = kindStyle(d);
  const typeLabel = shortTypeLabel(d.taskType);
  const taskIdPill = theme.fg("muted", `[${typeLabel} ${d.taskId}]`);
  const coloredGlyph = theme.fg(color, glyph);

  if (d.kind === "tool_start" || d.kind === "tool_end") {
    // Indent under the parent task — pi-subagents idiom: `  ⎿  {content}`.
    return `  ${theme.fg("dim", "⎿")}  ${coloredGlyph} ${theme.fg("dim", d.summary)}`;
  }

  if (d.kind === "task_end") {
    const statsParts = formatTaskEndStats(d);
    const stats = statsParts.length > 0 ? `  ${theme.fg("dim", "·")}  ${statJoin(theme, statsParts)}` : "";
    const label = d.description ?? d.summary;
    return `${coloredGlyph} ${themeBold(theme, theme.fg(color, label))}${stats}`;
  }

  if (d.kind === "kill") {
    const label = d.description ?? d.summary;
    return `${coloredGlyph} ${themeBold(theme, theme.fg(color, label))}  ${theme.fg("dim", "·")}  ${theme.fg("dim", "killed")}`;
  }

  // task_start (and any other top-level kind)
  const title = d.agentType ?? d.description ?? d.summary;
  const subtitle = d.description && d.agentType ? d.description : "";
  const head = `${coloredGlyph} ${themeBold(theme, theme.fg(color, title))} ${taskIdPill}`;
  return subtitle ? `${head}  ${theme.fg("dim", "·")}  ${theme.fg("dim", subtitle)}` : head;
}

/**
 * Register the TUI renderer for tasks/progress customType.
 *
 * Each progress message renders as ONE Text component (single-line collapsed; multi-line
 * when expanded shows additional metadata). Aligned with `registerTaskNotificationRenderer`
 * in `notifications.ts` — uses pi-tui Box + Text directly.
 */
export function registerTaskProgressRenderer(
  pi: Pick<ExtensionAPI, "registerMessageRenderer">,
): void {
  pi.registerMessageRenderer<TaskProgressDetails>(
    TASK_PROGRESS_CUSTOM_TYPE,
    (message, { expanded }, theme): Component | undefined => {
      const d = message.details;
      if (!d) {
        const text = typeof message.content === "string" ? message.content : "";
        return new Text(theme.fg("toolOutput", text), 0, 0);
      }
      const headline = renderHeadline(d, theme);

      if (!expanded) {
        return new Text(headline, 0, 0);
      }

      const box = new Box(1, 1, (value: string) => theme.bg("customMessageBg", value));
      box.addChild(new Text(headline, 0, 0));

      // Expanded extra lines — use the same `⎿` indent idiom for sub-detail rows.
      const extra: string[] = [];
      if (d.agentType && d.kind !== "task_start") extra.push(`agent: ${d.agentType}`);
      if (d.toolName && d.kind !== "tool_start" && d.kind !== "tool_end") {
        extra.push(`tool: ${d.toolName}`);
      }
      if (d.exitCode !== undefined && d.kind !== "task_end") extra.push(`exit: ${d.exitCode}`);
      for (const line of extra) {
        box.addChild(new Text(theme.fg("dim", `  ⎿  ${line}`), 0, 0));
      }
      return box;
    },
  );
}
