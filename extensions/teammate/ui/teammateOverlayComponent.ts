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
// output to exactly `height` rows so the overlay paints over the full
// viewport (otherwise teammates with short timelines would leak the
// leader's main chat through underneath). We pick a generous default
// (200) that covers any reasonable terminal; callers wanting tighter
// fit can inject `getHeight` to return the live terminal row count.

import type { Component } from "@earendil-works/pi-tui";
import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import type { TeammateIdentity } from "../types.js";
import {
  renderTeammateOverlay,
  type TeammateOverlayHeader,
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
      const h = deps.getHeight?.() ?? deps.defaultHeight ?? FALLBACK_HEIGHT;
      const entries = ensureSm().getEntries();
      const headerExtra = deps.getTaskHeader();
      const header: TeammateOverlayHeader = {
        identity: deps.identity,
        taskCount: headerExtra.taskCount,
        isIdle: headerExtra.isIdle,
        exitHint: "Esc to exit teammate view",
      };
      return renderTeammateOverlay(header, entries, width, h);
    },
    invalidate(): void {
      // No internal cached render state — render() reads fresh each time.
    },
    dispose(): void {
      sm = undefined;
    },
  };
}
