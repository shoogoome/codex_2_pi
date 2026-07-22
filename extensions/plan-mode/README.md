# plan-mode

A read-only **planning gate** for pi, modeled on Claude's EnterPlanMode /
ExitPlanModeV2: explore only → submit a plan → user approves → resume with full
tools.

## Usage

- `/plan` — toggle plan mode; `/plan on` / `/plan off` to force a state. This is
  the reliable primary entry point and does not depend on any shortcut.
- `Alt+P` (default) — toggle plan mode. Configurable via the
  `plan-mode-toggle-key` flag (see below).
- `--plan` — start a session directly in plan mode.

While in plan mode:

- Active tools are narrowed to a read-only set: write / edit / apply_patch are
  removed, `bash` stays but write bash commands (rm, mv, git commit, npm
  install, sed -i, redirects, editors, sudo, ...) are blocked at runtime.
- The system prompt is augmented with planning instructions.
- The footer shows `⏸ plan mode on`.

The model leaves plan mode by calling `exit_plan_mode` with its finished plan;
the user confirms via a dialog. On approval the pre-plan tool set is restored;
on rejection you stay in plan mode. `/plan off` exits without a confirm (the
user asked directly). In print/RPC mode (no UI) `exit_plan_mode` exits without a
confirm.

## Coexistence with approvals

plan-mode and approvals both hook `tool_call`; either returning `{block:true}`
intercepts the call, so they compose naturally. plan-mode only decides "is this
read-only?" — it does not duplicate approvals' rules.

## Why not Shift+Tab

`Shift+Tab` is the built-in default for `app.thinking.cycle` (cycle the thinking
level). If plan-mode registered `shift+tab`, pi reports at startup
`Extension shortcut 'shift+tab' conflicts with built-in shortcut. Skipping.` and
the plan-mode shortcut never fires. So the default toggle key is **`alt+p`** —
unused by any pi/pi-tui default binding and reliably emitted by common terminals
(pi's own editor already uses `alt+b`/`alt+f`/`alt+d`/`alt+y`). Regardless of the
shortcut, `/plan` is always the reliable primary entry point.

If you want `Shift+Tab` for plan mode, first rebind `app.thinking.cycle` to
another key in `~/.pi/agent/keybindings.json` to free `shift+tab`, then set the
toggle key back to `shift+tab` (see below).

## Configuring the toggle key

The toggle key is controlled by the `plan-mode-toggle-key` flag (a pi keybinding
id string such as `alt+p`, `ctrl+shift+p`, `f4`, …). Set it on the CLI / in your
pi config, e.g. `--plan-mode-toggle-key ctrl+shift+p`. A blank or unset value
falls back to `alt+p`.
