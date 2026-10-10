import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext, TerminalInputHandler } from "@earendil-works/pi-coding-agent";
import type { Component, KeyId, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { extractApplyChangeFromInput, lastApplyChange } from "./src/branch.js";
import { parseTasksMarkdown, type OpenSpecTaskSnapshot } from "./src/parser.js";
import { formatDetailLines, formatSummaryLines } from "./src/render.js";
import {
  OPENSPEC_PROGRESS_ENTRY,
  initialState,
  restoreState,
  setChange,
  setVisible,
  type OpenSpecProgressState,
} from "./src/state.js";

const WIDGET_KEY = "openspec-apply-progress";
const DEFAULT_KEY = "alt+o";
const DETAILS_KEY = "alt+enter";
const KEY_FLAG = "openspec-progress-key";
const REFRESH_MS = 1000;

interface FileSnapshot {
  path: string;
  mtimeMs: number;
  size: number;
  tasks: OpenSpecTaskSnapshot;
}

function isValidChange(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

function taskPath(cwd: string, change: string): string {
  return resolve(cwd, "openspec", "changes", change, "tasks.md");
}

function readSnapshot(cwd: string, change: string): FileSnapshot | undefined {
  if (!isValidChange(change)) return undefined;
  const path = taskPath(cwd, change);
  try {
    const stat = statSync(path);
    const tasks = parseTasksMarkdown(readFileSync(path, "utf8"));
    if (tasks.tasks.length === 0) return undefined;
    return { path, mtimeMs: stat.mtimeMs, size: stat.size, tasks };
  } catch {
    return undefined;
  }
}

function isEscape(data: string): boolean {
  return data === "\x1b";
}

function isAltEnter(data: string): boolean {
  return data === "\x1b\r" || data === "\x1b\n";
}

function isUp(data: string): boolean {
  return data === "\x1b[A";
}

function isDown(data: string): boolean {
  return data === "\x1b[B";
}

export default function openSpecProgressExtension(pi: ExtensionAPI): void {
  pi.registerFlag(KEY_FLAG, {
    type: "string",
    default: DEFAULT_KEY,
    description: "OpenSpec progress toggle shortcut; set empty to disable",
  });

  let state: OpenSpecProgressState = initialState();
  let ctx: ExtensionContext | undefined;
  let file: FileSnapshot | undefined;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let unsubscribeInput: (() => void) | undefined;
  let tui: TUI | undefined;
  let overlayTui: TUI | undefined;
  let overlayHandle: OverlayHandle | undefined;
  let overlayDone: (() => void) | undefined;
  let detailOpen = false;
  let detailOffset = 0;
  let focused = false;
  let lastDiagnostic: string | undefined;

  function persist(): void {
    try {
      pi.appendEntry(OPENSPEC_PROGRESS_ENTRY, state);
    } catch {
      // Session persistence is best-effort and must not affect the UI.
    }
  }

  function hideWidget(): void {
    if (ctx?.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined, { placement: "aboveEditor" });
    tui = undefined;
  }

  function dismissOverlay(): void {
    overlayDone?.();
    overlayDone = undefined;
    overlayHandle?.hide();
    overlayHandle = undefined;
    overlayTui = undefined;
    detailOpen = false;
    detailOffset = 0;
  }

  function updateFile(force = false): void {
    if (!ctx || !state.change || !state.visible) {
      file = undefined;
      hideWidget();
      return;
    }
    const next = readSnapshot(ctx.cwd, state.change);
    if (!next) {
      file = undefined;
      hideWidget();
      if (lastDiagnostic !== state.change) {
        lastDiagnostic = state.change;
        ctx.hasUI && ctx.ui.notify(`OpenSpec 进度：无法读取 ${state.change}/tasks.md`, "warning");
      }
      return;
    }
    lastDiagnostic = undefined;
    if (force || !file || file.path !== next.path || file.mtimeMs !== next.mtimeMs || file.size !== next.size) {
      file = next;
      tui?.requestRender();
      if (detailOpen) tui?.requestRender();
    }
    if (ctx.hasUI && !tui) {
      ctx.ui.setWidget(WIDGET_KEY, (nextTui, theme) => {
        tui = nextTui;
        return {
          render: (width: number) => file ? formatSummaryLines(state.change ?? "", file.tasks, theme, width) : [],
          invalidate: () => { tui = undefined; },
        };
      }, { placement: "aboveEditor" });
    }
  }

  function openDetails(): void {
    if (!ctx?.hasUI || !file || detailOpen) return;
    detailOpen = true;
    const promise = ctx.ui.custom<void>((nextTui, theme, _kb, done) => {
      overlayTui = nextTui;
      overlayDone = done;
      const component: Component = {
        render(width: number): string[] {
          return file ? formatDetailLines(state.change ?? "", file.tasks, theme, width, 16, detailOffset) : [];
        },
        invalidate() { overlayTui = undefined; },
      };
      return component;
    }, {
      overlay: true,
      overlayOptions: () => ({ width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0, nonCapturing: true }),
      onHandle: (handle) => { overlayHandle = handle; },
    });
    promise?.then(() => dismissOverlay(), () => dismissOverlay());
  }

  function rebuildFromBranch(nextCtx: ExtensionContext): void {
    ctx = nextCtx;
    const restored = restoreState(nextCtx.sessionManager.getBranch());
    const replayed = lastApplyChange(nextCtx.sessionManager.getBranch());
    state = {
      ...restored,
      ...(replayed && !restored.explicitChange ? { change: replayed } : {}),
    };
    file = undefined;
    focused = false;
    dismissOverlay();
    updateFile(true);
  }

  function toggleVisibility(): void {
    state = setVisible(state, !state.visible);
    focused = state.visible;
    persist();
    if (!state.visible) dismissOverlay();
    updateFile(true);
  }

  function registerInput(nextCtx: ExtensionContext): void {
    unsubscribeInput?.();
    if (!nextCtx.hasUI) return;
    const handler: TerminalInputHandler = (data) => {
      if (!state.visible || !file) return undefined;
      if (detailOpen) {
        if (isEscape(data)) { dismissOverlay(); return { consume: true }; }
        if (isUp(data)) { detailOffset = Math.max(0, detailOffset - 1); overlayTui?.requestRender(); return { consume: true }; }
        if (isDown(data)) { detailOffset = Math.min(Math.max(0, file.tasks.tasks.length - 1), detailOffset + 1); overlayTui?.requestRender(); return { consume: true }; }
        return undefined;
      }
      if (isAltEnter(data)) { openDetails(); return { consume: true }; }
      if (focused && isEscape(data)) { focused = false; return { consume: true }; }
      return undefined;
    };
    unsubscribeInput = nextCtx.ui.onTerminalInput(handler);
  }

  function startRefresh(): void {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => updateFile(), REFRESH_MS);
    refreshTimer.unref?.();
  }

  const rawShortcut = pi.getFlag(KEY_FLAG);
  const configuredShortcut = rawShortcut === undefined
    ? DEFAULT_KEY
    : typeof rawShortcut === "string"
      ? rawShortcut.trim()
      : DEFAULT_KEY;
  if (configuredShortcut) {
    pi.registerShortcut(configuredShortcut as KeyId, {
      description: "Toggle OpenSpec apply progress",
      handler: () => toggleVisibility(),
    });
  }

  pi.registerShortcut(DETAILS_KEY as KeyId, {
    description: "Open OpenSpec apply progress details",
    handler: () => openDetails(),
  });

  pi.registerCommand("opsx-progress", {
    description: "显示/隐藏 OpenSpec apply 任务进度：on|off|toggle|<change>",
    handler: async (args: string, commandCtx: ExtensionCommandContext) => {
      ctx = commandCtx;
      const arg = args.trim();
      if (arg === "on") state = setVisible(state, true);
      else if (arg === "off") state = setVisible(state, false);
      else if (arg === "toggle" || arg === "") toggleVisibility();
      else if (isValidChange(arg)) state = setChange(state, arg);
      else { commandCtx.ui.notify("用法：/opsx-progress on|off|toggle|<change>", "warning"); return; }
      persist();
      updateFile(true);
      if (state.visible) commandCtx.ui.notify(`OpenSpec 进度已${state.change ? `绑定 ${state.change}` : "开启"}`, "info");
    },
  });

  pi.on("input", (event) => {
    const change = extractApplyChangeFromInput(event.text);
    if (!change) return { action: "continue" };
    state = { ...state, change, explicitChange: undefined, visible: true, updatedAt: Date.now() };
    persist();
    updateFile(true);
    return { action: "continue" };
  });

  pi.on("session_start", (_event, nextCtx) => {
    rebuildFromBranch(nextCtx);
    registerInput(nextCtx);
    startRefresh();
  });
  pi.on("session_tree", (_event, nextCtx) => { rebuildFromBranch(nextCtx); registerInput(nextCtx); });
  pi.on("session_compact", (_event, nextCtx) => { rebuildFromBranch(nextCtx); registerInput(nextCtx); });
  pi.on("session_shutdown", () => {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = undefined;
    unsubscribeInput?.();
    unsubscribeInput = undefined;
    dismissOverlay();
    hideWidget();
    ctx = undefined;
  });
}
