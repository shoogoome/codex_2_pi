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
// — height is NOT passed in directly. We derive a body height from the
// width-implied terminal aspect (assume 24-row default) and the OverlayOptions
// `maxHeight: "100%"` setting; for v1 we just hard-code a generous max so
// the truncation rule kicks in only on very long backlogs.

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
   * truncation budget for the rendered string[].
   */
  defaultHeight?: number;
}

export interface TeammateOverlayComponent extends Component {
  dispose(): void;
}

const FALLBACK_HEIGHT = 40;

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
      const h = deps.defaultHeight ?? FALLBACK_HEIGHT;
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
