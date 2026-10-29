import { taskOriginFromContext } from "../../tasks/origin.js";
import { getFastModeReader } from "../../fast-mode/handle.js";
import { isForkWorker } from "../workerIdentity.js";
import { getCoordinator, type WorkerBridge } from "../../coordinator/handle.js";
import { isInForkChild } from "../recursionGuard.js";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  Theme,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { TaskStore } from "../../tasks/taskStore.js";
import { formatDuration, formatTokens } from "../../tasks/format-utils.js";
import { killLocalAgentTask } from "../kill.js";
import {
  spawnLocalAgent as _spawn,
  type SpawnLocalAgentOptions,
  type SpawnLocalAgentProgressSnapshot,
  type SpawnLocalAgentResult,
  type SpawnLocalAgentTimelineEntry,
} from "../spawnLocalAgent.js";
import { inheritParentRuntime, resolveAgentRuntime } from "../model.js";
import { getBuiltInAgents, FORK_AGENT } from "../agentDefinitions/builtIn.js";
import { mergeAgentDefinitions, getAgentDefinition } from "../agentDefinitions/resolve.js";
import { loadAgentsFromDir } from "../agentDefinitions/loadFromDisk.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { getTeammateHandle, type TeammateHandle } from "../../teammate/handle.js";
import {
  spawnTeammate as _realSpawnTeammate,
  type SpawnTeammateOptions,
  type SpawnTeammateResult,
} from "../../teammate/spawnTeammate.js";

type Spawner = (
  pi: ExtensionAPI,
  store: TaskStore,
  opts: SpawnLocalAgentOptions,
) => Promise<SpawnLocalAgentResult>;
let _spawner: Spawner = _spawn;
export function _setSpawnerForTest(s: Spawner | undefined): void {
  _spawner = s ?? _spawn;
}

type TeammateSpawner = (
  pi: ExtensionAPI,
  taskStore: TaskStore,
  handle: TeammateHandle,
  opts: SpawnTeammateOptions,
) => Promise<SpawnTeammateResult>;

// Resolved lazily, never captured at module-eval time: localagent and teammate
// import each other, and pi loads each extension under its own jiti realm. A
// top-level `let x = _realSpawnTeammate` would be a load-order landmine (TDZ /
// undefined depending on which extension's realm evaluates first).
let _teammateSpawnerOverride: TeammateSpawner | undefined;
export function _setTeammateSpawnerForTest(s: TeammateSpawner | undefined): void {
  _teammateSpawnerOverride = s;
}

function resolveTeammateSpawner(): TeammateSpawner {
  return _teammateSpawnerOverride ?? _realSpawnTeammate;
}

const TaskAgentParams = Type.Object(
  {
    description: Type.String({ description: "Short (3-5 word) task description for status displays." }),
    prompt: Type.String({ description: "The task for the forked agent to perform." }),
    cwd: Type.Optional(Type.String({ description: "Override working directory for the forked agent." })),
    coordinator_task_id: Type.Optional(Type.String({ description: "Logical outcome contract created by coordinator_task. Required for forks while coordinator mode is active." })),
    subagent_type: Type.Optional(
      Type.String({
        description:
          "Long-lived teammate mode only: role name ('general-purpose' | 'explore' or any " +
          "user/project role loaded from ~/.pi/agents/*.md or <cwd>/.pi/agents/*.md).",
      }),
    ),
    team_name: Type.Optional(
      Type.String({
        description:
          "If provided together with `name`, spawn a long-lived teammate joining this team " +
          "(call team_create first). Otherwise omit for the default fork path.",
      }),
    ),
    name: Type.Optional(
      Type.String({
        description:
          "Required when team_name is provided. Human-readable agent name (used as identity " +
          "for send_message and TUI display). Must be unique within the team.",
      }),
    ),
  },
  { additionalProperties: false },
);

interface TaskAgentDetails {
  action: "task_agent";
  /** Distinguishes the fork path from the long-lived teammate path. */
  mode?: "one_shot" | "teammate";
  taskId?: string;
  agentType?: string;
  status?: string;
  isBackgrounded?: boolean;
  toolCallCount?: number;
  tokenCount?: number;
  /**
   * Live progress timeline — pushed via onUpdate as the sub-agent runs.
   * Only present on partial / running results; the final result keeps the
   * complete timeline so renderers can display the full trace.
   */
  timeline?: SpawnLocalAgentProgressSnapshot["timeline"];
  description?: string;
  /** End-of-run wall-clock duration when available. */
  durationMs?: number;
  /** teammate-mode only: stable agent identity (`<name>@<team>`). */
  agentId?: string;
  /** teammate-mode only: persisted JSONL session file for the teammate. */
  sessionFile?: string;
}

export function buildTaskAgentTool(
  pi: ExtensionAPI,
  store: TaskStore,
): ToolDefinition<typeof TaskAgentParams, TaskAgentDetails> {
  const description =
    "Fork the current persisted Pi session into a background LocalAgent, or — when " +
    "`team_name` + `name` are given — spawn a long-lived teammate.\n" +
    "\n" +
    "In fork mode the child inherits " +
    "the compaction-aware active context (summary + retained/recent messages), not the full session archive, " +
    "plus the exact parent provider, model, and thinking level; " +
    "these cannot be overridden. Fast/UltraFast follows the parent on each request. " +
    "A fork is a leaf worker: it cannot create agents, teammates, or teams.\n" +
    "\n" +
    "Use task_agent for independent, non-trivial work that benefits from a separate context. " +
    "Each fork call returns immediately after backgrounding; the final answer arrives automatically.\n" +
    "\n" +
    "## Usage notes\n" +
    "\n" +
    "- Always include a short `description` summarizing what the agent will do.\n" +
    "- When launching multiple independent agents, issue multiple `task_agent` calls in a " +
    "single assistant message so they run concurrently.\n" +
    "- Do not poll immediately; continue independent work and wait for the automatic terminal notification.\n" +
    "- Forking requires a persisted parent session and is disabled recursively inside a forked child.\n" +
    "- Trust but verify a child report before presenting its changes as complete.\n" +
    "\n" +
    "## Writing the prompt\n" +
    "\n" +
    "The child already has the parent conversation. State the exact scope, expected output, and " +
    "constraints for this delegated task; do not rely on a terse label alone. Never delegate " +
    "understanding: include the concrete question or change to make.\n" +
    "\n" +
    "<example>\n" +
    "task_agent({ description: \"Map oldAuth callers\", prompt: \"Find every oldAuth() call " +
    "in src/, list file:line, and report migration risks under 200 words.\" })\n" +
    "</example>\n" +
    "\n" +
    "## Long-lived teammate mode\n" +
    "\n" +
    "Pass BOTH `team_name` AND `name` (call `team_create` first) to spawn a long-lived " +
    "teammate instead of a fork. The teammate runs the initial prompt, then stays resident " +
    "and idle, waiting for messages. `subagent_type` selects its role (defaults to " +
    "'general-purpose').\n" +
    "\n" +
    "- Messages from teammates arrive AUTOMATICALLY in your context as new turns. You " +
    "do not need to poll `task_status`.\n" +
    "- After spawning a teammate or sending a message, continue with other work or wait. " +
    "Do not immediately call `task_status` to check teammate progress.\n" +
    "- A teammate going idle is the normal end-of-turn state, not a failure.\n" +
    "- Message it with `send_message {to: \"<name>\", message: \"...\"}`; shut it down with " +
    "a shutdown_request body or `team_delete` to cascade-kill the whole team.";

  return {
    name: "task_agent",
    label: "Run sub-agent",
    description,
    parameters: TaskAgentParams,
    executionMode: "parallel",
    // Self-render like claude-ui's native overrides — no default bg Box.
    renderShell: "self",
    async execute(_callId: unknown, raw: unknown, signal: AbortSignal | undefined, onUpdate, ctx: ExtensionContext) {
      const params = raw as {
        description: string;
        prompt: string;
        cwd?: string;
        subagent_type?: string;
        coordinator_task_id?: string;
        team_name?: string;
        name?: string;
      } & Record<string, unknown>;

      const legacyKeys = [
        "model",
        "run_in_background",
        "isolation",
      ].filter((key) => Object.prototype.hasOwnProperty.call(params, key));
      if (legacyKeys.length > 0) {
        return errResult(
          `Unsupported task_agent parameter(s): ${legacyKeys.join(", ")}. ` +
          "The fork path inherits the parent provider/model, and forks always run in the background.",
        );
      }

      // Check before BOTH routes; a leaf must not bypass the fork guard by
      // providing team_name/name. The runtime identity survives compaction.
      if (isForkWorker(ctx.sessionManager.getSessionFile()) ||
          isInForkChild((ctx as { messages?: readonly unknown[] }).messages ?? [])) {
        return errResult("LocalAgent is a leaf worker: cannot spawn fork agents or teammates.");
      }

      const origin = taskOriginFromContext(ctx);
      const cwd = params.cwd ?? ctx.cwd;

      // Route to the long-lived teammate path when team_name / name are present.
      // Both must be set; any presence of either opts into that route so a
      // missing partner becomes a clear error instead of silently forking.
      const teamName = params.team_name?.trim();
      const agentName = params.name?.trim();
      if (params.team_name !== undefined || params.name !== undefined) {
        if (params.coordinator_task_id) return errResult("coordinator_task_id is only supported for one-shot LocalAgent forks");
        if (!teamName || !agentName) {
          return errResult("team_name and name must both be provided to spawn a teammate");
        }
        let teammateHandle: TeammateHandle;
        try {
          teammateHandle = getTeammateHandle(pi);
        } catch {
          return errResult("teammate extension not loaded");
        }
        const userDefs = await loadAgentsFromDir(join(homedir(), ".pi", "agents"), "user");
        const projDefs = await loadAgentsFromDir(join(cwd, ".pi", "agents"), "project");
        const allDefs = mergeAgentDefinitions(getBuiltInAgents(), userDefs, projDefs);
        const teammateAgentType = params.subagent_type ?? "general-purpose";
        const teammateAgentDef = getAgentDefinition(allDefs, teammateAgentType);
        if (!teammateAgentDef) {
          const available = allDefs.map((d) => d.agentType).sort().join(", ");
          return errResult(
            `Unknown subagent_type "${teammateAgentType}". Available: ${available}`,
          );
        }
        try {
          const runtime = resolveAgentRuntime(pi, ctx, undefined, teammateAgentDef.model);
          const result = await resolveTeammateSpawner()(pi, store, teammateHandle, {
            ...origin,
            teamName,
            agentName,
            agentDef: teammateAgentDef,
            prompt: params.prompt,
            model: runtime.model,
            thinkingLevel: runtime.thinkingLevel,
            cwd,
          });
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `Teammate ${result.agentId} spawned (taskId=${result.taskId}). ` +
                  `Use send_message to communicate.`,
              },
            ],
            details: {
              action: "task_agent" as const,
              mode: "teammate" as const,
              taskId: result.taskId,
              agentId: result.agentId,
              sessionFile: result.sessionFile,
            },
          };
        } catch (e) {
          return errResult(`task_agent failed: ${(e as Error).message ?? String(e)}`);
        }
      }

      const parentSessionFile = ctx.sessionManager.getSessionFile();
      if (!parentSessionFile) {
        return errResult(
          "Fork requires a persisted parent session. Run pi without --no-session.",
        );
      }

      // Stream sub-agent progress to the tool's caller via onUpdate. Each call
      // emits a full snapshot of the timeline as a multi-line text block. The
      // TUI / RPC renders these as live tool_execution_update events — every
      // sub-agent tool call appears in real time under THIS task_agent's tool
      // result block (no merging across parallel task_agent invocations).
      //
      // We also use the first snapshot to capture `runningTaskId` so that an
      // abort signal arriving mid-run can target the right LocalAgent task.
      //
      // Note (UX): we deliberately push a SHORT one-liner as the partial
      // text — NOT the full timeline. Sub-agent tool calls already surface
      // live in the task panel widget (lastTool / token count) and the
      // tasks/summary customMessage covers terminal state. Dumping the full
      // timeline here would re-create the very main-stream-spam we removed
      // when we set tasks/progress display:false. The verbose timeline is
      // still kept in `details.timeline` so callers (RPC consumers, JSON
      // mode, debug tooling) can inspect the structured event log.
      let runningTaskId: string | undefined;
      const onProgress = (snap: SpawnLocalAgentProgressSnapshot): void => {
        if (runningTaskId === undefined) {
          runningTaskId = snap.taskId;
          if (signal?.aborted) onAbort();
        }
        try {
          // Compact running-status line — same shape as the panel widget
          // shows (agent type · description · current tool / count). Pi's
          // default tool-result rendering will paint exactly this one line
          // while running, replaced by the final result when the agent
          // completes.
          const partialText = `${snap.agentType} — ${snap.description} · ${snap.timeline.length} events`;
          onUpdate?.({
            content: [{ type: "text", text: partialText }],
            details: {
              action: "task_agent",
              taskId: snap.taskId,
              agentType: snap.agentType,
              status: snap.status,
              isBackgrounded: false,
              toolCallCount: snap.toolCallCount,
              tokenCount: snap.tokenCount,
              timeline: snap.timeline,
              description: snap.description,
            } satisfies TaskAgentDetails,
          });
        } catch {
          // onUpdate failures must NOT propagate — they would kill the sub-agent.
        }
      };

      // Honor Esc-driven cancellation: when the user aborts, route to the
      // LocalAgent kill path (session.abort + dispose + flush) which is the
      // same path task_kill uses. If the abort fires before the first
      // onProgress snapshot reaches us, the listener is a no-op and the
      // captured-taskId branch above runs instead once the snapshot arrives.
      const onAbort = (): void => {
        if (runningTaskId === undefined) return;
        void killLocalAgentTask(pi, store, runningTaskId).catch(() => {
          // killLocalAgentTask logs internally; tool result will surface
          // the killed status via the spawn promise resolving.
        });
      };
      if (signal) {
        if (signal.aborted) {
          return errResult("task_agent aborted before start");
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }

      let coordination: WorkerBridge | undefined;
      try {
        const coordinator = getCoordinator(pi);
        if (coordinator?.active() && !params.coordinator_task_id) throw new Error("Coordinator mode requires coordinator_task_id; create a complete contract with coordinator_task first");
        if (params.coordinator_task_id) {
          if (!coordinator) throw new Error("coordinator extension is not loaded");
          coordination = coordinator.reserve(params.coordinator_task_id, cwd);
        }
        const runtime = inheritParentRuntime(pi, ctx);
        const result = await _spawner(pi, store, {
          ...origin,
          prompt: coordination ? coordination.prompt + "\n\nSpecific assignment:\n" + params.prompt : params.prompt,
          coordination,
          ctxMessages: (ctx as { messages?: readonly unknown[] }).messages ?? [],
          cwd,
          description: params.description,
          model: runtime.model,
          thinkingLevel: runtime.thinkingLevel,
          parentSessionFile,
          parentBranch: ctx.sessionManager.getBranch(),
          allRegisteredTools: pi.getActiveTools(),
          readFastMode: getFastModeReader(pi),
          abortSignal: signal,
          onProgress,
        });
        if (!result.backgrounded || result.status !== "running") {
          throw new Error("LocalAgent fork violated the background-only execution contract");
        }
        return {
          content: [{
            type: "text",
            text: `Fork backgrounded (taskId=${result.taskId}). Completion will be delivered automatically; use task_kill to abort.`,
          }],
          details: {
            action: "task_agent",
            taskId: result.taskId,
            agentType: result.agentType,
            status: "running",
            isBackgrounded: true,
            toolCallCount: result.toolCallCount,
            tokenCount: result.tokenCount,
          },
        };
      } catch (e) {
        coordination?.rollback();
        return errResult(`task_agent failed: ${(e as Error).message ?? String(e)}`);
      } finally {
        // Detach the abort listener regardless of whether the agent finished
        // naturally, was killed mid-run, or threw — avoids a leak if the
        // signal is reused by Pi for another tool call later.
        if (signal) signal.removeEventListener("abort", onAbort);
      }
    },
    /**
     * Compact rendering — claudecode-style.
     *
     * The running surface for a task_agent call is the task panel widget,
     * NOT the main stream. While the call is being constructed and while
     * the spawn is in-flight we paint NOTHING into the main stream:
     * `renderCall` returns an empty Text, and `renderResult` does the
     * same when isPartial=true or details.status==="running".
     *
     * The moment the spawn promise resolves to a terminal status
     * (completed / killed / failed), `renderResult` paints the head +
     * (N events · Ctrl+O) hint into the main stream — same slot the
     * panel row had occupied. Combined with the panel filtering on
     * status==="running", this produces the visual "panel row slides
     * up into the main stream" effect the user described.
     *
     * The leader LLM still receives the complete finalText via
     * `result.content[0].text`; this only changes the TUI surface.
     */
    renderCall(_args, _theme) {
      // Empty Text — main stream stays blank while the call is in flight.
      // Panel widget owns the live surface.
      return new Text("", 0, 0);
    },
    renderResult(result, options, theme) {
      return renderTaskAgentResult(result as AgentToolResult<TaskAgentDetails>, options, theme);
    },
  };
}

interface RenderTheme {
  fg(color: string, text: string): string;
  bold?(text: string): string;
}

function isThemeWithFg(t: unknown): t is RenderTheme {
  return typeof (t as { fg?: unknown } | null)?.fg === "function";
}

function statusGlyph(status: string | undefined): { glyph: string; color: string } {
  if (status === "completed") return { glyph: "✓", color: "success" };
  if (status === "killed") return { glyph: "■", color: "warning" };
  if (status === "failed") return { glyph: "✗", color: "error" };
  if (status === "running") return { glyph: "◐", color: "warning" };
  return { glyph: "?", color: "muted" };
}

function timelineGlyph(e: SpawnLocalAgentTimelineEntry): { glyph: string; color: string } {
  switch (e.kind) {
    case "task_start":
      return { glyph: "▶", color: "accent" };
    case "tool_start":
      return { glyph: "●", color: "accent" };
    case "tool_end":
      return e.isError ? { glyph: "✗", color: "error" } : { glyph: "✓", color: "success" };
    case "task_end":
      return { glyph: "✓", color: "success" };
    case "kill":
      return { glyph: "■", color: "warning" };
    default:
      return { glyph: "·", color: "dim" };
  }
}

function buildHead(d: TaskAgentDetails, theme: RenderTheme): string {
  const { glyph, color } = statusGlyph(d.status);
  const agentLabel = d.agentType ?? "agent";
  const desc = d.description ?? "";
  const stats: string[] = [];
  if ((d.toolCallCount ?? 0) > 0) {
    const n = d.toolCallCount ?? 0;
    stats.push(`${n} tool${n === 1 ? "" : "s"}`);
  }
  if ((d.tokenCount ?? 0) > 0) stats.push(formatTokens(d.tokenCount ?? 0));
  if ((d.durationMs ?? 0) > 0) stats.push(formatDuration(d.durationMs ?? 0));
  const dot = ` ${theme.fg("dim", "·")} `;
  const bold = theme.bold ?? ((x: string) => x);
  const head = `${theme.fg(color, glyph)} ${bold(theme.fg(color, agentLabel))}`;
  const subtitle = desc ? `${dot}${theme.fg("dim", desc)}` : "";
  const statsLine = stats.length > 0
    ? `${dot}${stats.map((s) => theme.fg("dim", s)).join(dot)}`
    : "";
  return `${head}${subtitle}${statsLine}`;
}

/**
 * Render the task_agent tool result in claudecode style: a single colored head
 * line with status glyph + agent type + description + stats; collapsed mode
 * adds a "(N events · Ctrl+O to expand)" hint; expanded mode renders the full
 * timeline + the sub-agent's final text below a `── final ──` separator. The
 * leader LLM still consumes the full finalText via `result.content[0].text`;
 * this function only affects the TUI surface.
 */
function renderTaskAgentResult(
  result: AgentToolResult<TaskAgentDetails>,
  options: { isPartial: boolean; expanded: boolean },
  theme: Theme,
) {
  const t: RenderTheme = isThemeWithFg(theme)
    ? (theme as unknown as RenderTheme)
    : { fg: (_c, x) => x };
  const details = (result.details ?? { action: "task_agent" }) as TaskAgentDetails;

  // Streaming partial — the running surface is the panel widget, NOT
  // the main stream. Paint nothing here; the head appears once the
  // spawn promise resolves to a terminal status (the same moment the
  // panel row vanishes via its status==="running" filter).
  if (options.isPartial) {
    return new Text("", 0, 0);
  }

  // Defensive: a non-partial result whose details still report running
  // should also stay blank in the main stream. The terminal head is
  // gated on completed / killed / failed below.
  if (details.status === "running") {
    return new Text("", 0, 0);
  }

  // Backgrounded — anchor with a single dim line; output lives on disk and is
  // surfaced via task_status. Users explicitly opted into background mode and
  // need a confirmation that the task is now off-thread.
  if (details.isBackgrounded === true) {
    const tid = details.taskId ?? "?";
    return new Text(t.fg("dim", `task_agent backgrounded (taskId=${tid})`), 0, 0);
  }

  const head = buildHead(details, t);
  const finalText = (result.content?.[0] as { text?: string } | undefined)?.text ?? "";
  const timeline = details.timeline ?? [];

  if (options.expanded) {
    const box = new Box(0, 0);
    box.addChild(new Text(head, 0, 0));
    for (const e of timeline) {
      const { glyph, color } = timelineGlyph(e);
      box.addChild(
        new Text(
          `  ${t.fg("dim", "⎿")} ${t.fg(color, glyph)} ${t.fg("dim", e.summary)}`,
          0,
          0,
        ),
      );
    }
    if (finalText) {
      box.addChild(new Text("", 0, 0));
      box.addChild(new Text(t.fg("dim", "── final ──"), 0, 0));
      box.addChild(new Text(finalText, 0, 0));
    }
    return box;
  }

  // Collapsed — head + (optional) Ctrl+O hint.
  if (timeline.length === 0 && !finalText) {
    return new Text(head, 0, 0);
  }
  const eventCount = timeline.length;
  const hint = eventCount > 0
    ? t.fg("dim", `(${eventCount} events · Ctrl+O to expand)`)
    : t.fg("dim", "(Ctrl+O to expand)");
  const box = new Box(0, 0);
  box.addChild(new Text(head, 0, 0));
  box.addChild(new Text(`  ${hint}`, 0, 0));
  return box;
}

function errResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
    details: { action: "task_agent" as const },
  };
}
