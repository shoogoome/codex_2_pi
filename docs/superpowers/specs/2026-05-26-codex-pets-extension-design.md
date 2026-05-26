# Codex-style Terminal Pets Extension Design

## Summary

Add a Codex-style ambient terminal pet to the Pi Codex Replica package as a new
extension (`extensions/pets`). The pet lives next to the editor as a Pi widget,
reacts to agent lifecycle events (working / waiting / completed / failed), and
renders either as a real terminal image (Kitty graphics in supported terminals)
or as a Unicode block-art fallback that works everywhere, including SSH, tmux
without passthrough, screen, and web terminals.

The first version explicitly targets remote Pi usage, where tmux and SSH are
common. Image rendering inside tmux is supported as an opt-in path that wraps
Kitty graphics escapes in tmux DCS passthrough. Sixel and iTerm2 inline images
are intentionally excluded from MVP for stability reasons.

Pet artwork is supplied as a static spritesheet bundled with the extension plus
a user-managed directory (`~/.pi/pets/<id>/`) compatible with Codex's custom pet
manifest format. Generating new pet artwork from prompts is a follow-up project
that depends on a future Pi `imagegen` extension and an accompanying skill; it
is not part of this extension's MVP.

The single bundled pet has id `default` and is shipped under CC0. We do not
reuse Codex's CDN artwork or the `codex` pet id, to avoid licensing ambiguity
and to make the boundary between Codex and this Pi extension explicit.

## Goals

- Provide a Codex-style ambient pet rendered next to the editor in interactive
  Pi sessions.
- Reflect agent state (`running` / `waiting` / `review` / `failed` / `idle`)
  through pet animations, mirroring Codex's notification kinds.
- Render real terminal images via Pi's built-in `Image` component (Kitty
  graphics protocol) when the terminal supports it. Use iTerm2 3.6+ inline
  graphics only outside tmux; inside tmux fall back to block-art unless the
  user opts into Kitty + tmux passthrough.
- Provide a Unicode block-art fallback that works in any terminal, including
  SSH, tmux without passthrough, screen, and web terminals.
- Support opt-in Kitty graphics inside tmux through DCS passthrough, with clear
  user-facing documentation of the trade-offs.
- Ship a single CC0-licensed built-in pet plus a documented format for
  user-supplied pets compatible with Codex's `pet.json` layout.
- Expose user-facing `/pets`, `/pets list`, `/pets set`, `/pets on`,
  `/pets off`, `/pets diagnose`, and `/pets tmux-passthrough` commands.
- Persist pet selection and tmux-passthrough preference to
  `~/.pi/pets.json` so the configuration survives restarts.
- Keep all rendering inside the Pi widget pipeline; no raw `process.stdout`
  writes that bypass Pi's differential renderer.

## Non-Goals

- Do not bundle Codex's CDN spritesheets; their artwork license is unclear.
- Do not implement Sixel rendering. Pi's built-in `Image` component does not
  support Sixel, and Sixel inside tmux is the least reliable path.
- Do not implement iTerm2 inline graphics inside tmux. iTerm2's inline image
  escape passes through DCS unreliably across tmux versions.
- Do not implement Codex's built-in catalog with CDN download. Built-in pets
  are statically bundled with the extension package.
- Do not implement Codex's pet picker side-preview pane. The first version uses
  a plain `SelectList` and a textual description.
- Do not generate pet artwork from prompts in this extension. Generation is the
  responsibility of a future `imagegen` extension and an optional `pets` skill
  that bridges the two.
- Do not attempt to render images through mosh or web terminal proxies.
- Do not attempt to detect or quietly disable in zellij or screen; the
  fallback path keeps the pet visible as block-art in those environments.

## Architecture

### Extension package

Add a new extension package `extensions/pets` and register it in the root
`package.json` under `pi.extensions`.

```
extensions/pets/
  index.ts                # Pi entry point: register tools, commands, widget, events
  package.json
  README.md
  catalog/
    catalog.ts            # Built-in pet metadata
    catalog.test.ts
    default/
      pet.json            # Frame geometry, animations
      spritesheet.webp    # CC0 placeholder artwork
      LICENSE             # CC0 dedication
      fallback.ts         # Tiny hard-coded ASCII pet for ultimate fallback
  state/
    pet-state.ts          # State machine: idle/running/waiting/review/failed
    pet-state.test.ts
  config/
    settings.ts           # Load/save ~/.pi/pets.json
    settings.test.ts
  loader/
    pet-loader.ts         # Resolve pet id → frames on disk
    pet-loader.test.ts
    frames.ts             # Split spritesheet into per-frame PNGs (jimp)
    frames.test.ts
  render/
    capability.ts         # Detect terminal/tmux/passthrough capability
    capability.test.ts
    image-renderer.ts     # Wraps Pi tui Image component for one frame
    block-art.ts          # Half-block + Braille fallback renderer
    block-art.test.ts
    tmux-passthrough.ts   # Wrap Kitty graphics escapes in tmux DCS passthrough
    tmux-passthrough.test.ts
  widget/
    pet-widget.ts         # setWidget integration, render dispatch, animation tick
    pet-widget.test.ts
  commands/
    pets-command.ts       # /pets, /pets set, /pets off, /pets diagnose, /pets tmux-passthrough
    pets-command.test.ts
```

### Runtime layout

```
Pi extension runtime
  └─ pets extension
       ├─ PetState (event-driven state machine)
       ├─ PetLoader (id → on-disk pet + frame PNGs)
       ├─ PetCapability (Kitty / iTerm2 / tmux / passthrough)
       ├─ PetRenderer
       │    ├─ ImageRenderer (wraps pi-tui Image)
       │    └─ BlockArtRenderer (Unicode half-block + true color)
       ├─ PetWidget
       │    └─ ctx.ui.setWidget("codex-pet", componentFactory, { placement })
       │
       │  Note: "codex-pet" is the widget key only. The bundled pet id is
       │  `default`; the widget key is unrelated to pet id and matches the
       │  package-internal name `codex-pet`.
       └─ PetCommands (/pets ...)
```

### Pi lifecycle hooks

- `session_start` — load settings from `~/.pi/pets.json`, resolve selected
  pet, install the widget when interactive (`hasUI === true`).
- `session_shutdown` — clear the widget so the terminal cleans up image data.
- `agent_start` / `turn_start` — push `running` state.
- `turn_end` — inspect `event.message`. If the message is an assistant
  message with `stopReason === "error" || stopReason === "aborted"` or a
  non-empty `errorMessage`, push `failed`; otherwise push `review` and start
  the `reviewLingerMs` timer.
- `tool_execution_start` for `request_user_input` / `ask_user_question` /
  `askUserQuestion` / approval-style tools — push `waiting`. The exact tool
  name list is hard-coded in `state/pet-state.ts` and matches the names
  registered by `extensions/user-input`.
- `tool_execution_end` with `isError === true` — push `failed`.
- `agent_end` — inspect the last entry in `event.messages`. If it is an
  assistant message with `stopReason ∈ {"error", "aborted"}` or a non-empty
  `errorMessage`, push `failed`; otherwise leave the state alone (the
  preceding `turn_end` already set `review` / `failed`).

These map onto Codex's `PetNotificationKind::{Running, Waiting, Review, Failed}`
plus an extra `idle` rest state.

## Data model

### Pet manifest format

User-installable pets live under `~/.pi/pets/<id>/`. The manifest follows
Codex's `pet.json` layout so that users can drop in compatible custom pets:

```json
{
  "id": "default",
  "displayName": "Default",
  "description": "A small CC0 pet bundled with the pets extension.",
  "spritesheetPath": "spritesheet.webp",
  "frame": { "width": 192, "height": 208, "columns": 8, "rows": 9 },
  "animations": {
    "idle":    { "frames": [0, 1, 2, 1], "fps": 4, "loop": true, "fallback": "idle" },
    "running": { "frames": [8, 9, 10, 11], "fps": 8, "loop": true, "fallback": "idle" },
    "waiting": { "frames": [16, 17], "fps": 2, "loop": true, "fallback": "idle" },
    "review":  { "frames": [24, 25, 26], "fps": 6, "loop": false, "fallback": "idle" },
    "failed":  { "frames": [32, 33], "fps": 4, "loop": true, "fallback": "idle" }
  }
}
```

Differences from Codex:

- The legacy `$CODEX_HOME/avatars/<id>/avatar.json` directory is not scanned in
  MVP; this extension only looks at `~/.pi/pets/<id>/pet.json`.
- A `blockArt` field is allowed at the top level for pets that want to ship a
  static ASCII/block-art fallback instead of asking the renderer to derive one
  from the spritesheet:
  ```json
  "blockArt": {
    "idle":    ["▟█▙", "███", "▝▀▘"],
    "running": ["▟█▙", "███", "↻↻↻"]
  }
  ```
  When present, block-art renderer prefers these static frames. When absent, it
  derives frames from the spritesheet by downsampling each animation frame to
  cell resolution and emitting half-block + true-color rows.

### Settings file

`~/.pi/pets.json`:

```json
{
  "selectedPet": "default",
  "enabled": true,
  "placement": "belowEditor",
  "tmuxPassthrough": false,
  "renderMode": "auto"
}
```

- `renderMode`: `"auto" | "image" | "block-art"`. `auto` follows the strategy
  below. The other two force a specific renderer; useful for debugging.
- `placement`: `"belowEditor" | "aboveEditor"`. Default `belowEditor` to match
  Codex's composer-anchored ambient pet placement.

## Rendering strategy

The renderer is chosen at widget-construction time and re-evaluated whenever
settings change or `session_start` fires. Selection is deterministic:

```
if !settings.enabled or !ctx.hasUI:
    do not register widget
elif renderMode == "image":
    use ImageRenderer
elif renderMode == "block-art":
    use BlockArtRenderer
else:  # auto
    caps = detectCapability()
    if caps.images == "kitty":
        if caps.inTmux:
            if settings.tmuxPassthrough and caps.tmuxPassthroughEnabled:
                use ImageRenderer with tmux DCS passthrough wrapper
            else:
                use BlockArtRenderer
        else:
            use ImageRenderer (raw Kitty graphics)
    elif caps.images == "iterm2" and not caps.inTmux:
        use ImageRenderer (iTerm2 inline graphics)
    else:
        use BlockArtRenderer
```

### Capability detection (`render/capability.ts`)

Pure function. Inputs are `process.env` and a `tmux` command runner; output is:

```ts
type ImageProtocol = "kitty" | "iterm2" | null;
interface PetCapability {
  images: ImageProtocol;       // From pi-tui getCapabilities()
  inTmux: boolean;             // TMUX or TMUX_PANE env
  tmuxVersion?: string;        // From `tmux -V`
  tmuxPassthroughEnabled?: boolean; // From `tmux show -gv allow-passthrough`
  reason: string;              // Human-readable summary for /pets diagnose
}
```

`getCapabilities()` is imported from `@earendil-works/pi-tui`. tmux probing
uses `ctx.exec("tmux", ["-V"])` and `ctx.exec("tmux", ["show", "-gv",
"allow-passthrough"])`. tmux probing is best-effort and never throws; on
failure the capability falls back to `inTmux: true` with
`tmuxPassthroughEnabled: undefined`.

### `ImageRenderer`

Wraps pi-tui's `Image` component. For each animation frame:

1. Read the per-frame PNG from disk into base64 once and cache it.
2. Construct `new Image(base64, "image/png", imageTheme, { maxWidthCells,
   maxHeightCells, imageId })`. Reuse a single `imageId` for the active pet so
   Kitty replaces, not stacks, frames.
3. Return the rendered string array as the widget render output.
4. On `invalidate()`, clear the `Image` cache; pi-tui handles theme changes
   that affect the fallback path.

When `settings.tmuxPassthrough` is on and the renderer is inside tmux, run the
output of `Image.render()` through `wrapKittyEscapesForTmux()`:

```ts
function wrapKittyEscapesForTmux(line: string): string {
  return line.replace(/\x1b_G[^\x1b]*\x1b\\/g, (m) => {
    const escaped = m.replace(/\x1b/g, "\x1b\x1b");
    return `\x1bPtmux;${escaped}\x1b\\`;
  });
}
```

The regex matches only Kitty graphics segments (`ESC _ G … ESC \`). SGR
sequences and other ANSI styling are left untouched. iTerm2 inline sequences
are deliberately not wrapped; iTerm2 inside tmux falls back to block-art.

### `BlockArtRenderer`

Two render sources, with the static one preferred when available:

1. If `pet.json` ships a `blockArt` block, use the static `string[]` for the
   active animation frame.
2. Otherwise, derive frames from the spritesheet:
   - Decode the spritesheet once with `jimp` (pure JS, no native bindings).
     Native `sharp` is intentionally avoided so the extension installs
     cleanly on remote hosts where `node-gyp`/native builds are restricted.
   - Extract per-frame RGBA buffers using the manifest frame geometry.
   - Downsample to a target cell grid (default `12 × 6` cells) using
     nearest-neighbor for crisp pixel-art look.
   - Emit two RGBA rows per cell row as Unicode half-block characters
     (`U+2580 ▀`) with foreground = top pixel, background = bottom pixel, both
     in 24-bit truecolor SGR. Skip cells where both halves have alpha < 32 to
     keep transparent areas blank.

The block-art renderer also handles the case where pi-tui's terminal
capabilities report `trueColor: false`: it dithers to the closest 256-color
ANSI palette using a small lookup table built at startup.

### Widget integration

The widget is installed in `session_start`:

```ts
ctx.ui.setWidget(
  "codex-pet",
  (tui, theme) => createPetComponent({ tui, theme, state, renderer }),
  { placement: settings.placement },
);
```

`createPetComponent` returns a Pi `Component`:

```ts
interface PetComponent {
  render(width: number): string[];
  invalidate(): void;
}
```

It maintains:

- The latest `PetState`.
- A frame index that advances on a `setInterval` tick, paced by the active
  animation's `fps`.
- Cached frame output keyed on `(state, frameIndex, width, renderer)`.

Each tick calls `tui.requestRender()`, and `render(width)` returns cached
output. When state changes the cache is invalidated and a re-render is
requested immediately.

To avoid excess work when the terminal is idle:

- The interval is paused while `state` is `idle` and the animation `fps` is
  zero or the animation has a single frame.
- The interval is stopped entirely during `session_shutdown` and when the
  widget is cleared.

## Commands

All commands are registered through `pi.registerCommand`. They follow the
existing `extensions/init` and `extensions/review` patterns.

- `/pets` — open a `SelectList` overlay listing the built-in pet plus any
  pets under `~/.pi/pets/`. Choosing a pet writes settings and re-installs
  the widget. Choosing the “Disable terminal pets” entry sets `enabled` to
  `false`.
- `/pets list` — print the same list as plain text (useful for non-interactive
  inspection).
- `/pets set <id>` — non-interactive selection by id.
- `/pets off` — disable pets.
- `/pets on` — re-enable pets with the previously selected id (falling back to
  the built-in pet).
- `/pets diagnose` — print the capability table:
  ```
  /pets diagnose
    selected pet: default
    enabled: true
    render mode: auto → BlockArtRenderer
    pi-tui images: kitty
    in tmux: yes (3.4, allow-passthrough on)
    tmux passthrough opt-in: false
    decision: BlockArtRenderer (image disabled inside tmux unless tmuxPassthrough is on)
  ```
- `/pets tmux-passthrough on|off` — toggle the tmux passthrough opt-in.
  When turning on, the command also checks `allow-passthrough` and prints a
  hint if it is off.

The selection picker uses the Pi TUI `SelectList` documented in the TUI
components guide, framed by `DynamicBorder` to match other Codex Replica
pickers.

## State machine

Transitions are driven by Pi extension events. Any of the four "active"
states can be replaced by any other; the machine never blocks transitions.
`idle` is the resting state and is the only state that times out on its own.

```
           agent_start / turn_start
  any state ───────────────────────────────────────────────▶ running

           tool_execution_start (request_user_input / ask_user_question /
                                 askUserQuestion / approval-style tools)
  running ─────────────────────────────────────────────────▶ waiting

           tool_execution_end (the matching input/approval tool, any result)
  waiting ─────────────────────────────────────────────────▶ running

           turn_end (success)
  running ─────────────────────────────────────────────────▶ review

           reviewLingerMs elapsed (no new agent activity)
  review  ─────────────────────────────────────────────────▶ idle

           agent_end (error) / turn_end (error) /
           tool_execution_end (isError) / errorMessage on agent_end
  any     ─────────────────────────────────────────────────▶ failed

           agent_start / turn_start
  failed  ─────────────────────────────────────────────────▶ running

           failedLingerMs elapsed
  failed  ─────────────────────────────────────────────────▶ idle
```

Default linger durations:

- `running`: no timeout. Stays until `waiting` / `review` / `failed` /
  `agent_end`.
- `waiting`: no timeout. Stays until the matching input/approval tool
  finishes.
- `review`: `reviewLingerMs = 30_000` (30 seconds), then → `idle`.
- `failed`: `failedLingerMs = 5 * 60_000` (5 minutes), then → `idle`. A new
  `agent_start` / `turn_start` overrides the linger and goes back to
  `running`.
- `idle`: indefinite, low-fps animation.

These values differ from Codex's `RUNNING_LIFETIME` / `FAILED_LIFETIME` /
`WAITING_LIFETIME` / `REVIEW_LIFETIME` because we do not display a
notification body next to the pet. The pet is purely visual, so lingering
longer than 30s on "review" provides no signal and confuses the next turn.

## Error handling

- **Missing built-in pet asset** (e.g., bundle corruption) — the extension
  logs a warning, disables the widget for the current session, and prints a
  user-visible notification.
- **Failed spritesheet decode** — fall back to block-art derived from the same
  spritesheet path; if that also fails, fall back to a tiny built-in ASCII pet
  hard-coded in `catalog/default/fallback.ts`.
- **`getCapabilities()` reports `images: null`** — silently use block-art.
- **tmux probe fails** — assume `inTmux: true`,
  `tmuxPassthroughEnabled: undefined`; the renderer treats this as "not opted
  in" and uses block-art.
- **Kitty image clear on shutdown** — when the widget is removed, the
  `Image` component clears its cached `imageId` via `pi-tui`'s normal teardown
  path. The pets extension does not write raw `ESC _Ga=d ESC \` escapes; this
  responsibility stays inside `pi-tui`.
- **User-supplied pet manifest invalid** — `/pets set <id>` prints a clear
  error with the offending JSON path and leaves the previous pet active.

## Security and privacy notes

- The extension reads only from `~/.pi/pets/` and the bundled `catalog/`
  directory. It does not download artwork at runtime.
- The tmux probe runs `tmux -V` and `tmux show -gv allow-passthrough`. These
  are read-only commands. No tmux state is mutated. The probe uses Pi's
  `ctx.exec` with the same sandbox semantics as other extensions in this
  package.
- The extension does not call any model API. State transitions are driven by
  local Pi events.
- The settings file `~/.pi/pets.json` is written via `fs.writeFile` with mode
  `0o600`, matching `extensions/goal`'s convention.

## Testing

Unit tests live next to each module, matching the package convention
(Vitest globals, lightweight fakes).

- `state/pet-state.test.ts` — drives the state machine through Pi event
  sequences and asserts the resulting state and animation name.
- `config/settings.test.ts` — load/save round-trip, default values, schema
  errors.
- `loader/pet-loader.test.ts` — manifest resolution from id, fallback to the
  built-in pet, invalid manifest handling.
- `loader/frames.test.ts` — extracts the correct sub-image grid from a fake
  spritesheet; verifies frame count matches manifest geometry.
- `render/capability.test.ts` — covers Kitty / iTerm2 / no-image envs, inside
  and outside tmux, tmux probes succeeding and failing.
- `render/block-art.test.ts` — half-block + truecolor output for a small
  fixture spritesheet, dithering path for `trueColor: false`.
- `render/tmux-passthrough.test.ts` — wraps Kitty graphics escapes only,
  leaves SGR untouched, escapes inner `ESC` correctly.
- `widget/pet-widget.test.ts` — tick scheduling, cache invalidation, no tick
  while idle, requestRender called on state transitions.
- `commands/pets-command.test.ts` — `/pets set` writes settings, `/pets off`
  toggles enabled, `/pets diagnose` formats the report from a capability
  fixture, `/pets tmux-passthrough` updates settings and warns when
  `allow-passthrough` is off.
- `index.test.ts` — integration test using fake Pi APIs to verify widget
  install/uninstall on `session_start` / `session_shutdown`, and event
  routing on agent lifecycle events.

Manual verification matrix recorded in `extensions/pets/README.md`:

| Terminal                  | tmux | renderMode | Expected                          |
| ------------------------- | ---- | ---------- | --------------------------------- |
| Kitty / WezTerm / Ghostty | no   | auto       | Image (Kitty graphics)            |
| Kitty / WezTerm / Ghostty | yes, passthrough off | auto | BlockArt                |
| Kitty / WezTerm / Ghostty | yes, passthrough on  | auto + tmuxPassthrough true | Image w/ DCS |
| iTerm2 3.6+               | no   | auto       | Image (iTerm2 inline)             |
| iTerm2 3.6+               | yes  | auto       | BlockArt                          |
| Windows Terminal          | any  | auto       | BlockArt                          |
| macOS Terminal.app        | any  | auto       | BlockArt                          |
| VSCode integrated         | any  | auto       | BlockArt                          |
| ttyd / Wetty web terminal | any  | auto       | BlockArt                          |
| mosh                      | any  | auto       | BlockArt                          |

## Open questions

- **Custom pet directory format compatibility with Codex.** The Codex layout
  uses `$CODEX_HOME/pets/<id>/pet.json`. We default to `~/.pi/pets/<id>/`. If
  Pi later defines a canonical `PI_HOME`, we will move there and keep a
  symlink-style fallback to `$CODEX_HOME/pets/` for users migrating from
  Codex.
- **Animation derivation from a single frame.** If a user supplies a pet with
  only an `idle` animation, should we synthesize a `running` animation by
  shifting frames, or leave it static? MVP: leave it static; document the
  expectation in `README.md`.
- **Idle CPU cost.** Even at low fps, a constant `setInterval` plus
  `requestRender` is not free. MVP keeps the tick at 2 fps while idle and
  pauses entirely after 30 minutes of no agent activity, resuming on the next
  Pi event. We can revisit if profiling shows it matters.

## Future work (out of scope)

- **`imagegen` extension.** Adds a `generate_image` tool that produces PNGs
  via OpenAI Images / Gemini Imagen / local Stable Diffusion. Independent of
  pets but a precondition for prompt-driven pet creation.
- **`pets` skill.** A SKILL.md that teaches the agent to generate `N` framed
  PNGs, pack them into a spritesheet, drop them into `~/.pi/pets/<id>/`,
  and then call `/pets set <id>`. Depends on the `imagegen` extension and the
  pets extension's pet manifest format defined here.
- **Codex CDN compatibility.** A small importer that reads existing Codex
  custom pet directories (`$CODEX_HOME/pets/<id>/`) directly. The manifest
  format is already compatible; only the directory root differs.
- **Pet picker side preview.** Re-add the Codex-style live preview pane in
  the `/pets` selector once the pi-tui select-list supports a side panel.
- **Sixel renderer.** Only if a real user needs it; not planned.
