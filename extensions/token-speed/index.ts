// extensions/token-speed/index.ts
//
// Token-generation speed (tok/s) for the Pi footer. This entry ONLY wires pi
// API events to the pure helpers under src/. It never mutates messages, never
// sends anything into the LLM context, and every handler returns undefined —
// persistence goes through appendEntry (CustomEntry, ignored by
// buildSessionContext, so it never burns tokens).
//
// Spec:
//   ① live estimate while streaming: streamed chars ÷ learned chars-per-token
//      over the first-delta→now window, throttled to LIVE_THROTTLE_MS.
//   ② exact per-response measurement at message_end: provider `usage.output`
//      over the first→last delta window (pure decode throughput); when nothing
//      streamed, the request→end window is used instead.
//   ③ footer status line (STATUS_KEY="tps") + /speed panel with last-response
//      detail, session average, TTFT and the recent series.
//   ④ cross-session persistence via appendEntry; restore from the branch on
//      session_start / reload / fork.
//   ⑤ --token-speed=false disables the footer line (measurement keeps running).

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  buildPanelLines,
  footerLine,
  liveView,
  type LiveView,
  type PanelInput,
} from "./src/format.js";
import {
  appendSample,
  buildSample,
  clampRatio,
  lastSample,
  learnCharsPerToken,
  liveSpeed,
  markDelta,
  markMessageStart,
  markRequestStart,
  newMarkers,
  resetMarkers,
  sessionStats,
  type StreamMarkers,
} from "./src/measure.js";
import { buildTokenSpeedPanelComponent, type TokenSpeedPanelComponent } from "./src/panel.js";
import { buildSnapshot, restoreFromBranch } from "./src/snapshot.js";
import {
  CHARS_PER_TOKEN_FALLBACK,
  CUSTOM_TYPE,
  ENABLED_FLAG,
  HISTORY_LIMIT,
  isFiniteNumber,
  isRecord,
  isString,
  LIVE_THROTTLE_MS,
  STATUS_KEY,
  WIDGET_KEY,
  type ResponseSample,
  type SpeedSnapshot,
} from "./src/types.js";

/**
 * A `before_provider_request` older than this is considered unrelated to the
 * next assistant message (e.g. a compaction/summarization call in between), so
 * it is dropped and the stream start is used as the window origin instead.
 */
const STALE_REQUEST_MS = 10 * 60 * 1000;

interface SpeedState {
  sessionId: string;
  samples: ResponseSample[];
  charsPerToken: number;
  enabled: boolean;
  // ephemeral (never persisted)
  markers: StreamMarkers;
  streaming: boolean;
  lastLiveRenderTs: number;
  panelOpen: boolean;
}

function freshState(sessionId: string, enabled: boolean): SpeedState {
  return {
    sessionId,
    samples: [],
    charsPerToken: CHARS_PER_TOKEN_FALLBACK,
    enabled,
    markers: newMarkers(),
    streaming: false,
    lastLiveRenderTs: 0,
    panelOpen: false,
  };
}

function coerceUsage(raw: unknown): { output: number; reasoning: number | null } | null {
  if (!isRecord(raw)) return null;
  if (!isFiniteNumber(raw.output)) return null;
  return {
    output: raw.output,
    reasoning: isFiniteNumber(raw.reasoning) ? raw.reasoning : null,
  };
}

/** Characters carried by a streaming event, or null when it is not a content delta. */
function deltaChars(assistantMessageEvent: unknown): number | null {
  if (!isRecord(assistantMessageEvent)) return null;
  const type = assistantMessageEvent.type;
  if (type !== "text_delta" && type !== "thinking_delta" && type !== "toolcall_delta") return null;
  const delta = assistantMessageEvent.delta;
  return isString(delta) ? delta.length : 0;
}

export default function tokenSpeedExtension(pi: ExtensionAPI): void {
  pi.registerFlag(ENABLED_FLAG, {
    type: "boolean",
    default: true,
    description: "Show token generation speed (tok/s) in the footer. Use --token-speed=false to hide it.",
  });

  let state = freshState("", true);

  function persist(): void {
    try {
      pi.appendEntry<SpeedSnapshot>(
        CUSTOM_TYPE,
        buildSnapshot({
          sessionId: state.sessionId,
          samples: state.samples,
          charsPerToken: state.charsPerToken,
          enabled: state.enabled,
        }),
      );
    } catch {
      // persistence is best-effort
    }
  }

  /** Current live view, or null when idle / too early to be meaningful. */
  function currentLive(now: number): LiveView | null {
    if (!state.streaming) return null;
    const speed = liveSpeed(state.markers, state.charsPerToken, now);
    if (speed === null) return null;
    return liveView(
      { chars: state.markers.chars, firstDeltaTs: state.markers.firstDeltaTs },
      state.charsPerToken,
      now,
    );
  }

  function panelInput(now: number): PanelInput {
    return {
      sessionId: state.sessionId,
      samples: state.samples,
      charsPerToken: state.charsPerToken,
      live: currentLive(now),
    };
  }

  function setFooter(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    try {
      if (!state.enabled) {
        ctx.ui.setStatus(STATUS_KEY, undefined);
        return;
      }
      const stats = sessionStats(state.samples);
      const last = lastSample(state.samples);
      ctx.ui.setStatus(
        STATUS_KEY,
        footerLine({
          live: currentLive(Date.now())?.speed ?? null,
          last: last?.speed ?? null,
          avg: stats.speed,
        }),
      );
    } catch {
      // UI may be unavailable
    }
  }

  // --- /speed panel widget (above the editor) ---------------------------
  function panelFactory() {
    return (_tui: unknown, theme: unknown): TokenSpeedPanelComponent => {
      const themeFg = (theme as { fg?: (c: string, t: string) => string }).fg;
      const overlayTheme =
        typeof themeFg === "function" ? { fg: (c: string, t: string) => themeFg.call(theme, c, t) } : undefined;
      return buildTokenSpeedPanelComponent({
        getInput: () => panelInput(Date.now()),
        theme: overlayTheme,
      });
    };
  }

  function showPanel(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    try {
      ctx.ui.setWidget(WIDGET_KEY, panelFactory(), { placement: "aboveEditor" });
    } catch {
      // UI may be unavailable
    }
  }

  function hidePanel(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    try {
      ctx.ui.setWidget(WIDGET_KEY, undefined, { placement: "aboveEditor" });
    } catch {
      // ignore
    }
  }

  /** Re-render the panel with the latest numbers — only while it is shown. */
  function refreshPanel(ctx: ExtensionContext): void {
    if (!state.panelOpen) return;
    showPanel(ctx);
  }

  /** Ignore events coming from another session (e.g. in-process sub-agents). */
  function isCurrentSession(ctx: ExtensionContext): boolean {
    try {
      const id = ctx.sessionManager.getSessionId();
      if (!id) return true;
      if (!state.sessionId) {
        state.sessionId = id;
        return true;
      }
      return id === state.sessionId;
    } catch {
      return true;
    }
  }

  // ② Window origin for TTFT / total time. Runs once per provider attempt, so
  //    retries refresh the timestamp.
  pi.on("before_provider_request", (_event, ctx) => {
    try {
      if (!isCurrentSession(ctx)) return undefined;
      markRequestStart(state.markers, Date.now());
    } catch {
      // ignore
    }
    return undefined;
  });

  // ②b New assistant message: reset the stream markers, keep a recent request
  //     origin so TTFT is measured from the actual provider call.
  pi.on("message_start", (event, ctx) => {
    try {
      if (!isCurrentSession(ctx)) return undefined;
      const message = event.message as unknown;
      if (!isRecord(message) || message.role !== "assistant") return undefined;

      const now = Date.now();
      const requestStart = state.markers.requestStartTs;
      resetMarkers(state.markers);
      if (requestStart !== null && now - requestStart <= STALE_REQUEST_MS) {
        state.markers.requestStartTs = requestStart;
      }
      markMessageStart(state.markers, now);
      state.streaming = true;
      state.lastLiveRenderTs = 0;
      setFooter(ctx);
      refreshPanel(ctx);
    } catch {
      // ignore
    }
    return undefined;
  });

  // ① Live estimate while streaming. Throttled so we do not re-render the
  //    footer for every single delta.
  pi.on("message_update", (event, ctx) => {
    try {
      if (!state.streaming) return undefined;
      if (!isCurrentSession(ctx)) return undefined;
      const chars = deltaChars(event.assistantMessageEvent);
      if (chars === null) return undefined;

      const now = Date.now();
      markDelta(state.markers, chars, now);
      if (now - state.lastLiveRenderTs < LIVE_THROTTLE_MS) return undefined;
      state.lastLiveRenderTs = now;
      setFooter(ctx);
      refreshPanel(ctx);
    } catch {
      // ignore
    }
    return undefined;
  });

  // ③ Exact measurement at message_end (authoritative provider usage).
  pi.on("message_end", (event, ctx) => {
    try {
      if (!isCurrentSession(ctx)) return undefined;
      const message = event.message as unknown;
      if (!isRecord(message) || message.role !== "assistant") return undefined;

      const now = Date.now();
      const usage = coerceUsage(message.usage);
      const modelKey = isString(message.provider) && isString(message.model)
        ? `${message.provider}/${message.model}`
        : (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown");

      const sample = usage
        ? buildSample({
            markers: state.markers,
            endTs: now,
            outputTokens: usage.output,
            reasoningTokens: usage.reasoning,
            stopReason: message.stopReason,
            modelKey,
          })
        : null;

      if (sample) {
        state.samples = appendSample(state.samples, sample, HISTORY_LIMIT);
        state.charsPerToken = learnCharsPerToken(state.charsPerToken, sample.chars, sample.outputTokens);
        persist();
      }

      // A finished (or failed) message is no longer live.
      state.streaming = false;
      resetMarkers(state.markers);
      setFooter(ctx);
      refreshPanel(ctx);
    } catch {
      // never let a metric failure break the agent loop
    }
    return undefined;
  });

  // Safety net: if a turn ends without a message_end (abort), drop the live
  // number instead of leaving a frozen estimate in the footer.
  pi.on("agent_end", (_event, ctx) => {
    try {
      if (state.streaming) {
        state.streaming = false;
        resetMarkers(state.markers);
        setFooter(ctx);
        refreshPanel(ctx);
      }
    } catch {
      // ignore
    }
    return undefined;
  });

  // Cold start / reload / fork — restore measured samples + learned ratio.
  pi.on("session_start", (_event, ctx) => {
    try {
      const sessionId = ctx.sessionManager.getSessionId();
      const flagEnabled = pi.getFlag(ENABLED_FLAG) !== false;
      const restored = restoreFromBranch(ctx.sessionManager.getBranch(), sessionId);
      state = {
        ...freshState(sessionId, flagEnabled && restored.enabled),
        samples: restored.samples,
        charsPerToken: clampRatio(restored.charsPerToken),
      };
      setFooter(ctx);
    } catch {
      // ignore
    }
    return undefined;
  });

  // Persist before leaving this session (switch / fork / new).
  pi.on("session_before_switch", () => {
    try {
      persist();
    } catch {
      // ignore
    }
    return undefined;
  });

  // Tear down UI surfaces.
  pi.on("session_shutdown", (_event, ctx) => {
    try {
      persist();
      if (ctx.hasUI) {
        ctx.ui.setStatus(STATUS_KEY, undefined);
        hidePanel(ctx);
      }
      state.panelOpen = false;
    } catch {
      // ignore
    }
    return undefined;
  });

  // /speed — toggle the panel, or control the footer line.
  pi.registerCommand("speed", {
    description:
      "Token generation speed: /speed toggles the detail panel, /speed on|off controls the footer line, /speed status prints a summary.",
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim().toLowerCase();

      if (arg === "on" || arg === "off") {
        state.enabled = arg === "on";
        persist();
        setFooter(ctx);
        refreshPanel(ctx);
        try {
          ctx.ui.notify(`token-speed: footer ${state.enabled ? "enabled" : "disabled"}`, "info");
        } catch {
          // ignore
        }
        return;
      }

      if (arg === "status" || arg === "help") {
        const input = panelInput(Date.now());
        const text = arg === "help" ? buildPanelLines(input).join("\n") : footerLine({
          live: input.live?.speed ?? null,
          last: lastSample(state.samples)?.speed ?? null,
          avg: sessionStats(state.samples).speed,
        });
        try {
          ctx.ui.notify(text, "info");
        } catch {
          // eslint-disable-next-line no-console
          console.log(text);
        }
        return;
      }

      if (!ctx.hasUI) {
        const input = panelInput(Date.now());
        const text = buildPanelLines(input).join("\n");
        try {
          ctx.ui.notify(text, "info");
        } catch {
          // eslint-disable-next-line no-console
          console.log(text);
        }
        return;
      }

      if (state.panelOpen) {
        state.panelOpen = false;
        hidePanel(ctx);
        return;
      }
      state.panelOpen = true;
      showPanel(ctx);
    },
  });
}
