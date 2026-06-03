// teamWidget — produce string[] for pi.ui.setWidget rendering.
//
// Visual style (plain text, no ANSI):
//   ▶ {teamName} ({N} members)
//     ◌ {agent}    idle              [2 turns, 850 token]
//     ● {agent}    → bash             [5 turns, 2.4k token]
//     ✗ {agent}    {state}            (missing or terminal)
//
// Multiple teams separated by an empty string. Lines truncated to width.
// Width default 80; caller can pass smaller via options.
//
// Task 5.2 will subscribe TaskStore + TeamStore changes and call this on
// debounced refresh, passing the resulting string[] to `pi.ui.setWidget`.

import type {
  InProcessTeammateTaskState,
  TeamState,
} from "../types.js";
import { isTerminalTaskStatus } from "../../tasks/Task.js";

export interface RenderTeamWidgetOptions {
  /** Max line width (default 80). Lines longer than this are truncated with `…`. */
  width?: number;
}

const DEFAULT_WIDTH = 80;

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

  // Index teammates by agentId for O(1) lookup per member.
  const byAgentId = new Map<string, InProcessTeammateTaskState>();
  for (const t of teammates) {
    byAgentId.set(t.identity.agentId, t);
  }

  const lines: string[] = [];
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

      if (!task) {
        lines.push(truncate(`  ✗ ${agentName}    missing`, width));
        continue;
      }

      if (isTerminalTaskStatus(task.status)) {
        lines.push(truncate(`  ✗ ${agentName}    ${task.status}`, width));
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
        truncate(`  ${glyph} ${agentName}    ${state}    ${stats}`, width),
      );
    }
  });

  return lines;
}
