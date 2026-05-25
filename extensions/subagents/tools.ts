import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { SubagentRegistry } from "./registry.js";
import type { SubagentSummary, SubagentToolDetails } from "./types.js";
import { DEFAULT_SUBAGENT_OPTIONS } from "./types.js";
import { normalizeTaskName } from "./text.js";
import { renderSubagentCall, renderSubagentResult } from "./render.js";
import { forkMetadataFromContext, type SubagentRuntime } from "./runtime.js";

const SpawnAgentParams = Type.Object({
  task_name: Type.String({ description: "Task name for the new agent. Use lowercase letters, digits, underscores, or hyphens." }),
  message: Type.String({ description: "Initial message to send to the subagent." }),
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

const FORK_CONTEXT_GUIDELINE =
  "Only set spawn_agent.fork_context to true when the user explicitly asks for a forked/cloned/current-context subagent. Omit it for normal independent subagents.";

export function createSubagentTools(
  registry: SubagentRegistry,
  runtime: SubagentRuntime,
): ToolDefinition<any, SubagentToolDetails>[] {
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
        const cwd = params.cwd?.trim() || ctx.cwd;
        const session = params.fork_context === true ? forkMetadataFromContext(ctx) : undefined;
        if (session && "error" in session) return errorResult("spawn", session.error, registry.list());
        const result = await runtime.spawn({
          taskName,
          message: params.message,
          cwd,
          provider: ctx.model?.provider,
          model: params.model ?? ctx.model?.id,
          apiKey: await resolveCurrentApiKey(ctx),
          forkContext: params.fork_context === true,
          session,
        });
        return result.ok
          ? okResult("spawn", result.text, registry.list(), taskName)
          : errorResult("spawn", result.error ?? result.text.replace(/^Error: /, ""), registry.list());
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
        const result = await runtime.sendToTarget(params.target, params.message, "send");
        return result.ok
          ? okResult("send", result.text, registry.list(), result.target)
          : errorResult("send", result.error ?? result.text.replace(/^Error: /, ""), registry.list());
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
        const result = await runtime.sendToTarget(params.target, params.message, "followup");
        return result.ok
          ? okResult("followup", result.text, registry.list(), result.target)
          : errorResult("followup", result.error ?? result.text.replace(/^Error: /, ""), registry.list());
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
        const result = await runtime.closeTarget(params.target);
        return result.ok
          ? okResult("close", result.text, registry.list(), result.target)
          : errorResult("close", result.error ?? result.text.replace(/^Error: /, ""), registry.list());
      },
    },
  ];
}

async function resolveCurrentApiKey(ctx: { model?: { provider: string } | undefined; modelRegistry?: { getApiKeyForProvider(provider: string): Promise<string | undefined> } | undefined }): Promise<string | undefined> {
  if (!ctx.model) return undefined;
  return ctx.modelRegistry?.getApiKeyForProvider(ctx.model.provider);
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
