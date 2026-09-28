import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { ExtensionCommandRunner } from "../shared/git.js";
import { getTasksHandle } from "../tasks/handle.js";
import type { TaskActivityHandle } from "../tasks/activity.js";
import { ReviewGit } from "./review-git.js";
import { ReviewPanel } from "./review-panel.js";
import { REVIEW_OVERLAY_OPTIONS, suspendReviewBackground } from "./review-screen.js";
import { REVIEW_ENTRY_TYPE } from "./review-state.js";
import { reviewOperationForTool } from "./review-tools.js";
import { SessionReview, type SessionReviewReader } from "./review-session.js";
import { SIDE_REQUEST_CHANNEL } from "../shared/side-protocol.js";

export interface ReviewExtensionOptions {
  createReader?(cwd: string): SessionReviewReader;
  getActivity?(): TaskActivityHandle | undefined;
}

function selectionPrompt(selection: string, note: string, target: "side" | "main"): string {
  const intro = target === "side" ? "请在 side 问询中分析下面选中的 Git diff 代码。" : "请在主会话中分析下面选中的 Git diff 代码。";
  const fence = "```";
  return [intro, "", `${fence}diff`, selection, fence, note.trim() ? `\n用户附加说明：${note.trim()}` : ""].join("\n");
}

async function askWithSelection(ctx: ExtensionContext, pi: ExtensionAPI, selection: string, target: "side" | "main"): Promise<void> {
  const note = await ctx.ui.input(`${target === "side" ? "Side" : "主会话"}问询（可选附加说明）`, "例如：解释这里的潜在问题");
  if (note === undefined) return;
  const question = selectionPrompt(selection, note, target);
  if (target === "side") pi.events.emit(SIDE_REQUEST_CHANNEL, { question, ctx });
  else pi.sendUserMessage(question);
}

async function editReviewFile(ctx: ExtensionContext, pi: ExtensionAPI, review: SessionReview, path: string, repoKey?: string): Promise<void> {
  try {
    const original = await review.readText(path, repoKey);
    const edited = await ctx.ui.editor(`编辑 ${path}`, original);
    if (edited === undefined || edited === original) return;
    await review.writeText(path, edited, repoKey);
    const send = await ctx.ui.confirm("编辑完成", `是否将 ${path} 的编辑信息发送给主会话？`);
    if (!send) return;
    const note = await ctx.ui.input("编辑附加说明（可选）", "例如：请检查这个修复是否完整");
    if (note === undefined) return;
    pi.sendUserMessage(`我刚刚编辑了文件 ${path}，请基于当前工作区检查这次修改。${note.trim() ? `\n\n用户附加说明：${note.trim()}` : ""}`);
  } catch (error) {
    ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
  }
}

/** Keep the original /diff message command unchanged; this adds a separate UI workflow. */
export function installSessionReview(pi: ExtensionAPI, options: ReviewExtensionOptions = {}): void {
  const createReader = options.createReader ?? ((cwd) => new ReviewGit(new ExtensionCommandRunner(pi), cwd));
  const getActivity = options.getActivity ?? (() => {
    try { return getTasksHandle(pi).activity; }
    catch { return undefined; }
  });
  let active: SessionReview | undefined;
  let sessionId: string | undefined;
  let unsubscribe: (() => void) | undefined;
  let closePanel: (() => void) | undefined;
  let opening: Promise<void> | undefined;
  let generation = 0;

  function teardown(): void {
    generation++;
    unsubscribe?.();
    unsubscribe = undefined;
    closePanel?.();
    closePanel = undefined;
    active?.dispose();
    active = undefined;
    sessionId = undefined;
    opening = undefined;
  }

  async function start(ctx: ExtensionContext, preserveOpening = false): Promise<SessionReview> {
    const pendingOpen = preserveOpening ? opening : undefined;
    teardown();
    if (pendingOpen) opening = pendingOpen;
    const epoch = generation;
    const id = ctx.sessionManager.getSessionId();
    sessionId = id;
    // Capture plain data before awaiting. Never read a session-bound ctx during rendering.
    const current = new SessionReview({
      sessionId: id,
      cwd: ctx.cwd,
      branch: ctx.sessionManager.getBranch(),
      git: createReader(ctx.cwd),
      readerForCwd: createReader,
      persist: (event) => {
        if (epoch !== generation || current !== active || current.disposed) throw new Error("审阅所属会话已切换。");
        pi.appendEntry(REVIEW_ENTRY_TYPE, event);
      },
    });
    active = current;
    const activity = getActivity();
    current.setBackgroundAvailable(Boolean(activity));
    if (activity) {
      unsubscribe = activity.subscribe(async (event) => {
        if (epoch !== generation || current.disposed) return;
        try { await current.taskActivity(event); }
        catch (error) {
          // With a prior baseline the failed window is retained for retry. Without
          // any baseline, don't let the task outrun initialization and become invisible.
          if (!current.disposed && current.repo !== null && !current.hasBaseline && event.phase === "before-start") throw error;
        }
      });
    }
    try {
      await current.initialize();
      if (epoch === generation && !current.disposed && activity) await current.restoreActivities(activity.getActive());
    } catch {
      // No repo is normal for many sessions. /changes provides the explicit feedback.
    }
    return current;
  }

  async function ensure(ctx: ExtensionContext): Promise<SessionReview> {
    if (!active || sessionId !== ctx.sessionManager.getSessionId()) return start(ctx, true);
    return active;
  }

  async function open(ctx: ExtensionContext): Promise<void> {
    if (ctx.mode !== "tui") {
      ctx.ui.notify("会话 Git 审阅面板仅支持 TUI 交互模式。", "warning");
      return;
    }
    if (opening) return opening;
    // Set the singleton guard synchronously, before any repository IO.
    const job = Promise.resolve().then(async () => {
      const current = await ensure(ctx);
      const epoch = generation;
      let restoreBackground: (() => void) | undefined;
      try {
        await current.initialize();
        if (epoch !== generation || current.disposed) return;
        if (!current.hasRepositories) {
          ctx.ui.notify("当前 cwd 不在 Git 工作树，且尚未发现可审阅的跨目录仓库。请先在其他 Git 仓库执行一次写入或启动相关后台任务后重试。", "warning");
          return;
        }
        current.setPanelOpen(true);
        // Render a loading state immediately; opening does not wait for a model turn.
        void current.refresh().catch(() => undefined);
        await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
          let closed = false;
          const finish = () => {
            if (closed) return;
            closed = true;
            panel.dispose();
            restoreBackground?.();
            done();
          };
          const panel = new ReviewPanel(current, {
            requestRender: () => tui.requestRender(),
            onClose: finish,
            height: () => Math.max(1, tui.terminal.rows),
            theme,
            onEdit: async (path, file) => { finish(); await editReviewFile(ctx, pi, current, path, file?.repoKey); },
            onAskSide: async (selection) => { finish(); await askWithSelection(ctx, pi, selection, "side"); },
            onAskMain: async (selection) => { finish(); await askWithSelection(ctx, pi, selection, "main"); },
          });
          restoreBackground = suspendReviewBackground(tui);
          closePanel = finish;
          return {
            render: (width) => panel.render(width),
            handleInput: (data) => panel.handleInput(data),
            invalidate: () => panel.invalidate(),
            dispose: () => { panel.dispose(); restoreBackground?.(); },
          };
        }, { overlay: true, overlayOptions: REVIEW_OVERLAY_OPTIONS });
      } catch (error) {
        if (epoch === generation && !current.disposed) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
      } finally {
        restoreBackground?.();
        current.setPanelOpen(false);
        if (epoch === generation) closePanel = undefined;
      }
    });
    opening = job;
    try { await job; }
    finally { if (opening === job) opening = undefined; }
  }

  pi.registerFlag("changes-key", {
    type: "string", default: "ctrl+r",
    description: "Open session Git review from the conversation editor (empty disables the shortcut)",
  });
  const flag = pi.getFlag("changes-key");
  const key = typeof flag === "string" ? flag.trim() : "ctrl+r";
  if (key) pi.registerShortcut(key as KeyId, { description: "审阅本会话 Git 文件变更", handler: open });
  pi.registerCommand("changes", { description: "审阅本会话 Git 变更，确认完成后隐藏当前版本", handler: (_args, ctx) => open(ctx) });

  pi.on("session_start", async (_event, ctx) => { await start(ctx); });
  pi.on("session_tree", async (_event, ctx) => { await start(ctx); });
  pi.on("session_shutdown", () => { teardown(); });
  pi.on("tool_call", async (event, ctx) => {
    const current = await ensure(ctx);
    try { await current.beforeTool(event.toolCallId, event.toolName, event.input); }
    catch (error) {
      const mutation = reviewOperationForTool(event.toolName, event.input, current.repo?.root ?? ctx.cwd, ctx.cwd);
      if (mutation && !current.disposed && current.repo !== null && !current.hasBaseline) {
        return { block: true, reason: `无法建立会话变更基线，请通过 /changes 重试后再编辑：${error instanceof Error ? error.message : String(error)}` };
      }
      // A failed scan with an existing baseline keeps the scope for the final retry.
    }
  });
  // tool_result includes failed executions; tool_execution_end handles thrown/aborted paths too.
  pi.on("tool_result", async (event) => {
    const current = active;
    try { await current?.afterTool(event.toolCallId); } catch { /* Exposed by the panel. */ }
  });
  pi.on("tool_execution_end", async (event) => {
    const current = active;
    try { await current?.afterTool(event.toolCallId); } catch { /* Exposed by the panel. */ }
  });
}
