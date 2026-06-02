import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { TaskStore } from "../../tasks/taskStore.js";
import { spawnLocalAgent as _spawn, type SpawnLocalAgentOptions, type SpawnLocalAgentResult } from "../spawnLocalAgent.js";
import { getBuiltInAgents, FORK_AGENT } from "../agentDefinitions/builtIn.js";
import { mergeAgentDefinitions, getAgentDefinition } from "../agentDefinitions/resolve.js";
import { loadAgentsFromDir } from "../agentDefinitions/loadFromDisk.js";
import { homedir } from "node:os";
import { join } from "node:path";

type Spawner = (
  pi: ExtensionAPI,
  store: TaskStore,
  opts: SpawnLocalAgentOptions,
) => Promise<SpawnLocalAgentResult>;
let _spawner: Spawner = _spawn;
export function _setSpawnerForTest(s: Spawner | undefined): void {
  _spawner = s ?? _spawn;
}

const TaskAgentParams = Type.Object({
  description: Type.String({ description: "Short (3-5 word) task description for status displays." }),
  prompt: Type.String({ description: "The task for the agent to perform." }),
  subagent_type: Type.Optional(Type.String({ description: "Type of specialized agent. Omit to fork (inherits parent context)." })),
  model: Type.Optional(Type.Union([Type.Literal("sonnet"), Type.Literal("opus"), Type.Literal("haiku")])),
  run_in_background: Type.Optional(Type.Boolean({ description: "Run as background task; main agent gets a notification on completion." })),
  cwd: Type.Optional(Type.String({ description: "Override working directory for the sub-agent." })),
  isolation: Type.Optional(Type.Literal("worktree", { description: "Reserved; not implemented." })),
});

interface TaskAgentDetails {
  action: "task_agent";
  taskId?: string;
  agentType?: string;
  status?: string;
  isBackgrounded?: boolean;
  toolCallCount?: number;
  tokenCount?: number;
}

export function buildTaskAgentTool(
  pi: ExtensionAPI,
  store: TaskStore,
): ToolDefinition<typeof TaskAgentParams, TaskAgentDetails> {
  return {
    name: "task_agent",
    label: "Run sub-agent",
    description:
      "Dispatch an in-process sub-agent (LLM) to perform a focused task. Pass subagent_type to pick a built-in or user-defined agent; omit subagent_type to fork (inherits the full conversation context). Long-running tasks auto-background after 120s.",
    parameters: TaskAgentParams,
    executionMode: "parallel",
    async execute(_callId: unknown, raw: unknown, _signal, _onUpdate, ctx: ExtensionContext) {
      const params = raw as {
        description: string;
        prompt: string;
        subagent_type?: string;
        model?: "sonnet" | "opus" | "haiku";
        run_in_background?: boolean;
        cwd?: string;
        isolation?: "worktree";
      };
      if (params.isolation === "worktree") {
        return errResult("isolation 'worktree' not yet supported in this phase");
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
