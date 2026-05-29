# Pets

Codex-style ambient terminal pet for Pi. Renders next to the editor and
reflects agent state (running / waiting / review / failed / idle).

## Commands

- `/pets` — open the pet picker (interactive)
- `/pets list` — list available pets (built-in + `<agentDir>/pets/<id>`)
- `/pets set <id>` — select a pet without opening the picker
- `/pets on` / `/pets off` — toggle whether the pet is shown
- `/pets diagnose` — print the current rendering decision and capability
- `/pets tmux-passthrough on|off` — opt into Kitty graphics + tmux DCS
  passthrough (advanced; see below)

## Rendering

The renderer is chosen automatically:

| Terminal                  | tmux | Renderer                                |
| ------------------------- | ---- | --------------------------------------- |
| Kitty / WezTerm / Ghostty | no   | Kitty graphics (image)                  |
| Kitty / WezTerm / Ghostty | yes (passthrough off)               | block-art          |
| Kitty / WezTerm / Ghostty | yes (passthrough on + opt-in)       | Kitty + DCS (image) |
| iTerm2 3.6+               | no   | iTerm2 inline (image)                   |
| iTerm2 3.6+               | yes  | block-art                               |
| Windows Terminal          | any  | block-art                               |
| macOS Terminal.app        | any  | block-art                               |
| VSCode integrated         | any  | block-art                               |
| ttyd / Wetty web terminal | any  | block-art                               |
| mosh                      | any  | block-art                               |

Force a renderer for debugging:

```text
/pets set default
# then edit <agentDir>/pets.json:
#   "renderMode": "image" | "block-art" | "auto"
```

## Tmux + Kitty graphics

Image rendering is supported inside tmux through DCS passthrough. Requirements:

1. tmux 3.3 or newer.
2. `set -g allow-passthrough on` in `~/.tmux.conf`, then
   `tmux kill-server && tmux`.
3. `/pets tmux-passthrough on`.

Caveats:

- Scrolling tmux scrollback may flash old frames; Kitty image IDs are reused
  per pet, but tmux still stores the original DCS bytes in pane history.
- iTerm2 inline graphics inside tmux are intentionally not supported; iTerm2
  + tmux falls back to block-art.

## Custom pets

Drop a directory at `<agentDir>/pets/<id>/` containing `pet.json` plus the
spritesheet referenced by `spritesheetPath`. Manifest format matches the
Codex `pet.json` layout, plus an optional `blockArt` field for static
block-art frames (used when the renderer chooses block-art).

Minimal manifest:

```json
{
  "id": "my-pet",
  "displayName": "My Pet",
  "spritesheetPath": "spritesheet.png",
  "frame": { "width": 16, "height": 16, "columns": 4, "rows": 4 },
  "animations": {
    "idle":    { "frames": [0, 1, 2, 1], "fps": 4 },
    "running": { "frames": [4, 5, 6, 7], "fps": 8 },
    "waiting": { "frames": [8, 9],       "fps": 2 },
    "review":  { "frames": [12, 13],     "fps": 6, "loop": false },
    "failed":  { "frames": [14, 15],     "fps": 4 }
  },
  "blockArt": {
    "idle":    ["  ▟█▙  ", "  ███  ", "  ▝▀▘  "]
  }
}
```

Animation defaults: `fps: 4`, `loop: true`, `fallback: "idle"`.

## Files

- `<agentDir>/pets.json` — selected pet and rendering preferences.
- `<agentDir>/pets/<id>/` — custom pet packages.

## Future work

Generating new pet artwork from prompts is the responsibility of the
`imagegen` extension plus a future `pets` skill that drives image generation,
frame packing, and pet manifest creation; that work is independent of this
extension.

## Manual verification matrix

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
