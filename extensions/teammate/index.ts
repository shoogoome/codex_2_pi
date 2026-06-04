import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { installTeammateEventContextFilter } from "./eventEmit.js";
import { attachTeammateHandle, type TeammateHandle } from "./handle.js";
import { createTeamStore } from "./teamStore.js";
import { createMailbox } from "./mailbox.js";
import { createTeamTaskStore } from "./teamTasks/teamTaskStore.js";
import { getTasksHandle } from "../tasks/handle.js";
import { getRunningTasks } from "../tasks/framework.js";
import {
  _bindPi,
  _unbindPi,
  InProcessTeammateTask,
} from "./killTeammate.js";
import { buildTeamCreateTool } from "./tools/teamCreate.js";
import { buildSendMessageTool } from "./tools/sendMessage.js";
import { buildTeamDeleteTool } from "./tools/teamDelete.js";
import { buildTeamPlanApproveTool } from "./tools/teamPlanApprove.js";
import { buildTeamTaskCreateTool } from "./teamTasks/tools/teamTaskCreate.js";
import { buildTeamTaskUpdateTool } from "./teamTasks/tools/teamTaskUpdate.js";
import { buildTeamTaskListTool } from "./teamTasks/tools/teamTaskList.js";
import { buildTeamTaskGetTool } from "./teamTasks/tools/teamTaskGet.js";
import { hydrateTeammateState, hydrateTeamTaskStore, respawnTeammates } from "./hydrate.js";
import { logError } from "../tasks/logging.js";
import { buildTeamWidget } from "./ui/teamWidget.js";
import { createViewStateStore } from "./ui/viewState.js";
import { registerTeammateKeybindings } from "./ui/keybindings.js";
import { buildTeammateEditorFactory } from "./ui/teammateEditorFactory.js";
import { buildTeammateOverlayComponent } from "./ui/teammateOverlayComponent.js";
import { isInProcessTeammateTask, type InProcessTeammateTaskState } from "./types.js";
import type { Component, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import {
  registerLeaderChannel,
  unregisterLeaderChannel,
} from "./leaderBridge.js";
import { postLeaderNotification } from "./leaderNotification.js";

const WIDGET_KEY = "teammate-team";

export default function teammateExtension(pi: ExtensionAPI): void {
  const teamStore = createTeamStore();
  const mailbox = createMailbox();
  const teamTaskStore = createTeamTaskStore();
  const handle: TeammateHandle = { teamStore, mailbox, teamTaskStore };
  attachTeammateHandle(pi, handle);

  installTeammateEventContextFilter(pi);

  // Register `send_message` at the factory top-level (NOT inside session_start).
  //
  // Why top-level: a teammate sub-session is created by spawnTeammate via
  // createAgentSessionFromServices and driven purely by session.prompt() — it
  // is NEVER given session.bindExtensions(), so its `session_start` event does
  // not fire. Tools registered inside session_start (the leader-only tools
  // below) therefore never exist in a teammate sub-session. send_message MUST
  // be available to teammates (that is how they talk back to the leader and to
  // peers), so it has to be registered in the factory body, which runs at
  // extension-load time for EVERY session — leader and teammate alike.
  //
  // Safe at top-level: buildSendMessageTool(pi) only resolves the handle via
  // getTeammateHandle(pi) inside execute(), at call time — not at registration
  // time — so it does not depend on session_start having attached the handle.
  pi.registerTool(buildSendMessageTool(pi));

  // The four team_task_* tools register at the factory top-level for the same
  // reason as send_message: teammate sub-sessions need them and never fire
  // session_start. Per spec §2.4, the team task list is meant for leader↔
  // teammate collaboration, so all sides need access. (leader-only
  // team_create / team_delete remain in session_start; the spawnTeammate
  // blocklist strips those from teammates anyway.)
  pi.registerTool(buildTeamTaskCreateTool(pi));
  pi.registerTool(buildTeamTaskUpdateTool(pi));
  pi.registerTool(buildTeamTaskListTool(pi));
  pi.registerTool(buildTeamTaskGetTool(pi));

  // Module-scoped (per extension instance) — survives across session_start /
  // session_shutdown reload cycles so we can clean up subscribers from a
  // previous cycle before re-subscribing.
  let unsubWidget: (() => void) | undefined;
  // sessionId of the leader channel we registered on the process-global
  // leaderBridge, so session_shutdown can unregister exactly that entry.
  let leaderChannelSessionId: string | undefined;

  pi.on("session_start", async (_event, ctx) => {
    _bindPi(pi);

    // Register this (leader) session on the process-global bridge so teammate
    // sub-sessions — which run in isolated extension runtimes and cannot reach
    // this pi via the eventBus-attached handle — can deliver notifications to
    // the real leader. The deliver closure captures THIS leader's pi; spikes
    // proved the leader pi stays valid for the leader's whole lifetime (only
    // the leader's own dispose/reload marks it stale), and a teammate
    // sub-session being active does not invalidate it.
    //
    // Note: teammate sub-sessions are driven via session.prompt(), never
    // session.bindExtensions(), so this session_start handler does NOT fire
    // for them — only the real leader ever registers a channel.
    const sessionId = ctx.sessionManager.getSessionId();
    if (sessionId) {
      leaderChannelSessionId = sessionId;
      registerLeaderChannel(sessionId, {
        deliver: (details, triggerTurn) => {
          postLeaderNotification(pi, details, triggerTurn);
        },
      });
    }

    const tasksHandle = getTasksHandle(pi);
    tasksHandle.registerTaskType("in_process_teammate", InProcessTeammateTask);
    // Leader-only tools. These are intentionally registered in session_start
    // (not top-level): teammate sub-sessions never fire session_start, and the
    // blocklist in spawnTeammate strips these from teammates anyway, so keeping
    // them here keeps them off teammates while still available to the leader.
    pi.registerTool(buildTeamCreateTool(pi));
    pi.registerTool(buildTeamDeleteTool(pi));
    pi.registerTool(buildTeamPlanApproveTool(pi));

    // Hydrate teammates from the parent session's jsonl. Failures must not
    // break session_start — a corrupt or unreadable jsonl should still allow
    // the extension to load fresh.
    try {
      const entries = ctx.sessionManager.getEntries();
      const state = hydrateTeammateState(entries as never);
      hydrateTeamTaskStore(state, handle);
      await respawnTeammates(state, {
        pi,
        taskStore: tasksHandle.store,
        handle,
        cwd: ctx.cwd,
      });
    } catch (e) {
      logError(e, "teammate hydrate");
    }

    // Live widget refresh — only when running with an interactive UI. RPC /
    // print modes have no widget surface so we skip subscription entirely.
    if (ctx.hasUI) {
      // Defensive: clean up any subs leaked from a previous cycle.
      unsubWidget?.();

      // D.4 — view-state plumbing for keybindings + editor view swap.
      const viewState = createViewStateStore();

      // Capture the TUI handle when the factory is invoked, so store
      // subscribers below can call `tui.requestRender()` to re-paint the
      // panel (mirrors extensions/panel pattern).
      let tuiHandle: TUI | undefined;
      const innerFactory = buildTeamWidget({
        teamStore: handle.teamStore,
        taskStore: tasksHandle.store,
        viewState,
      });
      const componentFactory = (
        t: TUI,
        theme: Theme,
      ): Component & { dispose?(): void } => {
        tuiHandle = t;
        const component = innerFactory(t, theme);
        const origDispose = component.dispose;
        return {
          ...component,
          render: (width: number) => component.render(width),
          dispose: () => {
            tuiHandle = undefined;
            origDispose?.();
          },
        };
      };
      ctx.ui.setWidget(WIDGET_KEY, componentFactory, {
        placement: "aboveEditor",
      });

      const requestRender = (): void => {
        tuiHandle?.requestRender();
      };

      const u1 = handle.teamStore.subscribe(requestRender);
      const u2 = tasksHandle.store.subscribe(requestRender);

      // D.3 — keybindings (Ctrl+G focus + ↑↓ Tab Enter Esc k routing).
      const unsubKeybindings = registerTeammateKeybindings({
        pi,
        ui: ctx.ui,
        taskStore: tasksHandle.store,
        handle,
        viewState,
      });

      // D.4 — view-swap reactor: when viewState enters teammate mode, install
      // the teammate-input editor; when it leaves, restore the default. Also
      // request a re-render so the selectedAgentId highlight tracks viewState.
      //
      // D2 enhancement (Path Y): in addition to swapping the editor, open a
      // full-screen ctx.ui.custom overlay that visually replaces the leader's
      // main chat with a render of the teammate's session entries. The
      // overlay handle + its `done` callback are kept in scope so we can
      // dismiss it when viewState leaves teammate mode (or on
      // session_shutdown).
      let overlayHandle: OverlayHandle | undefined;
      let overlayDone: ((value: void) => void) | undefined;
      function dismissOverlay(): void {
        if (overlayDone) {
          try {
            overlayDone();
          } catch (e) {
            logError(e, "teammate overlay done");
          }
          overlayDone = undefined;
        }
        if (overlayHandle) {
          try {
            overlayHandle.hide();
          } catch (e) {
            logError(e, "teammate overlay hide");
          }
          overlayHandle = undefined;
        }
      }
      const unsubViewSwap = viewState.subscribe((state) => {
        requestRender();
        if (state.kind === "teammate") {
          const teammates = Object.values(tasksHandle.store.get()).filter(
            isInProcessTeammateTask,
          );
          const target = teammates.find(
            (t) => t.identity.agentId === state.agentId,
          );
          if (target) {
            ctx.ui.setEditorComponent(
              buildTeammateEditorFactory({
                agentId: target.identity.agentId,
                agentName: target.identity.agentName,
                mailbox: handle.mailbox,
                onExit: () => viewState.exitTeammateView(),
                onSent: (text) => {
                  // Best-effort toast so the leader sees confirmation that
                  // the message landed in the teammate's mailbox. Truncated
                  // to 60 chars to keep the notification line readable.
                  const preview =
                    text.length > 60 ? `${text.slice(0, 60)}…` : text;
                  ctx.ui.notify(
                    `已发送给 ${target.identity.agentName}: ${preview}`,
                    "info",
                  );
                },
              }),
            );

            // Open the full-screen overlay (only once per teammate-view entry).
            // We capture the target task id rather than a reference so the
            // header callback always reads the latest state from the store.
            if (!overlayHandle && !overlayDone) {
              const taskId = target.id;
              const sessionFile = target.sessionFile;
              const identity = target.identity;
              const overlayPromise = ctx.ui.custom<void>(
                (_tui, theme, _kb, done) => {
                  overlayDone = done;
                  // Narrow Pi `Theme` to the minimal `fg`-only surface
                  // expected by renderTeammateOverlay so the overlay
                  // adopts the same accent/dim/success/muted vocabulary
                  // as the panel widget. Tests pass an empty stub for
                  // theme — guard against a missing `fg` member.
                  const themeFg = (
                    theme as unknown as {
                      fg?: (color: string, text: string) => string;
                    }
                  ).fg;
                  const overlayTheme =
                    typeof themeFg === "function"
                      ? {
                          fg: (color: string, text: string) =>
                            themeFg.call(theme, color, text),
                        }
                      : undefined;
                  return buildTeammateOverlayComponent({
                    identity,
                    sessionFile,
                    getTaskHeader: () => {
                      const cur = tasksHandle.store.getTask(taskId) as
                        | InProcessTeammateTaskState
                        | undefined;
                      if (cur && cur.type === "in_process_teammate") {
                        return {
                          taskCount: cur.turnCount,
                          isIdle: cur.isIdle,
                        };
                      }
                      return { taskCount: 0, isIdle: true };
                    },
                    openSession: (path) => SessionManager.open(path),
                    theme: overlayTheme,
                  });
                },
                {
                  overlay: true,
                  overlayOptions: () => ({
                    width: "100%",
                    maxHeight: "100%",
                    anchor: "top-left",
                    margin: 0,
                    // nonCapturing: the overlay must NOT steal keyboard
                    // focus from the swapped editor — otherwise Pi's TUI
                    // routes raw keys (including Esc) to the overlay
                    // component (which has no handleInput) and the user
                    // sees "Esc does nothing". With nonCapturing:true the
                    // editor keeps focus and its onSubmit / onEscape hooks
                    // fire normally.
                    nonCapturing: true,
                  }),
                  onHandle: (h) => {
                    overlayHandle = h;
                  },
                },
              );
              if (overlayPromise && typeof overlayPromise.then === "function") {
                overlayPromise.then(
                  () => {
                    overlayHandle = undefined;
                    overlayDone = undefined;
                  },
                  (e: unknown) => {
                    overlayHandle = undefined;
                    overlayDone = undefined;
                    logError(e, "teammate overlay promise");
                  },
                );
              }
            }
          }
        } else {
          ctx.ui.setEditorComponent(undefined);
          dismissOverlay();
        }
      });

      unsubWidget = (): void => {
        u1();
        u2();
        unsubKeybindings();
        unsubViewSwap();
        // D2 Path Y: dismiss the full-screen teammate overlay if still open.
        dismissOverlay();
        // Tear down the widget itself so the host can drop our component.
        ctx.ui.setWidget(WIDGET_KEY, undefined);
        // Defensive: ensure the default editor is restored on shutdown.
        ctx.ui.setEditorComponent(undefined);
      };
    }
  });

  pi.on("session_shutdown", async () => {
    unsubWidget?.();
    unsubWidget = undefined;
    if (leaderChannelSessionId) {
      unregisterLeaderChannel(leaderChannelSessionId);
      leaderChannelSessionId = undefined;
    }
    const tasksHandle = getTasksHandle(pi);
    const running = getRunningTasks(tasksHandle.store.get()).filter(
      (t) => t.type === "in_process_teammate",
    );
    // Promise.allSettled — a single kill failure must not abort the rest.
    // Each kill is wrapped in try/catch so the surrounding allSettled never
    // sees a reject; logError surfaces the failure for diagnostics.
    await Promise.allSettled(
      running.map(async (t) => {
        try {
          await InProcessTeammateTask.kill(t.id, tasksHandle.store);
        } catch (e) {
          logError(e, "teammate session_shutdown kill");
        }
      }),
    );
    tasksHandle.unregisterTaskType("in_process_teammate");
    _unbindPi();
    teamStore._resetForTest();
    mailbox._resetForTest();
    teamTaskStore._resetForTest();
  });
}
