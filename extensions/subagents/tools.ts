import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { SubagentRegistry } from "./registry.js";
import type { RpcClient, SubagentRpcFactory, SubagentSessionForker, SubagentSummary, SubagentToolDetails } from "./types.js";
import { DEFAULT_SUBAGENT_OPTIONS } from "./types.js";
import { normalizeTaskName, previewText } from "./text.js";
import { renderSubagentCall, renderSubagentResult } from "./render.js";

const SpawnAgentParams = Type.Object({
  task_name: Type.String({ description: "Task name for the new agent. Use lowercase letters, digits, underscores, or hyphens." }),
  message: Type.String({ description: "Initial message to send to the new subagent." }),
  model: Type.Optional(Type.String({ description: "Optional model override for the new agent." })),
  cwd: Type.Optional(Type.String({ description: "Optional working directory for the subagent process." })),
  fork_context: Type.Optional(Type.Boolean({
    description: "When true, clone the current parent session and start the subagent from that cloned context. Only set this when the user explicitly asks for a forked/cloned/current-context subagent. Omit or set false for normal independent subagents.",
  })),
});

const TargetMessageParams = Type.Object({
  target: Type.String({ description: "Subagent id or task_name." }),
  message: Type.String({ description: "Message to send to the subagent." }),
});

const WaitAgentParams = Type.Object({
  target: Type.Optional(Type.String({ description: "Optional subagent id or task_name to wait for." })),
  timeout_ms: Type.Optional(Type.Number({ description: "Wait timeout in milliseconds." })),
});

const ListAgentsParams = Type.Object({
  status: Type.Optional(Type.String({ description: "Optional lifecycle status filter." })),
});

const CloseAgentParams = Type.Object({
  target: Type.String({ description: "Subagent id or task_name to close." }),
});

const clients = new Map<string, RpcClient>();

export interface CreateSubagentToolsOptions {
  forkSession?: SubagentSessionForker;
}

const FORK_CONTEXT_GUIDELINE =
  "Only set spawn_agent.fork_context to true when the user explicitly asks for a forked/cloned/current-context subagent. Omit it for normal independent subagents.";

export const defaultForkSession: SubagentSessionForker = ({ sessionFile, sessionDir, leafId }) => {
  const sourceManager = SessionManager.open(sessionFile, sessionDir);
  return sourceManager.createBranchedSession(leafId);
};

export function createSubagentTools(
  registry: SubagentRegistry,
  rpcFactory: SubagentRpcFactory,
  options: CreateSubagentToolsOptions = {},
): ToolDefinition<any, SubagentToolDetails>[] {
  const forkSession = options.forkSession ?? defaultForkSession;
  return [
    {
      name: "spawn_agent",
      label: "Spawn agent",
      description: "Spawn a background subagent in a separate Pi RPC process. Returns immediately with the task name and status.",
      promptSnippet: "Spawn background subagents for independent work; use wait_agent before relying on their results.",
      promptGuidelines: [FORK_CONTEXT_GUIDELINE],
      parameters: SpawnAgentParams,
      executionMode: "parallel",
      renderCall(args, theme) {
        return renderSubagentCall("spawn_agent", args as Record<string, unknown>, theme);
      },
      renderResult(result, { expanded }, theme) {
        return renderSubagentResult(result, expanded, theme);
      },
      async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
        const params = rawParams as { task_name: string; message: string; model?: string; cwd?: string; fork_context?: boolean };
        const taskName = normalizeTaskName(params.task_name);
        const message = params.message.trim();
        if (!message) return errorResult("spawn", "message is required", []);
        const cwd = params.cwd?.trim() || ctx.cwd;
        const forked = params.fork_context === true;
        const forkResult = forked ? resolveForkedSession(ctx, forkSession) : {};
        if (forkResult.error) return errorResult("spawn", forkResult.error, registry.list());
        const sessionPath = forkResult.sessionPath;
        const entry = registry.createEntry({ taskName, cwd, sessionPath, forked });
        const client = rpcFactory.spawn({ taskName, message, cwd, model: params.model, sessionPath, forked });
        entry.process = client.process;
        clients.set(entry.id, client);
        registry.markRunning(entry.id);
        const response = await client.send({ type: "prompt", message });
        if (!response.success) {
          registry.markFailed(entry.id, response.error ?? "prompt rejected");
          return errorResult("spawn", response.error ?? "prompt rejected", registry.list());
        }
        const suffix = sessionPath ? ` (forked session: ${sessionPath})` : "";
        return okResult("spawn", `Spawned ${taskName}${suffix}: ${previewText(message, 160)}`, registry.list(), taskName);
      },
    },
    {
      name: "wait_agent",
      label: "Wait agent",
      description: "Wait for a mailbox update from any live subagent or a selected target.",
      parameters: WaitAgentParams,
      executionMode: "sequential",
      renderCall(args, theme) {
        return renderSubagentCall("wait_agent", args as Record<string, unknown>, theme);
      },
      renderResult(result, { expanded }, theme) {
        return renderSubagentResult(result, expanded, theme);
      },
      async execute(_toolCallId, rawParams) {
        const params = rawParams as { target?: string; timeout_ms?: number };
        const timeoutMs = validateTimeout(params.timeout_ms);
        const result = await registry.waitForUpdate(params.target, timeoutMs);
        const lines = result.agents.map(formatSummaryLine);
        const text = result.timedOut ? `Wait timed out.\n${lines.join("\n")}` : `Wait completed.\n${lines.join("\n")}`;
        return { content: [{ type: "text", text }], details: { action: "wait", target: params.target, timedOut: result.timedOut, agents: result.agents } };
      },
    },
    {
      name: "send_message",
      label: "Send message",
      description: "Send a steering message to a subagent. If idle, starts a new prompt turn.",
      parameters: TargetMessageParams,
      executionMode: "parallel",
      renderCall(args, theme) {
        return renderSubagentCall("send_message", args as Record<string, unknown>, theme);
      },
      renderResult(result, { expanded }, theme) {
        return renderSubagentResult(result, expanded, theme);
      },
      async execute(_toolCallId, rawParams) {
        const params = rawParams as { target: string; message: string };
        return sendToTarget(registry, params.target, params.message, "send");
      },
    },
    {
      name: "followup_task",
      label: "Follow up task",
      description: "Queue a follow-up message for a subagent. If idle, starts a new prompt turn.",
      parameters: TargetMessageParams,
      executionMode: "parallel",
      renderCall(args, theme) {
        return renderSubagentCall("followup_task", args as Record<string, unknown>, theme);
      },
      renderResult(result, { expanded }, theme) {
        return renderSubagentResult(result, expanded, theme);
      },
      async execute(_toolCallId, rawParams) {
        const params = rawParams as { target: string; message: string };
        return sendToTarget(registry, params.target, params.message, "followup");
      },
    },
    {
      name: "list_agents",
      label: "List agents",
      description: "List subagents spawned in this session.",
      parameters: ListAgentsParams,
      executionMode: "parallel",
      renderCall(args, theme) {
        return renderSubagentCall("list_agents", args as Record<string, unknown>, theme);
      },
      renderResult(result, { expanded }, theme) {
        return renderSubagentResult(result, expanded, theme);
      },
      async execute(_toolCallId, rawParams) {
        const params = rawParams as { status?: string };
        const summaries = registry.list().filter((summary) => !params.status || summary.status === params.status);
        const text = summaries.length === 0 ? "No subagents." : summaries.map(formatSummaryLine).join("\n");
        return { content: [{ type: "text", text }], details: { action: "list", agents: summaries } };
      },
    },
    {
      name: "close_agent",
      label: "Close agent",
      description: "Abort and close a subagent process.",
      parameters: CloseAgentParams,
      executionMode: "sequential",
      renderCall(args, theme) {
        return renderSubagentCall("close_agent", args as Record<string, unknown>, theme);
      },
      renderResult(result, { expanded }, theme) {
        return renderSubagentResult(result, expanded, theme);
      },
      async execute(_toolCallId, rawParams) {
        const params = rawParams as { target: string };
        const entry = registry.resolve(params.target);
        if (!entry) return errorResult("close", `subagent not found: ${params.target}`, registry.list());
        await clients.get(entry.id)?.close();
        registry.markClosed(entry.id);
        clients.delete(entry.id);
        return okResult("close", `Closed ${entry.taskName}.`, registry.list(), entry.taskName);
      },
    },
  ];
}

function resolveForkedSession(ctx: ExtensionContext, forkSession: SubagentSessionForker): { sessionPath?: string; error?: string } {
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) {
    return { error: "spawn_agent fork_context requires a persisted parent session; omit fork_context for a normal subagent." };
  }
  const leafId = ctx.sessionManager.getLeafId();
  if (!leafId) {
    return { error: "spawn_agent fork_context requires a current parent session entry; omit fork_context for a normal subagent." };
  }
  const sessionDir = ctx.sessionManager.getSessionDir();
  try {
    const sessionPath = forkSession({ sessionFile, sessionDir, leafId });
    if (!sessionPath) {
      return { error: "failed to create forked subagent session." };
    }
    return { sessionPath };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: `failed to create forked subagent session: ${message}` };
  }
}

async function sendToTarget(
  registry: SubagentRegistry,
  target: string,
  messageInput: string,
  mode: "send" | "followup",
): Promise<AgentToolResult<SubagentToolDetails>> {
  const entry = registry.resolve(target);
  if (!entry) return errorResult(mode, `subagent not found: ${target}`, registry.list());
  const client = clients.get(entry.id);
  if (!client) return errorResult(mode, `subagent is not live: ${target}`, registry.list());
  const message = messageInput.trim();
  if (!message) return errorResult(mode, "message is required", registry.list());

  const command = entry.status === "running" ? (mode === "send" ? "steer" : "follow_up") : "prompt";
  const response = await client.send({ type: command, message });
  if (!response.success) return errorResult(mode, response.error ?? `${command} rejected`, registry.list());
  registry.markRunning(entry.id);
  return okResult(mode, `Sent input to ${entry.taskName}: ${previewText(message, 160)}`, registry.list(), entry.taskName);
}

function validateTimeout(timeoutMs: number | undefined): number {
  const value = timeoutMs ?? DEFAULT_SUBAGENT_OPTIONS.defaultWaitTimeoutMs;
  if (value < DEFAULT_SUBAGENT_OPTIONS.minWaitTimeoutMs) throw new Error(`timeout_ms must be at least ${DEFAULT_SUBAGENT_OPTIONS.minWaitTimeoutMs}`);
  if (value > DEFAULT_SUBAGENT_OPTIONS.maxWaitTimeoutMs) throw new Error(`timeout_ms must be at most ${DEFAULT_SUBAGENT_OPTIONS.maxWaitTimeoutMs}`);
  return value;
}

function okResult(action: SubagentToolDetails["action"], text: string, agents: SubagentSummary[], target?: string): AgentToolResult<SubagentToolDetails> {
  return { content: [{ type: "text", text }], details: { action, target, agents } };
}

function errorResult(action: SubagentToolDetails["action"], message: string, agents: SubagentSummary[]): AgentToolResult<SubagentToolDetails> {
  return { content: [{ type: "text", text: `Error: ${message}` }], details: { action, agents } };
}

function formatSummaryLine(summary: SubagentSummary): string {
  const suffix = summary.lastAssistantPreview ? ` - ${summary.lastAssistantPreview}` : summary.lastError ? ` - Error: ${summary.lastError}` : "";
  return `${summary.taskName}: ${summary.status}/${summary.lastTurnStatus}${suffix}`;
}
