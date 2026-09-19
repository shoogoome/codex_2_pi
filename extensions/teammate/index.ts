import { randomUUID } from "node:crypto";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { installTeammateEventContextFilter } from "./eventEmit.js";
import { attachTeammateHandle, type TeammateHandle } from "./handle.js";
import { createTeamStore } from "./teamStore.js";
import { createMailbox } from "./mailbox.js";
import { createTeamTaskStore } from "./teamTasks/teamTaskStore.js";
import { createApprovalRequestRegistry } from "./handle.js";
import { getTasksHandle, lazyTasksHandle } from "../tasks/handle.js";
import { getRunningTasks } from "../tasks/framework.js";
import { setOwnerLivenessProbe } from "../tasks/currentOwner.js";
import {
  _bindPi,
  _unbindPi,
  InProcessTeammateTask,
  suspendTeammate,
} from "./killTeammate.js";
import { buildTeamCreateTool } from "./tools/teamCreate.js";
import { buildSendMessageTool } from "./tools/sendMessage.js";
import { buildTeamRosterTool } from "./tools/teamRoster.js";
import { buildTeamDeleteTool } from "./tools/teamDelete.js";
import { buildTeamPlanApproveTool } from "./tools/teamPlanApprove.js";
import { buildTeammateInterruptTool } from "./tools/teammateInterrupt.js";
import { buildTeamTaskCreateTool } from "./teamTasks/tools/teamTaskCreate.js";
import { buildTeamTaskUpdateTool } from "./teamTasks/tools/teamTaskUpdate.js";
import { buildTeamTaskListTool } from "./teamTasks/tools/teamTaskList.js";
import { buildTeamTaskGetTool } from "./teamTasks/tools/teamTaskGet.js";
import { hydrateTeammateState, hydrateTeamTaskStore, respawnTeammates } from "./hydrate.js";
import type { RespawnContext } from "./hydrate.js";
import type { AgentThinkingLevel } from "../localagent/model.js";
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
import { postLeaderNotification, setLeaderNotificationMembershipProbe } from "./leaderNotification.js";
import {
  approvalBlockReason,
  getCurrentApprovalSessionId,
  isApprovalRequiredToolCall,
  isMutationApproved,
  registerLeaderSession,
  shouldGateToolCall,
  unregisterLeaderSession,
} from "./approvalGate.js";

const WIDGET_KEY = "teammate-team";

export default function teammateExtension(pi: ExtensionAPI): void {
  const teamStore = createTeamStore();
  const mailbox = createMailbox();
  const teamTaskStore = createTeamTaskStore();
  const handle: TeammateHandle = {
    teamStore,
    mailbox,
    teamTaskStore,
    approvalRequests: createApprovalRequestRegistry(),
  };
  attachTeammateHandle(pi, handle);

  // Wire the membership probe once. Every notification path (spawn, hydrate,
  // loop callbacks, send_message) funnels through postLeaderNotification, so a
  // teammate torn down by team_delete/task_kill can no longer inject turns for
  // a team that no longer exists.
  setLeaderNotificationMembershipProbe((agentId) => {
    const at = agentId.indexOf("@");
    if (at <= 0) return false;
    const team = teamStore.getTeam(agentId.slice(at + 1));
    return team !== undefined && team.memberAgentIds.includes(agentId);
  });

  // Publish the cross-realm owner-liveness probe. Delegates to THIS realm's
  // team store at call time, because `tasks`/`async`/`localshell` live in
  // separate jiti realms where a direct import would read an empty store.
  // Used to stop a task whose owning teammate is already gone from waking the
  // leader with a completion notice for a teammate that no longer exists.
  //
  // Ownership itself is NOT published via a probe: AsyncLocalStorage does not
  // survive into a teammate sub-session's tool-call realm (see
  // tasks/currentOwner.ts), so spawn/hydrate instead register the teammate's
  // session file in the process-global owner index.
  setOwnerLivenessProbe((agentId) => {
    const at = agentId.indexOf("@");
    if (at <= 0) return false;
    const team = teamStore.getTeam(agentId.slice(at + 1));
    return team !== undefined && team.memberAgentIds.includes(agentId);
  });

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

  // Roster is registered at the factory top-level for the same reason as
  // send_message: a teammate sub-session never fires session_start, and a
  // teammate needs to discover peer names before it can address them.
  pi.registerTool(buildTeamRosterTool(pi));

  // The generic four team_task_* tools remain registered at factory top-level
  // for the leader and ordinary extension loading. An isolated teammate realm
  // would otherwise resolve these against its own empty handle, so spawn and
  // hydrate additionally inject same-name identity-bound custom tools that
  // capture the leader-realm handle/pi. (leader-only team_create / team_delete
  // remain in session_start.)
  pi.registerTool(buildTeamTaskCreateTool(pi));
  pi.registerTool(buildTeamTaskUpdateTool(pi));
  pi.registerTool(buildTeamTaskListTool(pi));
  pi.registerTool(buildTeamTaskGetTool(pi));

  // Hard mutation boundary for teammate child sessions. The child prompt is
  // tagged through a process-global AsyncLocalStorage in approvalGate, so this
  // hook works even though each AgentSession loads extensions in its own jiti
  // module realm.
  //
  // This hook runs for the LEADER as well (it is registered at factory scope,
  // which every session loads). `shouldGateToolCall` is what keeps the leader
  // out: the ALS store is inherited down async chains a teammate turn rooted,
  // so an ambient id is NOT proof that the caller is that teammate — observed
  // real failure was the leader's own `edit` being blocked as "reviewer@forge".
  pi.on("tool_call", async (event) => {
    const approvalSessionId = getCurrentApprovalSessionId();
    if (!shouldGateToolCall(approvalSessionId)) return;
    if (!isApprovalRequiredToolCall(event.toolName, event.input)) return;
    if (isMutationApproved(approvalSessionId)) return;
    return {
      block: true,
      reason: approvalBlockReason(approvalSessionId),
    };
  });

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
    const sessionId = ctx.sessionManager.getSessionId() || `ephemeral:${randomUUID()}`;
    leaderChannelSessionId = sessionId;
    // Mark this session as the leader so the mutation gate can never block it.
    // The gate's AsyncLocalStorage store is inherited down async chains rooted
    // by teammate turns, so an ambient teammate id can leak onto leader tool
    // calls; this registration is the durable "leader is never a teammate"
    // anchor. Paired with unregisterLeaderSession in session_shutdown.
    registerLeaderSession(sessionId);
    // Captured so the delivery path can ask "can the leader be woken right
    // now?". Read through the LIVE ctx at call time (not cached): the leader's
    // busy/idle state changes every turn, and a ctx captured now can go stale
    // after a session replacement. `safeIsIdle` in leaderNotification handles
    // the throw from a stale ctx by treating it as "not idle".
    const isLeaderIdle = () => ctx.isIdle();
    registerLeaderChannel(sessionId, {
      deliver: (details, triggerTurn) => {
        postLeaderNotification(pi, details, triggerTurn, isLeaderIdle);
      },
    });

    // Leader-only tools. These are intentionally registered in session_start
    // (not top-level): teammate sub-sessions never fire session_start, and the
    // blocklist in spawnTeammate strips these from teammates anyway, so keeping
    // them here keeps them off teammates while still available to the leader.
    //
    // Register BEFORE any tasks-handle work. These tool factories resolve their
    // collaborators lazily at call time (getTeammateHandle inside execute), so
    // they do not need the store here — and registering first means a hiccup in
    // the tasks handle can never make the leader's whole team toolset vanish.
    // That failure mode was observed for real: the session still had the
    // factory-level send_message + team_task_* tools but no team_create.
    pi.registerTool(buildTeamCreateTool(pi));
    pi.registerTool(buildTeamDeleteTool(pi));
    pi.registerTool(buildTeamPlanApproveTool(pi));
    pi.registerTool(buildTeammateInterruptTool(pi));

    // Resolve through a lazy handle so nothing below can throw merely because
    // the tasks extension has not attached yet. Real usage still fails loudly.
    const tasksHandle = lazyTasksHandle(pi);
    try {
      tasksHandle.registerTaskType("in_process_teammate", InProcessTeammateTask);
    } catch (e) {
      // Non-fatal: teammates can still be spawned in this session; only the
      // task-panel entry for them is unavailable. Never let this skip the
      // leader tool registration above.
      logError(e, "teammate registerTaskType");
    }

    // Hydrate teammates from the parent session's jsonl. Failures must not
    // break session_start — a corrupt or unreadable jsonl should still allow
    // the extension to load fresh.
    try {
      const entries = ctx.sessionManager.getEntries();
      const state = hydrateTeammateState(entries as never);
      hydrateTeamTaskStore(state, handle);
      // Capture the leader's live runtime when the host exposes it. Both reads
      // are optional so hydration still works on hosts that predate them — the
      // resume path then degrades to the SDK's session-file restore.
      const modelRegistry = (
        ctx as { modelRegistry?: NonNullable<RespawnContext["parentRuntime"]>["modelRegistry"] }
      ).modelRegistry;
      const thinkingLevel = (
        pi as { getThinkingLevel?: () => unknown }
      ).getThinkingLevel;
      await respawnTeammates(state, {
        pi,
        taskStore: tasksHandle.store,
        handle,
        cwd: ctx.cwd,
        // The leader's live runtime is the only correct source of truth for a
        // resumed teammate's provider. Without it the SDK would fall back to
        // the settings default and could silently move a teammate off the
        // leader's provider. `modelRegistry` lives on the context, not on the
        // session-scoped `pi` handle, so capture it here.
        parentRuntime:
          modelRegistry && typeof thinkingLevel === "function"
            ? {
                model: ctx.model,
                modelRegistry,
                thinkingLevel: thinkingLevel.call(pi) as AgentThinkingLevel,
              }
            : undefined,
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
                (tui, theme, _kb, done) => {
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
                    // Report the TERMINAL height; the component subtracts the
                    // input-dock reserve so the editor stays visible (the
                    // overlay composites from the top of the same frame the
                    // dock occupies the bottom of). Read it per render so a
                    // resize is picked up without re-opening the overlay.
                    getHeight: () => tui.terminal.rows,
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
      unregisterLeaderSession(leaderChannelSessionId);
      leaderChannelSessionId = undefined;
    }
    // Everything above is unconditional leader-side teardown. The tasks-handle
    // work below is best-effort: a missing handle must not skip the store
    // resets or prevent the leader channel from being cleaned up.
    try {
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
            await suspendTeammate(tasksHandle.store, t.id);
          } catch (e) {
            logError(e, "teammate session_shutdown kill");
          }
        }),
      );
      tasksHandle.unregisterTaskType("in_process_teammate");
    } catch (e) {
      logError(e, "teammate session_shutdown tasks handle");
    }
    _unbindPi();
    teamStore._resetForTest();
    mailbox._resetForTest();
    teamTaskStore._resetForTest();
  });
}
