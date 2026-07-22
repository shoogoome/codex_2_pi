# input-history

Cross-session prompt history and reverse search for the pi interactive editor.

## What it adds

- **Persistent history** — every prompt you submit interactively is appended to
  a global JSONL at `~/.pi/agent/input-history.jsonl` (one `{ts,text,cwd}` per
  line, atomic `O_APPEND`), so prompts survive across sessions and projects.
- **Reverse search** — `Alt+R` (default) opens an incremental-search overlay
  over the cross-session history. Type to filter (case-insensitive substring,
  newest first), `Alt+R`/`↑` steps to older matches, `↓` to newer, `Enter`
  recalls the selected prompt into the editor, `Esc` cancels.

## Why not Ctrl+R

pi already binds `ctrl+r` to `app.session.rename` (see
`docs/keybindings.md`). Registering `ctrl+r` here would collide with that
built-in and the reverse search would silently never fire. So the default open
key is **`alt+r`** — unused by any pi/pi-tui default binding and reliably
emitted by common terminals (pi's own editor already uses `alt+b`/`alt+f`/
`alt+d`/`alt+y`).

If you want `ctrl+r` for reverse search, first rebind `app.session.rename` to
another key in `~/.pi/agent/keybindings.json`, then set the open key back to
`ctrl+r` (see below).

## Configuring the open key

The open key is controlled by the `input-history-search-key` flag (a pi
keybinding id string such as `alt+r`, `ctrl+shift+r`, `f4`, …). Set it on the
CLI / in your pi config, e.g. `--input-history-search-key ctrl+r`. A blank or
unset value falls back to `alt+r`. The overlay's "older match" step key and its
hint line both follow whatever open key you configure.

## What it does *not* do

- It does **not** bind `↑`/`↓`. pi's built-in editor already provides in-memory
  history recall for the *current* session (plus cursor movement), and the
  extension API exposes no way to inject into that native history — so `↑`/`↓`
  are left untouched to avoid degrading built-in behavior. Cross-session recall
  is via the reverse-search key (`Alt+R` by default). Inside the overlay the
  input listener consumes all keys, so the open key stepping "older" there never
  reaches pi's native binding for that key.

## Capture rules

- Only interactive input is stored (RPC / extension-sourced input is ignored).
- Empty / whitespace-only input and slash-commands (`/help`, `/clear`, …) are
  not stored.
- Consecutive duplicate prompts are de-duped (identical to the last stored line
  is skipped). Recall also collapses duplicates, keeping the most recent.

## Notes

- Recall via the reverse-search key clobbers the current draft when you accept a
  match (matching claude/codex recall behavior).
- Reads tolerate malformed / partially written lines from concurrent sessions
  and cap at the 500 most-recent entries. All history IO is best-effort and
  never blocks input.

