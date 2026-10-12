import {
  getAgentDir,
  type AgentEndEvent,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type InputEvent,
  type SessionShutdownEvent,
} from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import {
  GLOBAL_SUMMARY_CONFIG_VERSION,
  MAX_CONTEXT_TURNS,
  MAX_SUMMARY_LINES,
  MIN_CONTEXT_TURNS,
  MIN_SUMMARY_LINES,
  loadGlobalSummaryConfig,
  saveGlobalSummaryConfig,
  type GlobalSummaryConfig,
  type GlobalSummaryConfigUpdate,
} from "./src/global-config.js";
import { findSummaryModelMatches, modelRef, resolveSummaryModel, summaryModelLabel, type SummaryModel } from "./src/model.js";
import { SessionSummaryOverlay } from "./src/overlay.js";
import { restoreSessionSummaryState, toPersistedEntry, upsertSummaryEntry } from "./src/state.js";
import {
  buildContextualAgentSummarySource,
  buildUserSummarySource,
  fallbackAgentSummary,
  fallbackUserSummary,
  runModelSummary,
  type SummaryRunner,
} from "./src/summarize.js";
import {
  SUMMARY_CUSTOM_ENTRY,
  SUMMARY_EVENT_VERSION,
  type SessionSummaryEntry,
  type SessionSummaryEvent,
  type SessionSummaryState,
  type SummaryRole,
} from "./src/types.js";

const ENABLED_FLAG = "session-summary";
const MODEL_FLAG = "session-summary-model";
const LINES_FLAG = "session-summary-lines";
const DEFAULT_VISIBLE_ROWS = 8;
const DEFAULT_CONTEXT_TURNS = 3;
const SHUTDOWN_WAIT_MS = 3_000;
const OPENSPEC_WIDGET_MOUNTED_EVENT = "openspec-progress:mounted";
const SCROLL_OLDER_KEY: KeyId = "alt+up";
const SCROLL_NEWER_KEY: KeyId = "alt+down";

let summaryRunner: SummaryRunner = runModelSummary;

export function _setSummaryRunnerForTest(runner?: SummaryRunner): void {
  summaryRunner = runner ?? runModelSummary;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseVisibleRows(
  value: boolean | string | undefined,
  fallback = DEFAULT_VISIBLE_ROWS,
): number {
  const parsed = typeof value === "string" ? Number.parseInt(value, 10) : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(MIN_SUMMARY_LINES, Math.min(MAX_SUMMARY_LINES, parsed));
}

function parseExplicitVisibleRows(value: string): number | undefined {
  if (!/^\d+$/.test(value.trim())) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= MIN_SUMMARY_LINES && parsed <= MAX_SUMMARY_LINES
    ? parsed
    : undefined;
}

function parseExplicitContextTurns(value: string): number | undefined {
  if (!/^\d+$/.test(value.trim())) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= MIN_CONTEXT_TURNS && parsed <= MAX_CONTEXT_TURNS
    ? parsed
    : undefined;
}

function isUserInput(event: InputEvent): boolean {
  const text = event.text.trim();
  return (event.source === "interactive" || event.source === "rpc")
    && Boolean(text)
    && !text.startsWith("/");
}

export interface SessionSummaryDependencies {
  agentDir?: string;
  loadGlobalConfig?: (agentDir: string) => Promise<GlobalSummaryConfig>;
  saveGlobalConfig?: (agentDir: string, update: GlobalSummaryConfigUpdate) => Promise<GlobalSummaryConfig>;
}

type ModelSelectionSource = "cli" | "session" | "global" | "main";

interface EffectiveModelSelection {
  ref?: string;
  source: ModelSelectionSource;
}

export default function sessionSummaryExtension(
  pi: ExtensionAPI,
  dependencies: SessionSummaryDependencies = {},
): void {
  pi.registerFlag(ENABLED_FLAG, {
    type: "boolean",
    default: true,
    description: "Show a persistent per-user/per-agent session summary above the editor.",
  });
  pi.registerFlag(MODEL_FLAG, {
    type: "string",
    description: "Dedicated summary model as provider/model, model id, or a unique model-name substring.",
  });
  pi.registerFlag(LINES_FLAG, {
    type: "string",
    description: `Override the summary rows from settings.json (${MIN_SUMMARY_LINES}-${MAX_SUMMARY_LINES}).`,
  });

  const agentDir = dependencies.agentDir ?? getAgentDir();
  const loadGlobalConfig = dependencies.loadGlobalConfig ?? loadGlobalSummaryConfig;
  const saveGlobalConfig = dependencies.saveGlobalConfig ?? saveGlobalSummaryConfig;

  let state: SessionSummaryState = { enabled: true, entries: [] };
  let globalConfig: GlobalSummaryConfig = { version: GLOBAL_SUMMARY_CONFIG_VERSION };
  let globalConfigError: string | undefined;
  let cliModelRef: string | undefined;
  let visibleRows = DEFAULT_VISIBLE_ROWS;
  let generation = 0;
  let sequence = 0;
  let queue: Promise<void> = Promise.resolve();
  let controller = new AbortController();
  let currentCtx: ExtensionContext | undefined;
  let lastError: string | undefined;

  const overlay = new SessionSummaryOverlay(() => {
    const selection = currentCtx ? effectiveModelSelection() : { ref: cliModelRef ?? state.modelRef ?? globalConfig.modelRef, source: "main" as const };
    return {
      entries: state.entries,
      modelLabel: currentCtx ? summaryModelLabel(currentCtx, selection.ref) : (selection.ref ?? "随主模型"),
      maxRows: visibleRows,
      error: lastError ?? globalConfigError,
    };
  });

  function enabled(): boolean {
    return state.enabled && process.env.PI_SESSION_SUMMARY !== "0";
  }

  function effectiveModelSelection(): EffectiveModelSelection {
    if (cliModelRef) return { ref: cliModelRef, source: "cli" };
    if (state.modelRef) return { ref: state.modelRef, source: "session" };
    if (globalConfig.modelRef) return { ref: globalConfig.modelRef, source: "global" };
    return { source: "main" };
  }

  async function reloadGlobalConfig(): Promise<void> {
    try {
      globalConfig = await loadGlobalConfig(agentDir);
      visibleRows = parseVisibleRows(
        pi.getFlag(LINES_FLAG),
        globalConfig.visibleRows ?? DEFAULT_VISIBLE_ROWS,
      );
      globalConfigError = undefined;
    } catch (error) {
      globalConfigError = errorText(error);
    }
  }

  function cancelPendingSummaries(): void {
    generation += 1;
    controller.abort();
    controller = new AbortController();
    queue = Promise.resolve();
    state = {
      ...state,
      entries: state.entries.map((entry) => entry.pending ? { ...entry, pending: false } : entry),
    };
  }

  function refresh(): void {
    if (!currentCtx?.hasUI) return;
    overlay.setUI(currentCtx.ui);
    if (enabled()) overlay.show();
    else overlay.hide();
  }

  function persist(event: SessionSummaryEvent): void {
    try {
      pi.appendEntry<SessionSummaryEvent>(SUMMARY_CUSTOM_ENTRY, event);
    } catch {
      // The visible summary remains useful even when the session is ephemeral.
    }
  }

  function persistConfig(changes: { enabled?: boolean; modelRef?: string | null }): void {
    persist({ version: SUMMARY_EVENT_VERSION, kind: "config", ...changes });
  }

  function addEntry(role: SummaryRole, fallback: string): SessionSummaryEntry {
    const previousCount = state.entries.length;
    const entry: SessionSummaryEntry = {
      id: `${role}-${Date.now().toString(36)}-${sequence++}`,
      role,
      summary: fallback,
      createdAt: Date.now(),
      pending: true,
    };
    state = { ...state, entries: upsertSummaryEntry(state.entries, entry) };
    overlay.onEntriesChanged(previousCount, state.entries.length);
    persist({
      version: SUMMARY_EVENT_VERSION,
      kind: "upsert",
      entry: toPersistedEntry(entry),
    });
    refresh();
    return entry;
  }

  function updateEntry(id: string, patch: Partial<Pick<SessionSummaryEntry, "summary" | "pending">>): boolean {
    const existing = state.entries.find((entry) => entry.id === id);
    if (!existing) return false;
    state = {
      ...state,
      entries: upsertSummaryEntry(state.entries, { ...existing, ...patch }),
    };
    refresh();
    return true;
  }

  function enqueueSummary(
    entry: SessionSummaryEntry,
    role: SummaryRole,
    source: string | ((contextTurns: number) => string),
    ctx: ExtensionContext,
  ): void {
    const jobGeneration = generation;
    const signal = controller.signal;

    queue = queue
      .catch(() => undefined)
      .then(async () => {
        if (signal.aborted || jobGeneration !== generation) return;
        // Re-read the tiny global config for each job so changing it in one Pi
        // session also affects other already-open sessions on their next row.
        await reloadGlobalConfig();
        if (signal.aborted || jobGeneration !== generation) return;
        const model: SummaryModel = resolveSummaryModel(ctx, effectiveModelSelection().ref);
        const resolvedSource = typeof source === "function"
          ? source(globalConfig.contextTurns ?? DEFAULT_CONTEXT_TURNS)
          : source;
        const summary = await summaryRunner({ role, source: resolvedSource, model, ctx, signal });
        if (signal.aborted || jobGeneration !== generation) return;
        if (!updateEntry(entry.id, { summary, pending: false })) return;
        lastError = undefined;
        const updated = state.entries.find((candidate) => candidate.id === entry.id);
        if (updated) {
          persist({
            version: SUMMARY_EVENT_VERSION,
            kind: "upsert",
            entry: toPersistedEntry(updated),
          });
        }
      })
      .catch((error) => {
        if (signal.aborted || jobGeneration !== generation) return;
        lastError = errorText(error);
        updateEntry(entry.id, { pending: false });
      });
  }

  async function restore(ctx: ExtensionContext): Promise<void> {
    cancelPendingSummaries();
    const restoreGeneration = generation;
    currentCtx = ctx;
    lastError = undefined;

    const restored = restoreSessionSummaryState(ctx.sessionManager.getBranch(), { enabled: true });
    const flagEnabled = pi.getFlag(ENABLED_FLAG);
    const flagModel = pi.getFlag(MODEL_FLAG);
    cliModelRef = typeof flagModel === "string" && flagModel.trim() ? flagModel.trim() : undefined;
    state = {
      ...restored,
      enabled: flagEnabled === false ? false : restored.enabled,
      entries: restored.entries.map((entry) => ({ ...entry, pending: false })),
    };
    await reloadGlobalConfig();
    if (restoreGeneration !== generation || currentCtx !== ctx) return;
    overlay.resetScroll();
    refresh();
  }

  // OpenSpec may mount before this async restore finishes. Re-registering the
  // summary after that mount makes its widget the stable lower row, preventing
  // a visible reorder when the summary state becomes available.
  if (pi.events && typeof pi.events.on === "function") {
    pi.events.on(OPENSPEC_WIDGET_MOUNTED_EVENT, () => refresh());
  }

  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));

  pi.registerShortcut(SCROLL_OLDER_KEY, {
    description: "scroll session summary toward older entries",
    handler: (ctx) => {
      if (!enabled() || !ctx.hasUI) return;
      currentCtx = ctx;
      overlay.setUI(ctx.ui);
      overlay.scrollOlder();
    },
  });
  pi.registerShortcut(SCROLL_NEWER_KEY, {
    description: "scroll session summary toward newer entries",
    handler: (ctx) => {
      if (!enabled() || !ctx.hasUI) return;
      currentCtx = ctx;
      overlay.setUI(ctx.ui);
      overlay.scrollNewer();
    },
  });

  pi.on("input", (event, ctx) => {
    if (!enabled() || !isUserInput(event)) return { action: "continue" };
    const source = event.text.trim();
    const branch = [...ctx.sessionManager.getBranch()];
    const entry = addEntry("user", fallbackUserSummary(source));
    enqueueSummary(entry, "user", (contextTurns) => (
      buildUserSummarySource(source, branch, contextTurns)
    ), ctx);
    return { action: "continue" };
  });

  pi.on("agent_end", (event: AgentEndEvent, ctx) => {
    if (!enabled()) return;
    const messages = [...event.messages];
    const branch = [...ctx.sessionManager.getBranch()];
    const entry = addEntry("agent", fallbackAgentSummary(messages));
    enqueueSummary(entry, "agent", (contextTurns) => (
      buildContextualAgentSummarySource(messages, branch, contextTurns)
    ), ctx);
  });

  pi.on("session_shutdown", async (event: SessionShutdownEvent) => {
    if (event.reason === "quit") {
      await Promise.race([
        queue.catch(() => undefined),
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, SHUTDOWN_WAIT_MS);
          timer.unref?.();
        }),
      ]);
    }
    generation += 1;
    controller.abort();
    overlay.dispose();
    currentCtx = undefined;
  });

  async function chooseModel(ctx: ExtensionCommandContext, query: string): Promise<SummaryModel | "inherit" | undefined> {
    const available = ctx.modelRegistry.getAvailable();
    if (!query) {
      if (!ctx.hasUI) return undefined;
      const inheritLabel = ctx.model ? `继承主模型 · ${modelRef(ctx.model)}` : "继承主模型";
      const labels = [inheritLabel, ...available.map((model) => `${modelRef(model)}${model.name ? ` · ${model.name}` : ""}`)];
      const selected = await ctx.ui.select("选择会话摘要模型", labels);
      if (!selected) return undefined;
      if (selected === inheritLabel) return "inherit";
      return available[labels.indexOf(selected) - 1];
    }

    if (["inherit", "current", "主模型"].includes(query.toLowerCase())) return "inherit";
    const matches = findSummaryModelMatches(available, query);
    if (matches.length <= 1) return matches[0];
    if (!ctx.hasUI) return undefined;
    const labels = matches.map((model) => `${modelRef(model)}${model.name ? ` · ${model.name}` : ""}`);
    const selected = await ctx.ui.select(`摘要模型 “${query}” 匹配到多个结果`, labels);
    return selected ? matches[labels.indexOf(selected)] : undefined;
  }

  pi.registerCommand("session-summary", {
    description: "Manage summary: status | on | off | clear | context <0-20> | lines <2-30> | model [global|session] [provider/model]",
    getArgumentCompletions: (prefix) => {
      const options = [
        "status",
        "on",
        "off",
        "clear",
        "context",
        "context inherit",
        "lines",
        "lines inherit",
        "model",
        "model inherit",
        "model global",
        "model global inherit",
        "model session",
        "model session inherit",
      ];
      const normalized = prefix.trim().toLowerCase();
      return options
        .filter((option) => option.startsWith(normalized))
        .map((option) => ({ value: option, label: option }));
    },
    handler: async (args, ctx) => {
      const [sub = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      switch (sub.toLowerCase()) {
        case "on":
          state = { ...state, enabled: true };
          persistConfig({ enabled: true });
          refresh();
          ctx.ui.notify("会话脉络已开启。", "info");
          return;
        case "off":
          cancelPendingSummaries();
          state = { ...state, enabled: false };
          persistConfig({ enabled: false });
          refresh();
          ctx.ui.notify("会话脉络已关闭。", "info");
          return;
        case "clear":
          cancelPendingSummaries();
          state = { ...state, entries: [] };
          overlay.resetScroll();
          lastError = undefined;
          persist({ version: SUMMARY_EVENT_VERSION, kind: "clear" });
          refresh();
          ctx.ui.notify("当前会话的脉络摘要已清空。", "info");
          return;
        case "context":
        case "context-turns": {
          const value = rest.join(" ").trim().toLowerCase();
          const selectedTurns = value === "inherit" || value === "default"
            ? undefined
            : parseExplicitContextTurns(value);
          if (selectedTurns === undefined && value !== "inherit" && value !== "default") {
            ctx.ui.notify(`用法：/session-summary context <${MIN_CONTEXT_TURNS}-${MAX_CONTEXT_TURNS}|inherit>`, "warning");
            return;
          }
          try {
            globalConfig = await saveGlobalConfig(agentDir, {
              contextTurns: selectedTurns ?? null,
            });
            globalConfigError = undefined;
          } catch (error) {
            globalConfigError = errorText(error);
            refresh();
            ctx.ui.notify(`保存 summary 上下文轮数失败：${globalConfigError}`, "error");
            return;
          }
          refresh();
          ctx.ui.notify(
            selectedTurns !== undefined
              ? `所有会话的 summary 上下文已设为最近 ${selectedTurns} 轮。`
              : `已清除上下文轮数设置，将使用默认值 ${DEFAULT_CONTEXT_TURNS} 轮。`,
            "info",
          );
          return;
        }
        case "lines": {
          const value = rest.join(" ").trim().toLowerCase();
          const selectedRows = value === "inherit" || value === "default"
            ? undefined
            : parseExplicitVisibleRows(value);
          if (selectedRows === undefined && value !== "inherit" && value !== "default") {
            ctx.ui.notify(`用法：/session-summary lines <${MIN_SUMMARY_LINES}-${MAX_SUMMARY_LINES}|inherit>`, "warning");
            return;
          }
          try {
            globalConfig = await saveGlobalConfig(agentDir, {
              visibleRows: selectedRows ?? null,
            });
            visibleRows = parseVisibleRows(
              pi.getFlag(LINES_FLAG),
              selectedRows ?? DEFAULT_VISIBLE_ROWS,
            );
            globalConfigError = undefined;
          } catch (error) {
            globalConfigError = errorText(error);
            refresh();
            ctx.ui.notify(`保存 summary 展示条数失败：${globalConfigError}`, "error");
            return;
          }
          refresh();
          const flagRows = pi.getFlag(LINES_FLAG);
          const override = typeof flagRows === "string" && flagRows.trim()
            ? ` 当前进程仍由 --${LINES_FLAG}=${visibleRows} 覆盖。`
            : "";
          ctx.ui.notify(
            selectedRows !== undefined
              ? `所有会话的 summary 展示条数已设为 ${selectedRows}。${override}`
              : `已清除全局展示条数，将使用默认值 ${DEFAULT_VISIBLE_ROWS}。${override}`,
            "info",
          );
          return;
        }
        case "model": {
          const modelArgs = [...rest];
          const scopeToken = modelArgs[0]?.toLowerCase();
          const scope = scopeToken === "session" || scopeToken === "local"
            ? "session"
            : "global";
          if (scopeToken === "global" || scopeToken === "all" || scopeToken === "session" || scopeToken === "local") {
            modelArgs.shift();
          }
          const query = modelArgs.join(" ").trim();
          const selected = await chooseModel(ctx, query);
          if (!selected) {
            const message = query
              ? `没有唯一匹配的可用模型 “${query}”；请使用 provider/model 精确指定。`
              : "用法：/session-summary model [global|session] <provider/model>（交互模式可省略模型名）";
            ctx.ui.notify(message, "warning");
            return;
          }
          const selectedRef = selected === "inherit" ? undefined : modelRef(selected);
          lastError = undefined;

          if (scope === "global") {
            try {
              globalConfig = await saveGlobalConfig(agentDir, {
                modelRef: selectedRef ?? null,
              });
              globalConfigError = undefined;
            } catch (error) {
              globalConfigError = errorText(error);
              refresh();
              ctx.ui.notify(`保存会话摘要全局模型失败：${globalConfigError}`, "error");
              return;
            }
            refresh();
            const effective = effectiveModelSelection();
            const override = effective.source === "session"
              ? ` 当前会话仍由会话级模型 ${effective.ref} 覆盖。`
              : effective.source === "cli"
                ? ` 当前进程仍由 --${MODEL_FLAG}=${effective.ref} 覆盖。`
                : "";
            ctx.ui.notify(
              selectedRef
                ? `所有会话的默认摘要模型已设为 ${selectedRef}。${override}`
                : `已清除全局摘要模型；未单独覆盖的会话将跟随主模型。${override}`,
              "info",
            );
            return;
          }

          state = { ...state, modelRef: selectedRef };
          persistConfig({ modelRef: selectedRef ?? null });
          refresh();
          ctx.ui.notify(
            selectedRef
              ? `当前会话摘要模型已设为 ${selectedRef}。`
              : `已清除当前会话模型覆盖，将使用${globalConfig.modelRef ? `全局默认 ${globalConfig.modelRef}` : "主模型"}。`,
            "info",
          );
          return;
        }
        case "status": {
          await reloadGlobalConfig();
          const selection = effectiveModelSelection();
          const label = summaryModelLabel(ctx, selection.ref);
          const sourceLabels: Record<ModelSelectionSource, string> = {
            cli: "启动参数",
            session: "当前会话覆盖",
            global: "全局默认",
            main: "主模型",
          };
          const globalLabel = globalConfig.modelRef ?? "未设置";
          const globalRows = globalConfig.visibleRows ?? DEFAULT_VISIBLE_ROWS;
          const contextTurns = globalConfig.contextTurns ?? DEFAULT_CONTEXT_TURNS;
          const failure = lastError ?? globalConfigError;
          const error = failure ? `；最近错误：${failure}` : "";
          ctx.ui.notify(
            `summary：${enabled() ? "开启" : "关闭"}；有效模型：${label}（${sourceLabels[selection.source]}）；全局默认：${globalLabel}；上下文：${contextTurns} 轮；已记录 ${state.entries.length} 条；显示 ${visibleRows} 条（settings.json：${globalRows}）${error}`,
            failure ? "warning" : "info",
          );
          refresh();
          return;
        }
        default:
          ctx.ui.notify("用法：/session-summary [status|on|off|clear|context <0-20|inherit>|lines <2-30|inherit>|model [global|session] [provider/model|inherit]]", "warning");
      }
    },
  });
}
