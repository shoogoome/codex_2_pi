import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { ExtensionCommandRunner } from "../shared/git.js";
import type { CommandRunner } from "../shared/types.js";
import { resolveRepoTarget } from "./src/git.js";
import { RepoBranchOverlay } from "./src/overlay.js";
import { renderRepoBranchCall, renderRepoBranchResult } from "./src/render.js";
import {
  clearRepoBranches,
  createInitialState,
  findMatchingRecord,
  removeRepoBranch,
  restoreStateFromBranch,
  setVisible,
  upsertRepoBranch,
  validateLabel,
} from "./src/state.js";
import {
  DEFAULT_MAX_VISIBLE_ROWS,
  REPO_BRANCH_ENTRY,
  type RepoBranchAction,
  type RepoBranchState,
  type RepoBranchToolDetails,
} from "./src/types.js";

const ENABLED_FLAG = "repo-branch";
const ACTIONS = ["record", "remove", "clear", "list"] as const;

export const RepoBranchParamsSchema = Type.Object(
  {
    action: Type.Optional(
      StringEnum(ACTIONS, {
        description:
          "操作类型：record（记录或更新仓库分支，默认）、remove（移除指定仓库）、clear（清空全部记录）、list（查看当前记录）。",
      }),
    ),
    repo: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 1000,
        description: "仓库路径或名称；执行 record/remove 时省略，则默认使用当前工作目录（ctx.cwd）所属的 Git 仓库。",
      }),
    ),
    branch: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 300,
        description: "当前使用的分支名称；执行 record 时若省略，会自动读取目标仓库当前检出的 Git 分支。",
      }),
    ),
  },
  { additionalProperties: false },
);

export type RepoBranchParams = Static<typeof RepoBranchParamsSchema>;

export interface RepoBranchDependencies {
  createRunner?: (pi: ExtensionAPI) => CommandRunner;
  argv?: readonly string[];
}

export function resolveRepoBranchCliFlag(
  flagValue: unknown,
  argv: readonly string[] = process.argv.slice(2),
): boolean {
  let explicit: boolean | undefined;
  for (const arg of argv) {
    if (arg === "--") break;
    if (arg === `--${ENABLED_FLAG}`) explicit = true;
    else if (arg === `--no-${ENABLED_FLAG}`) explicit = false;
    else if (arg.startsWith(`--${ENABLED_FLAG}=`)) {
      const raw = arg.slice(`--${ENABLED_FLAG}=`.length).trim().toLowerCase();
      if (raw === "false" || raw === "0" || raw === "off" || raw === "no") explicit = false;
      else if (raw === "true" || raw === "1" || raw === "on" || raw === "yes" || raw === "") explicit = true;
    }
  }
  if (explicit !== undefined) return explicit;
  if (typeof flagValue === "boolean") return flagValue;
  return true;
}

function formatRecordsSummary(state: RepoBranchState): string {
  if (state.records.length === 0) return "当前会话暂无仓库分支记录。";
  return state.records
    .map((record) => `${record.name}: ${record.branch}${record.path ? ` (${record.path})` : ""}`)
    .join("\n");
}

export default function repoBranchExtension(
  pi: ExtensionAPI,
  dependencies: RepoBranchDependencies = {},
): void {
  pi.registerFlag(ENABLED_FLAG, {
    type: "boolean",
    default: true,
    description: "Show a persistent repository-branch box above the editor.",
  });

  const createRunner = dependencies.createRunner ?? ((api: ExtensionAPI) => new ExtensionCommandRunner(api));

  let state: RepoBranchState = createInitialState(true);
  let cliDisabled = false;
  let currentCtx: ExtensionContext | undefined;

  const overlay = new RepoBranchOverlay(() => ({
    records: state.records,
    maxRows: DEFAULT_MAX_VISIBLE_ROWS,
  }));

  function isWidgetVisible(): boolean {
    if (process.env.PI_REPO_BRANCH === "0") return false;
    if (cliDisabled) return false;
    return state.visible;
  }

  function persist(): void {
    try {
      pi.appendEntry<RepoBranchState>(REPO_BRANCH_ENTRY, state);
    } catch {
      // Ephemeral sessions remain functional in memory.
    }
  }

  function refresh(ctx: ExtensionContext | undefined = currentCtx): void {
    if (!ctx?.hasUI) return;
    overlay.setUI(ctx.ui);
    if (isWidgetVisible()) overlay.show();
    else overlay.hide();
  }

  function restoreFromContext(ctx: ExtensionContext, applyStartupFlags: boolean): void {
    currentCtx = ctx;
    if (applyStartupFlags) {
      const enabledByCli = resolveRepoBranchCliFlag(pi.getFlag(ENABLED_FLAG), dependencies.argv);
      cliDisabled = !enabledByCli;
    }
    state = restoreStateFromBranch(ctx.sessionManager.getBranch(), !cliDisabled);
    refresh(ctx);
  }

  async function executeAction(
    params: RepoBranchParams,
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ): Promise<RepoBranchToolDetails> {
    signal?.throwIfAborted();
    const action: RepoBranchAction = params.action ?? "record";
    const sessionId = ctx.sessionManager.getSessionId();
    const runner = createRunner(pi);

    if (action === "list") {
      return {
        ok: true,
        action: "list",
        sessionId,
        changed: false,
        records: [...state.records],
      };
    }

    if (action === "clear") {
      const cleared = clearRepoBranches(state);
      if (cleared.clearedCount > 0) {
        state = cleared.state;
        persist();
        refresh(ctx);
      }
      return {
        ok: true,
        action: "clear",
        sessionId,
        changed: cleared.clearedCount > 0,
        clearedCount: cleared.clearedCount,
        records: [...state.records],
      };
    }

    if (action === "remove") {
      let query = params.repo?.trim() ?? "";
      let resolvedKey: string | undefined;
      if (!query) {
        const current = await resolveRepoTarget(runner, ctx.cwd, undefined, signal);
        query = current.name;
        resolvedKey = current.key;
      } else {
        const directMatch = findMatchingRecord(state.records, query);
        if (!directMatch) {
          const resolved = await resolveRepoTarget(runner, ctx.cwd, query, signal);
          resolvedKey = resolved.key;
        }
      }
      signal?.throwIfAborted();
      const removedResult = removeRepoBranch(state, query, resolvedKey);
      if (removedResult.removed) {
        state = removedResult.state;
        persist();
        refresh(ctx);
      }
      return {
        ok: true,
        action: "remove",
        sessionId,
        changed: Boolean(removedResult.removed),
        ...(removedResult.removed ? { removed: removedResult.removed } : {}),
        records: [...state.records],
      };
    }

    // action === "record"
    const rawRepo = params.repo !== undefined ? validateLabel(params.repo, "repo", 1000) : undefined;
    const explicitBranch = params.branch !== undefined ? validateLabel(params.branch, "branch", 300) : undefined;

    let target = await resolveRepoTarget(runner, ctx.cwd, rawRepo, signal);
    signal?.throwIfAborted();

    if (!target.path && rawRepo) {
      const existing = findMatchingRecord(state.records, rawRepo);
      if (existing) {
        if (existing.path) {
          target = await resolveRepoTarget(runner, ctx.cwd, existing.path, signal);
          signal?.throwIfAborted();
        } else {
          target = {
            key: existing.key,
            name: existing.name,
            detectedBranch: existing.detectedBranch,
          };
        }
      }
    }

    const branch = explicitBranch ?? target.detectedBranch;
    if (!branch) {
      throw new Error(
        `branch is required because no Git branch could be detected for "${target.name}"`,
      );
    }

    const upserted = upsertRepoBranch(state, {
      key: target.key,
      name: target.name,
      path: target.path,
      branch,
      detectedBranch: target.detectedBranch,
    });

    if (upserted.changed) {
      state = upserted.state;
      persist();
      refresh(ctx);
    }

    return {
      ok: true,
      action: "record",
      sessionId,
      changed: upserted.changed,
      record: upserted.record,
      records: [...state.records],
    };
  }

  pi.registerTool<typeof RepoBranchParamsSchema, RepoBranchToolDetails>({
    name: "record_repo_branch",
    label: "Record Repo Branch",
    description:
      "记录当前会话涉及的代码仓库及其使用的 Git 分支，并更新输入框上方的常驻仓库分支展示框。支持 record（默认，记录或更新仓库分支，可省略 repo 自动识别当前工作目录、省略 branch 自动读取当前 Git 分支）、remove（移除仓库）、clear（清空）和 list（查看当前记录）。",
    promptSnippet: "记录或管理当前会话涉及的仓库与对应 Git 分支",
    promptGuidelines: [
      "Use record_repo_branch when starting work in a git repository, checking out or creating a branch, or switching to another repository in the current session so the tracked repository-branch list stays accurate.",
    ],
    parameters: RepoBranchParamsSchema,
    executionMode: "sequential",
    renderShell: "self",
    renderCall(args, theme) {
      return renderRepoBranchCall(args, theme);
    },
    renderResult(result, { expanded }, theme) {
      return renderRepoBranchResult(result, expanded, theme);
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      currentCtx = ctx;
      const details = await executeAction(params, ctx, signal);
      return {
        content: [{ type: "text", text: JSON.stringify(details) }],
        details,
      };
    },
  });

  pi.registerCommand("repo-branch", {
    description: "管理当前会话记录的仓库与分支：list | on | off | toggle | record [repo] [branch] | remove [repo] | clear",
    getArgumentCompletions: (prefix) => {
      const candidates = ["list", "on", "off", "toggle", "record", "remove", "clear"];
      const normalized = prefix.trim().toLowerCase();
      const matched = candidates
        .filter((item) => item.startsWith(normalized))
        .map((item) => ({ value: item, label: item }));
      return matched.length > 0 ? matched : null;
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      currentCtx = ctx;
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const sub = (tokens[0] ?? "list").toLowerCase();

      if (sub === "on") {
        cliDisabled = false;
        state = setVisible(state, true);
        persist();
        refresh(ctx);
        ctx.ui.notify("仓库分支常驻框已开启。", "info");
        return;
      }
      if (sub === "off") {
        state = setVisible(state, false);
        persist();
        refresh(ctx);
        ctx.ui.notify("仓库分支常驻框已隐藏。", "info");
        return;
      }
      if (sub === "toggle") {
        const nextVisible = !isWidgetVisible();
        if (nextVisible) cliDisabled = false;
        state = setVisible(state, nextVisible);
        persist();
        refresh(ctx);
        ctx.ui.notify(nextVisible ? "仓库分支常驻框已开启。" : "仓库分支常驻框已隐藏。", "info");
        return;
      }
      if (sub === "list") {
        ctx.ui.notify(formatRecordsSummary(state), "info");
        return;
      }
      if (sub === "clear") {
        const details = await executeAction({ action: "clear" }, ctx);
        ctx.ui.notify(`已清空 ${details.clearedCount ?? 0} 条仓库分支记录。`, "info");
        return;
      }
      if (sub === "remove") {
        const repoArg = tokens.slice(1).join(" ").trim() || undefined;
        try {
          const details = await executeAction({ action: "remove", ...(repoArg ? { repo: repoArg } : {}) }, ctx);
          ctx.ui.notify(
            details.removed
              ? `已移除：${details.removed.name} (${details.removed.branch})`
              : "未找到匹配的仓库记录。",
            details.removed ? "info" : "warning",
          );
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
        }
        return;
      }
      if (sub === "record" || sub === "set" || sub === "add") {
        const rest = tokens.slice(1);
        let repo: string | undefined;
        let branch: string | undefined;
        if (rest.length === 1) {
          branch = rest[0];
        } else if (rest.length >= 2) {
          repo = rest[0];
          branch = rest.slice(1).join(" ");
        }
        try {
          const details = await executeAction(
            {
              action: "record",
              ...(repo ? { repo } : {}),
              ...(branch ? { branch } : {}),
            },
            ctx,
          );
          if (details.record) {
            ctx.ui.notify(`已记录：${details.record.name} → ${details.record.branch}`, "info");
          }
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
        }
        return;
      }

      ctx.ui.notify(
        "用法：/repo-branch [list|on|off|toggle|record [repo] [branch]|remove [repo]|clear]",
        "warning",
      );
    },
  });

  pi.on("session_start", (_event, ctx) => {
    restoreFromContext(ctx, true);
  });
  pi.on("session_tree", (_event, ctx) => {
    restoreFromContext(ctx, false);
  });
  pi.on("session_compact", (_event, ctx) => {
    restoreFromContext(ctx, false);
  });
  pi.on("session_shutdown", () => {
    overlay.dispose();
    currentCtx = undefined;
    state = createInitialState(true);
    cliDisabled = false;
  });
}
