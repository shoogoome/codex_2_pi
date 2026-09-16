// Adapter: wraps the pure renderTeammateOverlay into a Pi-TUI Component.
//
// Lazily opens the teammate's session jsonl on first render via the injected
// openSession factory (production callers pass `SessionManager.open`). Each
// subsequent render reuses the cached SessionManager and re-reads
// getEntries() — Path Y is read-only, so we never mutate the teammate's
// jsonl from this overlay.
//
// `getTaskHeader` is called fresh on every render so the header bar
// (turnCount / isIdle) tracks the latest TaskStore state. The leader's
// store-change subscriber drives `tui.requestRender()` which will re-call
// our `render()` — no need for the overlay to subscribe internally.
//
// Pi TUI's Component.render signature is `render(width: number) => string[]`
// — height is NOT passed in directly. The render layer ALWAYS pads its
// output to the full body height so the overlay paints over the viewport
// (otherwise teammates with short timelines would leak the leader's main
// chat through underneath).
//
// Height resolution order — first available wins:
//   1. `getHeight()` — live terminal rows, injected by the caller
//   2. `defaultHeight`
//   3. `FALLBACK_HEIGHT`
//
// The fallback is a safety net only. A caller that can see the terminal must
// inject `getHeight`: `renderTeammateOverlay` slices the body to the LAST
// `height - 2` rows and pads short bodies to `height`. With an overstated
// height the newest line sits at the bottom of an oversized buffer, and the
// host clips the overflow from the TOP — so the visible window shows stale
// rows with the newest teammate message cut off below instead of scrolled into
// view. Passing the real row count keeps the last line flush with the
// viewport bottom.

import type { Component } from "@earendil-works/pi-tui";
import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import type { TeammateIdentity } from "../types.js";
import {
  renderTeammateOverlay,
  teammateViewHeight,
  type TeammateOverlayHeader,
  type TeammateOverlayRenderTheme,
} from "./teammateOverlayRender.js";

/** Minimal SessionManager surface this component actually uses. */
export interface OverlaySessionReader {
  getEntries(): SessionEntry[];
}

export interface TeammateOverlayDeps {
  identity: TeammateIdentity;
  sessionFile: string;
  /** Latest task state — for header (turnCount, isIdle). Re-read on each render. */
  getTaskHeader: () => Pick<TeammateOverlayHeader, "taskCount" | "isIdle">;
  /**
   * SessionManager.open factory — injectable for tests. In production callers
   * pass `SessionManager.open` which returns a real SessionManager that we
   * narrow to the subset we need.
   */
  openSession: (path: string) => OverlaySessionReader | SessionManager;
  /**
   * Default body height when render() is called without one. Overlay uses
   * "100%" maxHeight so the host already constrains visually; this is the
   * truncation budget for the rendered string[] AND the row count we
   * emit (the render layer pads short timelines with empty strings up
   * to `defaultHeight` rows so the overlay covers the full viewport —
   * no main-stream bleed-through underneath).
   */
  defaultHeight?: number;
  /**
   * Optional callback invoked on every render to obtain the current
   * terminal height. When provided, takes precedence over `defaultHeight`.
   * Pi's Component.render signature does not pass height in, so callers
   * that DO know it (e.g. via tui internals) can thread it through here
   * for a tight fit.
   */
  getHeight?: () => number;
  /**
   * Optional theme handle for ANSI colouring. Forwarded as-is into
   * `renderTeammateOverlay` so the rendered string[] carries semantic
   * colour codes (accent / success / muted / dim / text). Production
   * callers pass the Pi `Theme` from the `ctx.ui.custom` factory; tests
   * either omit it or pass a mock. Default: plain pass-through.
   */
  theme?: TeammateOverlayRenderTheme;
}

export interface TeammateOverlayComponent extends Component {
  dispose(): void;
}

const FALLBACK_HEIGHT = 200;

export function buildTeammateOverlayComponent(
  deps: TeammateOverlayDeps,
): TeammateOverlayComponent {
  let sm: OverlaySessionReader | undefined;

  function ensureSm(): OverlaySessionReader {
    if (!sm) sm = deps.openSession(deps.sessionFile) as OverlaySessionReader;
    return sm;
  }

  return {
    render(width: number): string[] {
      // `getHeight` reports the TERMINAL's row count, not how many rows this
      // overlay may use: the input dock occupies the bottom of the same frame
      // the overlay composites onto, so claiming every row painted over the
      // editor. `teammateViewHeight` subtracts the dock reserve.
      const terminalRows = deps.getHeight?.();
      const h =
        terminalRows !== undefined
          ? teammateViewHeight(terminalRows)
          : (deps.defaultHeight ?? FALLBACK_HEIGHT);
      const entries = ensureSm().getEntries();
      const headerExtra = deps.getTaskHeader();
      const header: TeammateOverlayHeader = {
        identity: deps.identity,
        taskCount: headerExtra.taskCount,
        isIdle: headerExtra.isIdle,
        exitHint: "type + Enter to send · Esc to exit",
      };
      return renderTeammateOverlay(header, entries, width, h, {
        theme: deps.theme,
      });
    },
    invalidate(): void {
      // No internal cached render state — render() reads fresh each time.
    },
    dispose(): void {
      sm = undefined;
    },
  };
}
