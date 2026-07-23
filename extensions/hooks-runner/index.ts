// pi-hooks-runner-extension — a configuration-driven user hook framework that
// bridges pi's lifecycle events onto Claude's JSON hook decision protocol.
//
// index.ts owns ALL pi API interaction and side effects: reading config files,
// spawning shells, UI prompts, appendEntry persistence, and the pending-context
// buffer. Every decision helper (config parse, matcher, protocol decode, trust
// reduce) is a pure function under src/, with the process spawn injected so the
// wiring stays testable without running a real shell.
//
// Event bridge (pi → Claude HookEventName):
//   tool_call            → PreToolUse   (block / mutate input / add context)
//   tool_result          → PostToolUse  (append context / flag error)
//   input                → UserPromptSubmit (transform / handled)
//   agent_end            → Stop         (soft continuation via sendUserMessage)
//   session_start        → SessionStart (context / initialUserMessage buffer)
//   session_shutdown     → SessionEnd   (fire-and-forget)
//   session_before_compact → PreCompact (cancel on block)
//
// PreToolUse/SessionStart additionalContext has no direct injection return, so
// it is buffered and flushed on the next before_agent_start as a display:false
// message (same pattern as the goal extension).

import { readFileSync, existsSync } from "node:fs";
import os from "node:os";
import { spawn as nodeSpawn } from "node:child_process";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
  ToolCallEvent,
  ToolCallEventResult,
  ToolResultEvent,
  InputEvent,
  InputEventResult,
  AgentEndEvent,
  SessionStartEvent,
  SessionShutdownEvent,
  SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { truncateHead, DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import type { TextContent, ImageContent } from "@earendil-works/pi-ai";

// pi's package entry does not re-export these handler *result* types, so we
// mirror their shapes locally (kept structurally compatible with pi's real
// ToolResultEventResult / SessionBeforeCompactResult so the pi.on overloads
// still accept our handlers).
type ToolResultEventResult = {
  content?: (TextContent | ImageContent)[];
  details?: unknown;
  isError?: boolean;
};
type SessionBeforeCompactResult = {
  cancel?: boolean;
};
import { computeConfigPaths, mergeHooksConfigs, parseHooksConfig } from "./src/config.js";
import { getMatchingHooks, isCommandHook, normalizeToolName } from "./src/matcher.js";
import {
  buildHookInput,
  decodeDecision,
  mergeDecisions,
  serializeHookInput,
  type HookInputBase,
} from "./src/protocol.js";
import { runCommandHook, type SpawnedChild, type SpawnFn } from "./src/executor.js";
import { loadPluginHooks, mergeHooksConfig, type PluginHookDescriptor } from "./src/pluginHooks.js";
import { hashHookCommand, isTrusted, reduceTrustEntries, TRUST_ENTRY } from "./src/trust.js";
import type {
  EntryLike,
  Hook,
  HookDecision,
  HookEventName,
  HooksConfig,
} from "./src/types.js";

const HOOK_CONTEXT_MESSAGE = "hooks-runner-context";

/** Injectable dependencies (tests pass a fake spawn so no real shell runs). */
export interface HooksRunnerDeps {
  spawn?: SpawnFn;
}

/** Wrap injected context so the model can tell it apart from user text. */
function hookContextContent(text: string): string {
  return `<hook_context>\n${text}\n</hook_context>`;
}

/** Real process spawn conforming to the executor's injectable SpawnFn. */
const realSpawnHook: SpawnFn = (command, args, options): SpawnedChild => {
  const child = nodeSpawn(command, args, {
    cwd: options.cwd,
    env: options.env as NodeJS.ProcessEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  return child as unknown as SpawnedChild;
};

/** Map a pi session_start reason onto Claude's SessionStart `source`. */
function mapSessionStartSource(reason: SessionStartEvent["reason"]): string {
  switch (reason) {
    case "resume":
    case "fork":
      return "resume";
    case "startup":
    case "new":
    case "reload":
    default:
      return "startup";
  }
}

/** Map a pi session_shutdown reason onto Claude's SessionEnd `reason`. */
function mapExitReason(reason: SessionShutdownEvent["reason"]): string {
  switch (reason) {
    case "quit":
      return "other";
    case "resume":
      return "resume";
    case "new":
      return "clear";
    case "reload":
      return "other";
    case "fork":
      return "other";
    default:
      return "other";
  }
}

/** Flatten tool-result content into a plain string for tool_response. */
function contentToText(content: (TextContent | ImageContent)[]): string {
  return content
    .map((c) => (c.type === "text" ? c.text : "[image]"))
    .join("\n");
}

/** Replace all keys on `target` with those from `next` (in-place mutation). */
function replaceInput(target: Record<string, unknown>, next: Record<string, unknown>): void {
  for (const k of Object.keys(target)) delete target[k];
  Object.assign(target, next);
}

export default function hooksRunnerExtension(pi: ExtensionAPI, deps: HooksRunnerDeps = {}): void {
  const spawnHook = deps.spawn ?? realSpawnHook;
  let config: HooksConfig | undefined;
  let baseConfig: HooksConfig = {};
  let pluginHookDescriptors: PluginHookDescriptor[] = [];
  let trusted = new Set<string>();
  let pendingContext: string[] = [];
  let lastUi: ExtensionContext["ui"] | undefined;
  // Guards the Stop → continuation loop: once we have injected a continuation
  // followUp, we do not do it again until a fresh user turn resets this.
  let stopHookActive = false;

  const notify = (msg: string, type: "info" | "warning" | "error" = "info"): void => {
    try {
      lastUi?.notify(msg, type);
    } catch {
      // notify must never throw
    }
  };

  const readFileSafe = (p: string): string => {
    try {
      return existsSync(p) ? readFileSync(p, "utf8") : "";
    } catch {
      return "";
    }
  };

  const baseInput = (ctx: ExtensionContext): HookInputBase => {
    let sessionId = "";
    let transcriptPath = "";
    try {
      sessionId = ctx.sessionManager.getSessionId();
    } catch {
      // ignore
    }
    try {
      transcriptPath = ctx.sessionManager.getSessionFile() ?? "";
    } catch {
      // ignore
    }
    return { session_id: sessionId, transcript_path: transcriptPath, cwd: ctx.cwd };
  };

  /**
   * Gate a hook through the trust prompt. Returns true when the hook may run.
   * Trusted hooks pass immediately. Untrusted hooks prompt via confirm when a
   * UI is present (recording the hash on approval); without a UI we fail safe
   * by skipping (never auto-running an unconfirmed shell command).
   */
  const gateTrust = async (hook: Hook, ctx: ExtensionContext): Promise<boolean> => {
    if (isTrusted(trusted, hook)) return true;
    const label = hook.type === "command" ? hook.command : `${hook.type} hook`;
    if (!ctx.hasUI) {
      notify(`Skipping untrusted hook (no UI to confirm): ${label}`, "warning");
      return false;
    }
    const ok = await ctx.ui.confirm(
      "Trust this hook?",
      `A configured hook wants to run:\n\n${label}\n\nRun it (and remember this exact command)?`,
    );
    if (!ok) {
      notify(`Hook not trusted; skipped: ${label}`, "info");
      return false;
    }
    const hash = hashHookCommand(hook);
    trusted.add(hash);
    pi.appendEntry(TRUST_ENTRY, { hash });
    return true;
  };

  /**
   * Run every matching hook for an event through trust gating + execution, and
   * return the merged decision (undefined when nothing ran). Non-command hooks
   * are recognized but not executed in the MVP.
   */
  const gateAndRun = async (
    eventName: HookEventName,
    matchQuery: string,
    toolInput: Record<string, unknown> | undefined,
    payload: Record<string, unknown>,
    ctx: ExtensionContext,
  ): Promise<HookDecision | undefined> => {
    if (!config) return undefined;
    const hooks = getMatchingHooks(config, eventName, matchQuery, toolInput);
    if (hooks.length === 0) return undefined;

    const input = buildHookInput(eventName, baseInput(ctx), payload);
    const json = serializeHookInput(input);

    const decisions: HookDecision[] = [];
    for (const hook of hooks) {
      if (!isCommandHook(hook)) {
        notify(`Skipping ${hook.type} hook for ${eventName} (phase 2, not yet implemented).`, "info");
        continue;
      }
      if (!(await gateTrust(hook, ctx))) continue;

      const result = await runCommandHook(hook, json, {
        spawn: spawnHook,
        cwd: ctx.cwd,
        timeoutMs: hook.timeout !== undefined ? hook.timeout * 1000 : undefined,
        env: { PI_HOOK_INPUT: json.trimEnd() },
      });
      if (result.skipped) {
        if (result.skipReason) notify(result.skipReason, "info");
        continue;
      }
      decisions.push(decodeDecision(result));
    }
    if (decisions.length === 0) return undefined;

    const merged = mergeDecisions(decisions);
    // Cap injected context so a chatty hook can't blow up the token budget.
    if (merged.additionalContext) {
      merged.additionalContext = truncateHead(merged.additionalContext, {
        maxBytes: DEFAULT_MAX_BYTES,
      }).content;
    }
    return merged;
  };

  // ---- tool_call → PreToolUse ----

  pi.on(
    "tool_call",
    async (event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | void> => {
      lastUi = ctx.ui;
      const toolInput = event.input as unknown as Record<string, unknown>;
      const payload = {
        tool_name: normalizeToolName(event.toolName),
        tool_input: toolInput,
        tool_use_id: event.toolCallId,
      };
      const decision = await gateAndRun("PreToolUse", event.toolName, toolInput, payload, ctx);
      if (!decision) return;

      if (decision.updatedInput) replaceInput(toolInput, decision.updatedInput);
      if (decision.additionalContext) pendingContext.push(decision.additionalContext);
      if (decision.systemMessage) notify(decision.systemMessage, "info");
      if (decision.block) {
        return { block: true, reason: decision.reason ?? "Blocked by a PreToolUse hook." };
      }
    },
  );

  // ---- tool_result → PostToolUse ----

  pi.on(
    "tool_result",
    async (event: ToolResultEvent, ctx: ExtensionContext): Promise<ToolResultEventResult | void> => {
      lastUi = ctx.ui;
      const payload = {
        tool_name: normalizeToolName(event.toolName),
        tool_input: event.input,
        tool_response: contentToText(event.content),
        tool_use_id: event.toolCallId,
      };
      const decision = await gateAndRun("PostToolUse", event.toolName, event.input, payload, ctx);
      if (!decision) return;
      if (decision.systemMessage) notify(decision.systemMessage, "info");

      const result: ToolResultEventResult = {};
      const extra: TextContent[] = [];
      if (decision.additionalContext) {
        extra.push({ type: "text", text: decision.additionalContext });
      }
      if (decision.block) {
        result.isError = true;
        extra.push({ type: "text", text: decision.reason ?? "A PostToolUse hook flagged this result." });
      }
      if (extra.length > 0) result.content = [...event.content, ...extra];
      return Object.keys(result).length > 0 ? result : undefined;
    },
  );

  // ---- input → UserPromptSubmit ----

  pi.on(
    "input",
    async (event: InputEvent, ctx: ExtensionContext): Promise<InputEventResult | void> => {
      lastUi = ctx.ui;
      // A real user turn resets the Stop-continuation guard.
      if (event.source !== "extension") stopHookActive = false;
      // Never run on our own injected messages — that would recurse.
      if (event.source === "extension") return;

      const decision = await gateAndRun("UserPromptSubmit", "", undefined, { prompt: event.text }, ctx);
      if (!decision) return;
      if (decision.systemMessage) notify(decision.systemMessage, "info");
      if (decision.block) {
        notify(decision.reason ?? "Prompt blocked by a UserPromptSubmit hook.", "warning");
        return { action: "handled" };
      }
      if (decision.additionalContext) {
        return { action: "transform", text: `${event.text}\n\n${decision.additionalContext}` };
      }
    },
  );

  // ---- agent_end → Stop ----

  pi.on("agent_end", async (_event: AgentEndEvent, ctx: ExtensionContext): Promise<void> => {
    lastUi = ctx.ui;
    const decision = await gateAndRun("Stop", "", undefined, { stop_hook_active: stopHookActive }, ctx);
    if (!decision) return;
    if (decision.additionalContext) pendingContext.push(decision.additionalContext);
    if (decision.systemMessage) notify(decision.systemMessage, "info");
    if (decision.block && !stopHookActive) {
      // Soft continuation: pi has no "prevent stop" return on agent_end, so we
      // re-prompt the agent once. stop_hook_active guards against loops.
      stopHookActive = true;
      pi.sendUserMessage(decision.reason ?? "A Stop hook requested the agent keep working.", {
        deliverAs: "followUp",
      });
    }
  });

  // ---- session_start → SessionStart ----

  pi.events.on("plugins:replace-hooks", (payload: unknown) => {
    pluginHookDescriptors = payload && typeof payload === "object" && Array.isArray((payload as { hooks?: unknown }).hooks)
      ? (payload as { hooks: PluginHookDescriptor[] }).hooks
      : [];
    try { config = mergeHooksConfig(baseConfig, loadPluginHooks(pluginHookDescriptors)); }
    catch (error) {
      config = baseConfig;
      notify(`plugin hooks: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
  });

  pi.on("session_start", async (event: SessionStartEvent, ctx: ExtensionContext): Promise<void> => {
    lastUi = ctx.ui;
    const home = os.homedir();
    const paths = computeConfigPaths(home, ctx.cwd);
    const g = parseHooksConfig(readFileSafe(paths.globalPath));
    const p = parseHooksConfig(readFileSafe(paths.projectPath));
    for (const w of [...g.warnings, ...p.warnings]) notify(`hooks config: ${w}`, "warning");
    baseConfig = mergeHooksConfigs(g.config, p.config);
    try { config = mergeHooksConfig(baseConfig, loadPluginHooks(pluginHookDescriptors)); }
    catch (error) {
      config = baseConfig;
      notify(`plugin hooks: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }

    // Rebuild the trusted set from the branch on every session_start.
    const branch = ctx.sessionManager.getBranch() as unknown as EntryLike[];
    trusted = reduceTrustEntries(branch);

    const decision = await gateAndRun(
      "SessionStart",
      "",
      undefined,
      { source: mapSessionStartSource(event.reason) },
      ctx,
    );
    if (!decision) return;
    if (decision.systemMessage) notify(decision.systemMessage, "info");
    if (decision.additionalContext) pendingContext.push(decision.additionalContext);
    // initialUserMessage is buffered as context in the MVP (no separate seed API).
    if (decision.initialUserMessage) pendingContext.push(decision.initialUserMessage);
  });

  // ---- session_shutdown → SessionEnd (fire-and-forget) ----

  pi.on("session_shutdown", async (event: SessionShutdownEvent, ctx: ExtensionContext): Promise<void> => {
    if (!config) return;
    try {
      await gateAndRun("SessionEnd", "", undefined, { reason: mapExitReason(event.reason) }, ctx);
    } catch {
      // never block shutdown
    }
  });

  // ---- session_before_compact → PreCompact ----

  pi.on(
    "session_before_compact",
    async (
      event: SessionBeforeCompactEvent,
      ctx: ExtensionContext,
    ): Promise<SessionBeforeCompactResult | void> => {
      lastUi = ctx.ui;
      const decision = await gateAndRun(
        "PreCompact",
        "",
        undefined,
        { trigger: "manual", custom_instructions: event.customInstructions ?? null },
        ctx,
      );
      if (!decision) return;
      if (decision.systemMessage) notify(decision.systemMessage, "info");
      if (decision.block) return { cancel: true };
    },
  );

  // ---- before_agent_start: flush buffered context ----

  pi.on("before_agent_start", async () => {
    if (pendingContext.length === 0) return;
    const content = pendingContext.join("\n\n");
    pendingContext = [];
    return {
      message: {
        customType: HOOK_CONTEXT_MESSAGE,
        content: hookContextContent(content),
        display: false,
      },
    };
  });

  // ---- /hooks command (read-only list) ----

  pi.registerCommand("hooks", {
    description: "List configured lifecycle hooks and their trust status.",
    async handler(_args: string, ctx: ExtensionCommandContext): Promise<void> {
      lastUi = ctx.ui;
      if (!config) {
        ctx.ui.notify("Hooks not loaded yet (no session_start seen).", "info");
        return;
      }
      const events = Object.keys(config) as HookEventName[];
      if (events.length === 0) {
        ctx.ui.notify(
          "No hooks configured. Add ~/.pi/agent/hooks.json or .pi/hooks.json (Claude hooks shape).",
          "info",
        );
        return;
      }
      const lines: string[] = [];
      for (const event of events) {
        const matchers = config[event] ?? [];
        lines.push(`${event}:`);
        for (const m of matchers) {
          const pattern = m.matcher ?? "*";
          const ifStr = m.if ? ` if=${m.if}` : "";
          for (const hook of m.hooks) {
            const desc =
              hook.type === "command"
                ? hook.command
                : hook.type === "http"
                  ? hook.url
                  : hook.prompt;
            const trust = isCommandHook(hook)
              ? isTrusted(trusted, hook)
                ? "trusted"
                : "untrusted"
              : "phase-2";
            lines.push(`  • [${pattern}${ifStr}] ${hook.type}: ${desc} (${trust})`);
          }
        }
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
