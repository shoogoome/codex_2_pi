import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { TaskStore } from "../../tasks/taskStore.js";
import { killLocalAgentTask } from "../kill.js";
import {
  spawnLocalAgent as _spawn,
  type SpawnLocalAgentOptions,
  type SpawnLocalAgentProgressSnapshot,
  type SpawnLocalAgentResult,
} from "../spawnLocalAgent.js";
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
let _teammateSpawner: TeammateSpawner = _realSpawnTeammate;
export function _setTeammateSpawnerForTest(s: TeammateSpawner | undefined): void {
  _teammateSpawner = s ?? _realSpawnTeammate;
}

const TaskAgentParams = Type.Object({
  description: Type.String({ description: "Short (3-5 word) task description for status displays." }),
  prompt: Type.String({ description: "The task for the agent to perform." }),
  subagent_type: Type.Optional(
    Type.String({
      description:
        "Built-in: 'general-purpose' | 'explore'. Or any user/project agent " +
        "loaded from ~/.pi/agents/*.md or <cwd>/.pi/agents/*.md. " +
        "Omit to fork — sub-agent inherits the full parent conversation context " +
        "(forces background; only available when running with persistent session).",
    }),
  ),
  model: Type.Optional(Type.Union([Type.Literal("sonnet"), Type.Literal("opus"), Type.Literal("haiku")])),
  run_in_background: Type.Optional(Type.Boolean({ description: "Run as background task; main agent gets a notification on completion." })),
  cwd: Type.Optional(Type.String({ description: "Override working directory for the sub-agent." })),
  isolation: Type.Optional(Type.Literal("worktree", { description: "Reserved; not implemented." })),
  team_name: Type.Optional(
    Type.String({
      description:
        "If provided together with `name`, spawn a long-lived teammate joining this team (call team_create first). Otherwise (omit) run a one-shot sub-agent.",
    }),
  ),
  name: Type.Optional(
    Type.String({
      description:
        "Required when team_name is provided. Human-readable agent name (used as identity for send_message and TUI display). Must be unique within the team.",
    }),
  ),
});

interface TaskAgentDetails {
  action: "task_agent";
  /** Distinguishes the one-shot LocalAgent path from the long-lived teammate path. */
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
  /** teammate-mode only: stable agent identity (`<name>@<team>`). */
  agentId?: string;
  /** teammate-mode only: persisted JSONL session file for the teammate. */
  sessionFile?: string;
}

/**
 * Serialise a progress snapshot into a multi-line text block — what the LLM
 * eventually consumes (the assistant tool result) AND what the TUI/RPC sees as
 * partialResult content during streaming.
 *
 * Mirrors `outputTranslator.translateAgentEvent` for human-readable output but
 * builds it from the timeline array (so each onUpdate emits the full running
 * transcript, letting the renderer overwrite the tool block with each tick).
 */
function renderTimeline(snap: SpawnLocalAgentProgressSnapshot): string {
  const lines: string[] = [];
  lines.push(`▶ ${snap.agentType} — ${snap.description}`);
  for (const e of snap.timeline) {
    if (e.kind === "tool_start") {
      lines.push(`  ↳ ${e.summary}`);
    } else if (e.kind === "tool_end") {
      lines.push(`  ${e.isError ? "✗" : "✓"} ${e.summary}`);
    } else if (e.kind === "task_end") {
      lines.push(`■ ${e.summary}`);
    } else if (e.kind === "kill") {
      lines.push(`✗ ${e.summary}`);
    }
  }
  return lines.join("\n");
}

export function buildTaskAgentTool(
  pi: ExtensionAPI,
  store: TaskStore,
): ToolDefinition<typeof TaskAgentParams, TaskAgentDetails> {
  // Compose the description at registration time so the LLM sees the list of
  // available built-in subagent types AND their `whenToUse` blurbs. User /
  // project-level agents are loaded per-call (cwd-dependent), so we can only
  // advertise the built-ins here; users get a clear error if they miss a custom
  // type, and the description tells them how to discover the full list.
  const builtInLines = getBuiltInAgents()
    .map((d) => `  - "${d.agentType}": ${d.whenToUse ?? ""}`)
    .join("\n");

  const description =
    "Launch a new agent to handle complex, multi-step tasks. Each agent type has " +
    "specific capabilities and tools available to it.\n" +
    "\n" +
    "Available `subagent_type` values:\n" +
    builtInLines +
    "\n  - (omit) → fork: inherits the full parent conversation context (forces background; only available with persistent session).\n" +
    "User and project agents loaded from `~/.pi/agents/*.md` and `<cwd>/.pi/agents/*.md` " +
    "are ALSO valid; passing an unknown type returns an error listing every available type.\n" +
    "\n" +
    "## When not to use\n" +
    "\n" +
    "If the target is already known, use the direct tool: `read` for a known path, " +
    "`grep` via the bash tool for a specific symbol or string. Reserve this tool for " +
    "open-ended questions that span the codebase, or tasks that match an available " +
    "agent type.\n" +
    "\n" +
    "## Usage notes\n" +
    "\n" +
    "- Always include a short `description` summarizing what the agent will do.\n" +
    "- **When you launch multiple agents for independent work, send them in a single " +
    "message with multiple `task_agent` tool uses so they run concurrently.** This is " +
    "the primary way to parallelize: investigation, multi-file refactors, scattered " +
    "tests, or any work that decomposes into independent subtasks.\n" +
    "- When the agent is done, it returns a single message back to you. The result is " +
    "NOT shown to the user — relay the relevant findings as plain text.\n" +
    "- Trust but verify: an agent's summary describes what it intended to do, not " +
    "necessarily what it did. When an agent writes or edits code, verify the actual " +
    "changes before reporting the work as done.\n" +
    "- **Foreground vs background**: foreground (default) when you need the agent's " +
    "results before you can proceed — e.g. research agents whose findings inform your " +
    "next steps. Use `run_in_background: true` when you have genuinely independent work " +
    "to do in parallel and you'll check the result later via `task_status`.\n" +
    "- Long-running tasks auto-background after 120s.\n" +
    "- If the user specifies that they want you to run agents \"in parallel\", you MUST " +
    "send a single message with multiple `task_agent` tool use content blocks.\n" +
    "\n" +
    "## Writing the prompt\n" +
    "\n" +
    "Brief the agent like a smart colleague who just walked into the room — it hasn't " +
    "seen this conversation, doesn't know what you've tried, doesn't understand why " +
    "this task matters.\n" +
    "- Explain what you're trying to accomplish and why.\n" +
    "- Describe what you've already learned or ruled out.\n" +
    "- Give enough context about the surrounding problem that the agent can make " +
    "judgment calls rather than just following a narrow instruction.\n" +
    "- If you need a short response, say so (\"report in under 200 words\").\n" +
    "- Lookups: hand over the exact command. Investigations: hand over the question — " +
    "prescribed steps become dead weight when the premise is wrong.\n" +
    "\n" +
    "Terse command-style prompts produce shallow, generic work.\n" +
    "\n" +
    "**Never delegate understanding.** Don't write \"based on your findings, fix the " +
    "bug\" or \"based on the research, implement it.\" Those phrases push synthesis onto " +
    "the agent instead of doing it yourself. Write prompts that prove you understood: " +
    "include file paths, line numbers, what specifically to change.\n" +
    "\n" +
    "## Examples\n" +
    "\n" +
    "<example>\n" +
    "user: \"What's left on this branch before we can ship?\"\n" +
    "assistant: <thinking>A survey question across git state, tests, and config. " +
    "I'll delegate it and ask for a short report so the raw command output stays out " +
    "of my context.</thinking>\n" +
    "task_agent({\n" +
    "  description: \"Branch ship-readiness audit\",\n" +
    "  prompt: \"Audit what's left before this branch can ship. Check: uncommitted " +
    "changes, commits ahead of main, whether tests exist, whether the feature gate " +
    "is wired up. Report a punch list — done vs. missing. Under 200 words.\",\n" +
    "  subagent_type: \"general-purpose\"\n" +
    "})\n" +
    "</example>\n" +
    "\n" +
    "<example>\n" +
    "user: \"Find all places that call the deprecated `oldAuth()` and propose a " +
    "migration plan.\"\n" +
    "assistant: <thinking>Independent work that splits naturally: one agent maps " +
    "callers, one drafts the migration. Run them concurrently.</thinking>\n" +
    "[Single message with TWO task_agent tool calls]\n" +
    "task_agent({description: \"Map oldAuth callers\", prompt: \"Find every call site " +
    "of oldAuth() in src/. List file:line and the surrounding 2 lines of context.\", " +
    "subagent_type: \"explore\"})\n" +
    "task_agent({description: \"Draft oldAuth migration\", prompt: \"Read src/auth/" +
    "newAuth.ts and propose a step-by-step migration from oldAuth to newAuth. " +
    "Note any API differences callers will need to adapt to.\", subagent_type: " +
    "\"general-purpose\"})\n" +
    "</example>\n" +
    "\n" +
    "## Two modes\n" +
    "\n" +
    "1. **One-shot sub-agent (default)**: Omit `team_name` and `name`. The agent runs " +
    "the prompt to completion and the tool returns the final text. This is what you " +
    "want for most parallel-investigation / parallel-refactor work.\n" +
    "\n" +
    "2. **Long-lived teammate**: Pass BOTH `team_name` AND `name`. The agent joins " +
    "the team as an in-process teammate, runs the initial prompt, then enters idle " +
    "waiting for messages via `send_message`. The tool returns immediately with the " +
    "teammate's identity. To message it: `send_message {to: \"<name>\", message: " +
    "\"...\"}`. To shut it down: `send_message` with a shutdown_request body, or call " +
    "`team_delete` to cascade-kill the whole team. Requires `team_create` first.\n" +
    "\n" +
    "## Long-lived teammate workflow\n" +
    "\n" +
    "When using mode 2:\n" +
    "- Messages from teammates arrive AUTOMATICALLY in your context as new turns. You " +
    "do not need to poll `task_status`.\n" +
    "- After spawning a teammate or sending a message, continue with other work or " +
    "wait. Do not immediately call `task_status` to check teammate progress.\n" +
    "- A teammate going idle is the normal end-of-turn state, not a failure.";

  return {
    name: "task_agent",
    label: "Run sub-agent",
    description,
    parameters: TaskAgentParams,
    executionMode: "parallel",
    async execute(_callId: unknown, raw: unknown, signal: AbortSignal | undefined, onUpdate, ctx: ExtensionContext) {
      const params = raw as {
        description: string;
        prompt: string;
        subagent_type?: string;
        model?: "sonnet" | "opus" | "haiku";
        run_in_background?: boolean;
        cwd?: string;
        isolation?: "worktree";
        team_name?: string;
        name?: string;
      };
      if (params.isolation === "worktree") {
        return errResult("isolation 'worktree' not yet supported in this phase");
      }

      // Route to long-lived teammate path early when team_name / name are present.
      // Both must be set (the cross-pair invariant); we treat any presence of
      // either as opting into the teammate route so a missing partner becomes a
      // clear error rather than silently falling through to the LocalAgent path.
      const teamName = params.team_name?.trim();
      const agentName = params.name?.trim();
      if (params.team_name !== undefined || params.name !== undefined) {
        if (!teamName || !agentName) {
          return errResult("team_name and name must both be provided to spawn a teammate");
        }
        let teammateHandle: TeammateHandle;
        try {
          teammateHandle = getTeammateHandle(pi);
        } catch {
          return errResult("teammate extension not loaded");
        }
        const teammateCwd = params.cwd ?? ctx.cwd;
        try {
          const result = await _teammateSpawner(pi, store, teammateHandle, {
            teamName,
            agentName,
            agentType: params.subagent_type ?? "general-purpose",
            prompt: params.prompt,
            model: params.model,
            cwd: teammateCwd,
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

      const cwd = params.cwd ?? ctx.cwd;
      const userDefs = await loadAgentsFromDir(join(homedir(), ".pi", "agents"), "user");
      const projDefs = await loadAgentsFromDir(join(cwd, ".pi", "agents"), "project");
      const allDefs = mergeAgentDefinitions(getBuiltInAgents(), userDefs, projDefs);

      let agentDef;
      let parentSessionFile: string | undefined;
      if (params.subagent_type === undefined) {
        agentDef = FORK_AGENT;
        parentSessionFile = ctx.sessionManager.getSessionFile();
        if (!parentSessionFile) {
          return errResult(
            "Fork requires a persisted parent session. Run pi without --no-session.",
          );
        }
      } else {
        agentDef = getAgentDefinition(allDefs, params.subagent_type);
        if (!agentDef) {
          const available = allDefs.map((d) => d.agentType).sort().join(", ");
          return errResult(`Unknown subagent_type "${params.subagent_type}". Available: ${available}`);
        }
      }

      // Stream sub-agent progress to the tool's caller via onUpdate. Each call
      // emits a full snapshot of the timeline as a multi-line text block. The
      // TUI / RPC renders these as live tool_execution_update events — every
      // sub-agent tool call appears in real time under THIS task_agent's tool
      // result block (no merging across parallel task_agent invocations).
      //
      // We also use the first snapshot to capture `runningTaskId` so that an
      // abort signal arriving mid-run can target the right LocalAgent task.
      let runningTaskId: string | undefined;
      const onProgress = (snap: SpawnLocalAgentProgressSnapshot): void => {
        if (runningTaskId === undefined) {
          runningTaskId = snap.taskId;
          if (signal?.aborted) onAbort();
        }
        try {
          onUpdate?.({
            content: [{ type: "text", text: renderTimeline(snap) }],
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

      try {
        const result = await _spawner(pi, store, {
          prompt: params.prompt,
          agentDef,
          ctxMessages: (ctx as { messages?: readonly unknown[] }).messages ?? [],
          cwd,
          description: params.description,
          model: params.model,
          forceBackground: params.run_in_background === true,
          parentSessionFile,
          allRegisteredTools: pi.getActiveTools(),
          onProgress,
        });
        if (result.backgrounded) {
          return {
            content: [{
              type: "text",
              text: `Backgrounded (taskId=${result.taskId}, agentType=${result.agentType}). Use task_status to query, task_kill to abort.`,
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
        }
        return {
          content: [{ type: "text", text: result.finalText ?? "" }],
          details: {
            action: "task_agent",
            taskId: result.taskId,
            agentType: result.agentType,
            status: result.status,
            isBackgrounded: false,
            toolCallCount: result.toolCallCount,
            tokenCount: result.tokenCount,
          },
        };
      } catch (e) {
        return errResult(`task_agent failed: ${(e as Error).message ?? String(e)}`);
      } finally {
        // Detach the abort listener regardless of whether the agent finished
        // naturally, was killed mid-run, or threw — avoids a leak if the
        // signal is reused by Pi for another tool call later.
        if (signal) signal.removeEventListener("abort", onAbort);
      }
    },
  };
}

function errResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
    details: { action: "task_agent" as const },
  };
}
