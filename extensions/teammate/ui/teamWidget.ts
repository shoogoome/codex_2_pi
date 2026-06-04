// teamWidget — produces both:
//   - `renderTeamWidget(...)`  : pure string[] renderer (kept for tests &
//     backward-compatible callers).
//   - `buildTeamWidget(deps)`  : panel-style component factory consumed by
//     `pi.ui.setWidget` overload `(tui, theme) => Component`. The Component
//     pulls latest data from injected stores and re-renders on width
//     changes; live updates are driven by the host calling
//     `tui.requestRender()` whenever stores notify.
//
// Visual style (theme.fg-coloured; plain when no theme passed):
//   ● team / panel  ↑↓ move · Enter open · Esc back · Ctrl+G blur     <- focused (accent)
//   ○ team / panel  Ctrl+G to focus                                    <- blurred (dim)
//   ▶ {teamName} ({N} members)
//     ◌ {agent}    idle              [2 turns, 850 token]
//     ● {agent}    → bash             [5 turns, 2.4k token]
//     ✗ {agent}    {state}            (missing or terminal)
//
// Multiple teams separated by an empty string. Lines truncated to width.
// Width default 80; caller can pass smaller via options.

import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
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

/**
 * Minimal theme surface — only `fg(color, text)` is consumed by the renderer.
 * Mirrors the contract used by `panel/panel-render.ts` so both widgets share
 * one colour vocabulary (accent / muted / text / success / dim / error).
 */
export interface TeamWidgetRenderTheme {
  fg(color: string, text: string): string;
}

const PLAIN_THEME: TeamWidgetRenderTheme = { fg: (_c, t) => t };

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
  /** Optional theme handle for ANSI colouring. Default plain pass-through
   *  preserves existing tests/callers. Production callers pass the Pi
   *  `Theme` (which exposes `theme.fg(name, text)`). */
  theme?: TeamWidgetRenderTheme;
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
  return truncateToWidth(s, width, "…");
}

// `truncate` is a thin shim over Pi TUI's truncateToWidth so existing
// call sites stay compact. Width math is delegated to truncateToWidth /
// visibleWidth which correctly account for CJK / emoji / ANSI escapes;
// our previous hand-rolled `s.length`-based version silently overran the
// width budget for non-ASCII content and tripped Pi's strict
// per-line width guard ("Rendered line N exceeds terminal width").

export function renderTeamWidget(
  teams: readonly TeamState[],
  teammates: readonly InProcessTeammateTaskState[],
  options: RenderTeamWidgetOptions = {},
): string[] {
  if (teams.length === 0) return [];
  const width = options.width ?? DEFAULT_WIDTH;
  const theme = options.theme ?? PLAIN_THEME;
  const lines: string[] = [];

  // Optional focus header (only when focused option is explicitly passed).
  // Truncate the plain-text composition first so ANSI escape sequences
  // emitted by `theme.fg(...)` never count toward the width budget. When
  // truncation kicks in we fall back to painting the whole truncated string
  // with a single colour — colouring per-segment of an already-clipped
  // string risks slicing through an escape boundary.
  if (options.focused !== undefined) {
    const icon = options.focused ? "●" : "○";
    const hint = options.focused
      ? "↑↓ move · Enter open · Esc back · k kill · Ctrl+G blur"
      : "Ctrl+G to focus";
    const headerColor = options.focused ? "accent" : "dim";
    const plain = `${icon} ${TITLE}  ${hint}`;
    const clipped = truncate(plain, width);
    if (clipped === plain) {
      lines.push(
        `${theme.fg(headerColor, icon)} ${theme.fg(headerColor, TITLE)}  ${theme.fg("dim", hint)}`,
      );
    } else {
      lines.push(theme.fg(headerColor, clipped));
    }
  }

  // Index teammates by agentId for O(1) lookup per member.
  const byAgentId = new Map<string, InProcessTeammateTaskState>();
  for (const t of teammates) {
    byAgentId.set(t.identity.agentId, t);
  }

  teams.forEach((team, idx) => {
    if (idx > 0) lines.push("");

    const memberCount = team.memberAgentIds.length;
    const memberSuffix = `(${memberCount} ${memberCount === 1 ? "member" : "members"})`;
    const teamPlain = `▶ ${team.teamName} ${memberSuffix}`;
    const teamClipped = truncate(teamPlain, width);
    // Team-name header: ▶ uses accent (or dim when blurred), name uses
    // default text colour, member count is dim.
    const teamHeaderColor = options.focused === false ? "dim" : "accent";
    if (teamClipped === teamPlain) {
      lines.push(
        `${theme.fg(teamHeaderColor, "▶")} ${theme.fg("text", team.teamName)} ${theme.fg("dim", memberSuffix)}`,
      );
    } else {
      lines.push(theme.fg(teamHeaderColor, teamClipped));
    }

    for (const agentId of team.memberAgentIds) {
      const task = byAgentId.get(agentId);
      // Fallback name parsing: if task missing, try `name@team` split for display.
      const agentName =
        task?.identity.agentName ?? agentId.split("@")[0] ?? agentId;

      const isSelected = options.selectedAgentId === agentId;
      const indent = isSelected ? "▶ " : "  ";

      if (!task) {
        const plain = `${indent}✗ ${agentName}    missing`;
        const clipped = truncate(plain, width);
        if (clipped === plain) {
          const prefix = isSelected ? theme.fg("accent", "▶ ") : "  ";
          const nameColor = isSelected ? "accent" : "text";
          lines.push(
            `${prefix}${theme.fg("error", "✗")} ${theme.fg(nameColor, agentName)}    ${theme.fg("error", "missing")}`,
          );
        } else {
          lines.push(clipped);
        }
        continue;
      }

      if (isTerminalTaskStatus(task.status)) {
        const plain = `${indent}✗ ${agentName}    ${task.status}`;
        const clipped = truncate(plain, width);
        if (clipped === plain) {
          const prefix = isSelected ? theme.fg("accent", "▶ ") : "  ";
          const nameColor = isSelected ? "accent" : "text";
          lines.push(
            `${prefix}${theme.fg("error", "✗")} ${theme.fg(nameColor, agentName)}    ${theme.fg("error", task.status)}`,
          );
        } else {
          lines.push(clipped);
        }
        continue;
      }

      const glyph = task.isIdle ? "◌" : "●";
      const glyphColor = task.isIdle ? "muted" : "success";
      let state: string;
      let stateColor: string;
      if (task.isIdle) {
        state = "idle";
        stateColor = "muted";
      } else if (task.lastTool) {
        state = `→ ${task.lastTool}`;
        stateColor = "accent";
      } else {
        state = "working";
        stateColor = "success";
      }
      const stats = `[${formatTurns(task.turnCount)}, ${formatTokens(task.tokenCount)}]`;
      const plain = `${indent}${glyph} ${agentName}    ${state}    ${stats}`;
      const clipped = truncate(plain, width);
      if (clipped === plain) {
        const prefix = isSelected ? theme.fg("accent", "▶ ") : "  ";
        const nameColor = isSelected ? "accent" : "text";
        lines.push(
          `${prefix}${theme.fg(glyphColor, glyph)} ${theme.fg(nameColor, agentName)}    ${theme.fg(stateColor, state)}    ${theme.fg("dim", stats)}`,
        );
      } else {
        lines.push(clipped);
      }
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
 * `theme` is the Pi `Theme` passed by `setWidget`. We forward it to
 * `renderTeamWidget` so the resulting string[] carries ANSI colour codes
 * matching the Pi colour scheme (accent / muted / dim / success / error /
 * text). Tests that don't care about colour omit the theme argument and
 * fall back to the no-op plain theme.
 */
export function buildTeamWidget(deps: TeamWidgetDeps) {
  return (_tui: TUI, theme: Theme): Component & { dispose?(): void } => {
    // Pi Theme exposes more methods than we need; narrow to the minimal
    // `fg`-only surface so renderTeamWidget stays decoupled from Pi types.
    // Some tests pass an empty stub for theme — guard against a missing
    // `fg` member by falling back to a no-op pass-through so render output
    // stays plain-text instead of throwing on undefined.
    const themeFg = (theme as unknown as Partial<TeamWidgetRenderTheme>).fg;
    const renderTheme: TeamWidgetRenderTheme =
      typeof themeFg === "function"
        ? {
            fg: (color: string, text: string) =>
              themeFg.call(theme, color, text),
          }
        : { fg: (_c, t) => t };
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
          theme: renderTheme,
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
