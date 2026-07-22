/**
 * input-history — cross-session prompt history + reverse search.
 *
 * pi's native editor (pi-tui) already implements in-memory ↑/↓ recall for the
 * current session (seeded from the session on startup). This extension adds
 * the two things it lacks:
 *   1. persistence of submitted prompts to a global JSONL, so prompts survive
 *      across sessions, and
 *   2. reverse incremental search over that cross-session history.
 *
 * It deliberately does NOT bind ↑/↓ — the native editor owns those (native
 * per-session history recall + cursor movement), and the extension API exposes
 * no way to inject into that in-memory history, so stealing the keys would only
 * degrade the built-in behavior.
 *
 * The reverse-search key is NOT Ctrl+R: pi binds `ctrl+r` to
 * `app.session.rename`, so registering `ctrl+r` here would collide with the
 * built-in and the reverse search would never fire. We default to `alt+r`
 * (unused by any pi/pi-tui default binding, and reliably emitted by common
 * terminals — pi already ships several `alt+<letter>` editor bindings) and make
 * it configurable via the `input-history-search-key` flag.
 */

import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { isSameAsLast, shouldCapture, toRecallList, type HistoryEntry } from "./src/history.js";
import { appendEntry, historyPath, readRecent } from "./src/store.js";
import { SearchOverlay } from "./src/search-overlay.js";

const SEARCH_KEY_FLAG = "input-history-search-key";
/**
 * Default open key. `alt+r` is intentionally chosen over `ctrl+r`:
 *   - `ctrl+r` is already bound to `app.session.rename` by pi.
 *   - `ctrl+shift+r` is not distinguishable from `ctrl+r` on many terminals.
 *   - `alt+<letter>` sequences are emitted reliably across terminals (pi's own
 *     defaults use `alt+b`/`alt+f`/`alt+d`/`alt+y`), and `alt+r` is unused.
 */
const DEFAULT_SEARCH_KEY = "alt+r";

export default function inputHistoryExtension(pi: ExtensionAPI): void {
  installInputHistory(pi, historyPath(homedir()));
}

/**
 * Wire input capture + reverse-search recall against a specific history file
 * path. Exposed (rather than inlined into the default export) so tests can
 * drive the capture behavior against a temp file instead of the real home dir.
 */
export function installInputHistory(pi: ExtensionAPI, path: string): void {
  let lastCaptured: string | undefined;

  pi.registerFlag(SEARCH_KEY_FLAG, {
    type: "string",
    default: DEFAULT_SEARCH_KEY,
    description:
      `Key that opens cross-session reverse search (default "${DEFAULT_SEARCH_KEY}"). ` +
      `Ctrl+R is intentionally avoided because pi binds it to app.session.rename; ` +
      `to reclaim ctrl+r for search, rebind app.session.rename in keybindings.json ` +
      `and set this flag to "ctrl+r".`,
  });

  pi.on("input", (event, ctx) => {
    try {
      if (shouldCapture(event.text, event.source) && !isSameAsLast(lastCaptured, event.text)) {
        const entry: HistoryEntry = {
          ts: Date.now(),
          text: event.text,
          cwd: ctx.cwd,
        };
        appendEntry(path, entry);
        lastCaptured = event.text;
      }
    } catch {
      // Never let history bookkeeping break input handling.
    }
    return { action: "continue" };
  });

  const searchKey = resolveSearchKey(pi);
  pi.registerShortcut(searchKey, {
    description: "reverse-search cross-session input history",
    handler: (ctx) => openReverseSearch(ctx, path, searchKey),
  });
}

/** Read the configured open key, falling back to the default when unset/blank. */
function resolveSearchKey(pi: ExtensionAPI): KeyId {
  const raw = pi.getFlag(SEARCH_KEY_FLAG);
  const key = typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : DEFAULT_SEARCH_KEY;
  return key as KeyId;
}

async function openReverseSearch(
  ctx: ExtensionContext,
  path: string,
  searchKey: KeyId,
): Promise<void> {
  if (!ctx.hasUI) return;

  const entries = readRecent(path);
  const items = toRecallList(entries);
  if (items.length === 0) {
    ctx.ui.notify("No input history yet", "info");
    return;
  }

  let unsubscribeInput: (() => void) | undefined;
  try {
    await ctx.ui.custom<void>((tui, theme, _kb, done) => {
      const overlay = new SearchOverlay(
        theme,
        items,
        (text) => {
          ctx.ui.setEditorText(text);
          done();
        },
        () => done(),
        searchKey,
      );
      unsubscribeInput = tui.addInputListener((data) => {
        overlay.handleInput(data);
        tui.requestRender();
        return { consume: true };
      });
      return overlay;
    }, {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: "80%",
        maxHeight: "70%",
        margin: 1,
      },
    });
  } finally {
    unsubscribeInput?.();
  }
}
