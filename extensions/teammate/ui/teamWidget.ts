// teamWidget — produces both:
//   - `renderTeamWidget(...)`  : pure string[] renderer (kept for tests &
//     backward-compatible callers).
//   - `buildTeamWidget(deps)`  : panel-style component factory consumed by
//     `pi.ui.setWidget` overload `(tui, theme) => Component`. The Component
//     pulls latest data from injected stores and re-renders on width
//     changes; live updates are driven by the host calling
//     `tui.requestRender()` whenever stores notify.
//
// Visual style (plain text, no ANSI):
//   ● team / panel  ↑↓ move · Enter open · Esc back · Ctrl+G blur     <- focused
//   ○ team / panel  Ctrl+G to focus                                    <- blurred
//   ▶ {teamName} ({N} members)
//     ◌ {agent}    idle              [2 turns, 850 token]
//     ● {agent}    → bash             [5 turns, 2.4k token]
//     ✗ {agent}    {state}            (missing or terminal)
//
// Multiple teams separated by an empty string. Lines truncated to width.
// Width default 80; caller can pass smaller via options.

import type { Component, TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TeamStore } from "../teamStore.js";
import type { TaskStore } from "../../tasks/taskStore.js";
import type { ViewStateStore } from "./viewState.js";
import {
  isInProcessTeammateTask,
  type InProcessTeammateTaskState,
  type TeamState,
} from "../types.js";
import { isTerminalTaskStatus } from "../../tasks/Task.js";

export interface RenderTeamWidgetOptions {
  /** Max line width (default 80). Lines longer than this are truncated with `…`. */
  width?: number;
  /** Highlight the row whose teammate.identity.agentId matches by replacing
   *  the leading two-space indent with "▶ ". When undefined or no match,
   *  rendering is identical to the un-selected state. */
  selectedAgentId?: string;
  /** Whether the panel currently holds keyboard focus. When defined, a
   *  header line ("● focused …" / "○ blur …") is prepended; when undefined
   *  the widget renders without any header (legacy behaviour). */
  focused?: boolean;
}

const DEFAULT_WIDTH = 80;
const TITLE = "Team";

function formatTokens(n: number): string {
  if (n < 1000) {
    return `${n} ${n === 1 ? "token" : "tokens"}`;
  }
  return `${(n / 1000).toFixed(1)}k tokens`;
}

function formatTurns(n: number): string {
  return `${n} ${n === 1 ? "turn" : "turns"}`;
}

function truncate(s: string, width: number): string {
  if (s.length <= width) return s;
  if (width <= 1) return "…";
  return s.slice(0, width - 1) + "…";
}

export function renderTeamWidget(
  teams: readonly TeamState[],
  teammates: readonly InProcessTeammateTaskState[],
  options: RenderTeamWidgetOptions = {},
): string[] {
  if (teams.length === 0) return [];
  const width = options.width ?? DEFAULT_WIDTH;
  const lines: string[] = [];

  // Optional focus header (only when focused option is explicitly passed).
  if (options.focused !== undefined) {
    const icon = options.focused ? "●" : "○";
    const hint = options.focused
      ? "↑↓ move · Enter open · Esc back · k kill · Ctrl+G blur"
      : "Ctrl+G to focus";
    lines.push(truncate(`${icon} ${TITLE}  ${hint}`, width));
  }

  // Index teammates by agentId for O(1) lookup per member.
  const byAgentId = new Map<string, InProcessTeammateTaskState>();
  for (const t of teammates) {
    byAgentId.set(t.identity.agentId, t);
  }

  teams.forEach((team, idx) => {
    if (idx > 0) lines.push("");

    const memberCount = team.memberAgentIds.length;
    lines.push(
      truncate(
        `▶ ${team.teamName} (${memberCount} ${memberCount === 1 ? "member" : "members"})`,
        width,
      ),
    );

    for (const agentId of team.memberAgentIds) {
      const task = byAgentId.get(agentId);
      // Fallback name parsing: if task missing, try `name@team` split for display.
      const agentName =
        task?.identity.agentName ?? agentId.split("@")[0] ?? agentId;

      const indent = options.selectedAgentId === agentId ? "▶ " : "  ";

      if (!task) {
        lines.push(truncate(`${indent}✗ ${agentName}    missing`, width));
        continue;
      }

      if (isTerminalTaskStatus(task.status)) {
        lines.push(truncate(`${indent}✗ ${agentName}    ${task.status}`, width));
        continue;
      }

      const glyph = task.isIdle ? "◌" : "●";
      let state: string;
      if (task.isIdle) {
        state = "idle";
      } else if (task.lastTool) {
        state = `→ ${task.lastTool}`;
      } else {
        state = "working";
      }
      const stats = `[${formatTurns(task.turnCount)}, ${formatTokens(task.tokenCount)}]`;
      lines.push(
        truncate(`${indent}${glyph} ${agentName}    ${state}    ${stats}`, width),
      );
    }
  });

  return lines;
}

export interface TeamWidgetDeps {
  teamStore: TeamStore;
  taskStore: TaskStore;
  viewState: ViewStateStore;
}

/**
 * Panel-style factory that matches the `pi.ui.setWidget` factory overload:
 *   `(tui, theme) => Component & { dispose?(): void }`.
 *
 * The factory is invoked once when the widget is mounted; the returned
 * Component's `render(width)` is called on every paint by the host TUI. To
 * surface live updates, host code subscribes to teamStore / taskStore /
 * viewState and calls `tui.requestRender()` on change.
 *
 * `theme` is intentionally unused for now — the existing renderer is plain
 * text without ANSI so we don't need theme-aware coloring. Once we adopt
 * `theme.fg(...)` we'll wire it in via PanelRenderTheme.
 */
export function buildTeamWidget(deps: TeamWidgetDeps) {
  return (_tui: TUI, _theme: Theme): Component & { dispose?(): void } => {
    return {
      render(width: number): string[] {
        const teams = deps.teamStore.list();
        const teammates = Object.values(deps.taskStore.get()).filter(
          isInProcessTeammateTask,
        );
        const vs = deps.viewState.get();
        const selectedAgentId =
          vs.kind === "leader_with_selection"
            ? vs.selectedAgentId
            : vs.kind === "teammate"
              ? vs.agentId
              : undefined;
        const focused = vs.kind === "teammate" ? false : vs.focused;
        return renderTeamWidget(teams, teammates, {
          width,
          selectedAgentId,
          focused,
        });
      },
      invalidate(): void {
        // No internal cache — re-renders pull fresh state on each call.
      },
      dispose(): void {
        // No resources held; nothing to release.
      },
    };
  };
}
