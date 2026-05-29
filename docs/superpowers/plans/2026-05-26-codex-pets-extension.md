# Codex-style Terminal Pets Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `extensions/pets` package that renders a Codex-style ambient
terminal pet next to the Pi editor, reacts to agent lifecycle events, and
gracefully falls back to Unicode block-art whenever Kitty graphics is not
available (including SSH, tmux without passthrough, and web terminals).

**Architecture:** Pure TypeScript ESM extension package, discovered through the
existing `pi.extensions: ["./extensions"]` glob. Image rendering wraps Pi-TUI's
`Image` component; block-art rendering uses Unicode half-blocks with 24-bit
truecolor SGR. Settings live in `<agentDir>/pets.json` (where `agentDir` comes
from `getAgentDir()`). All escape output goes through Pi-TUI; no raw
`process.stdout` writes. State is driven by Pi extension events
(`agent_start`, `turn_start`, `turn_end`, `tool_execution_start`,
`tool_execution_end`, `agent_end`).

**Tech Stack:** TypeScript ESM, `@earendil-works/pi-coding-agent`,
`@earendil-works/pi-tui` (`Image`, `Component`, `setWidget`, `SelectList`,
`DynamicBorder`, `getCapabilities`, `truncateToWidth`), `typebox`, `jimp` for
spritesheet decoding (pure JS, no native bindings), Vitest globals
(`describe`/`it`/`expect`/`vi`).

**Spec:** `docs/superpowers/specs/2026-05-26-codex-pets-extension-design.md`

---

## File Structure

- Create `extensions/pets/package.json` — Pi extension manifest.
- Create `extensions/pets/index.ts` — entry point: register `/pets` commands,
  install widget on `session_start`, route Pi lifecycle events into `PetState`,
  clean up on `session_shutdown`.
- Create `extensions/pets/state/pet-state.ts` — `PetState` class with
  `running / waiting / review / failed / idle` plus linger timers.
- Create `extensions/pets/state/pet-state.test.ts` — event-driven transitions.
- Create `extensions/pets/config/settings.ts` — load/save `pets.json` under
  `getAgentDir()`, with default values and validation.
- Create `extensions/pets/config/settings.test.ts` — round-trip and defaults.
- Create `extensions/pets/catalog/catalog.ts` — built-in pet metadata
  (`default` only).
- Create `extensions/pets/catalog/catalog.test.ts` — built-in id lookup.
- Create `extensions/pets/catalog/default/pet.json` — frame geometry and
  animations for the bundled pet.
- Create `extensions/pets/catalog/default/spritesheet.png` — CC0 placeholder
  (PNG; jimp 1.x's bundled codecs do not write WebP).
- Create `extensions/pets/catalog/default/LICENSE` — CC0 dedication.
- Create `extensions/pets/catalog/default/fallback.ts` — tiny hard-coded ASCII
  art used when both spritesheet decode and block-art derivation fail.
- Create `extensions/pets/loader/pet-manifest.ts` — JSON schema (`PetManifest`)
  + parser for `pet.json`.
- Create `extensions/pets/loader/pet-manifest.test.ts` — parser tests including
  the `blockArt` field and animation defaults.
- Create `extensions/pets/loader/pet-loader.ts` — resolve a pet id (`default`
  or `<agentDir>/pets/<id>/pet.json`) into a normalized in-memory pet.
- Create `extensions/pets/loader/pet-loader.test.ts` — built-in fallback,
  user pet resolution, error reporting.
- Create `extensions/pets/loader/frames.ts` — slice spritesheet into per-frame
  PNG buffers using `jimp`; cache on disk under `getAgentDir()`.
- Create `extensions/pets/loader/frames.test.ts` — frame extraction from a
  synthetic spritesheet.
- Create `extensions/pets/render/capability.ts` — terminal/tmux capability
  detection (combines pi-tui `getCapabilities()` + env probing + `tmux`
  command).
- Create `extensions/pets/render/capability.test.ts` — full matrix.
- Create `extensions/pets/render/image-renderer.ts` — wraps pi-tui `Image`,
  applies tmux DCS passthrough wrapping when configured.
- Create `extensions/pets/render/image-renderer.test.ts` — image id reuse and
  passthrough wrapping.
- Create `extensions/pets/render/tmux-passthrough.ts` — pure function that
  wraps only Kitty graphics segments in `\ePtmux;...\e\\`.
- Create `extensions/pets/render/tmux-passthrough.test.ts` — escape-only
  wrapping; SGR untouched.
- Create `extensions/pets/render/block-art.ts` — half-block + truecolor
  renderer, with static-block-art shortcut.
- Create `extensions/pets/render/block-art.test.ts` — half-block output and
  static `blockArt` short-circuit.
- Create `extensions/pets/render/select-renderer.ts` — pure function that
  picks the renderer per the rendering strategy in the spec.
- Create `extensions/pets/render/select-renderer.test.ts` — exhaustive
  matrix (see spec).
- Create `extensions/pets/widget/pet-component.ts` — Pi `Component`
  implementation; owns animation tick and cache.
- Create `extensions/pets/widget/pet-component.test.ts` — tick scheduling,
  cache invalidation, state-driven re-render.
- Create `extensions/pets/widget/pet-widget.ts` — `setWidget` install/uninstall
  + bridge to `PetState`.
- Create `extensions/pets/widget/pet-widget.test.ts` — install on
  `session_start`, uninstall on `session_shutdown`.
- Create `extensions/pets/commands/pets-command.ts` — `/pets`, `/pets list`,
  `/pets set <id>`, `/pets on`, `/pets off`, `/pets diagnose`,
  `/pets tmux-passthrough on|off`.
- Create `extensions/pets/commands/pets-command.test.ts` — each subcommand.
- Create `extensions/pets/index.test.ts` — integration test using fake Pi APIs.
- Create `extensions/pets/README.md` — user-facing docs + manual verification
  matrix.
- Modify `package.json` (root) — add `jimp` to `dependencies`.
- Modify `README.md` (root) — list the new extension.

The root `package.json` already discovers `extensions/pets` via the existing
`pi.extensions: ["./extensions"]` glob, so the package manifest only needs to
ship `index.ts`.

---

## A note on TDD style in this plan

Each task follows the same pattern unless otherwise stated:

1. Write a failing test (paste the full test code).
2. Run it to confirm it fails with the expected error.
3. Add the minimum implementation to make the test pass (paste the full code).
4. Run the full suite (`npm test`) so we keep the package green.
5. Commit.

The plan never says "add tests for the above" or "implement similarly". Every
test and every implementation is shown verbatim.

---

### Task 0: Add `jimp` dependency

**Files:**
- Modify: `package.json` (root)

- [x] **Step 1: Install `jimp` as a runtime dependency**

Run:

```bash
npm install jimp@^1.6.1
```

Expected: `package.json` now contains `"jimp": "^1.6.1"` under
`dependencies` (jimp 1.x exposes the named `Jimp` constructor used elsewhere
in this plan; older 0.x has a different default-export API), and
`package-lock.json` is updated.

- [x] **Step 2: Verify the install did not break anything**

Run:

```bash
npm test
npm run typecheck
```

Expected: both commands exit 0 with the current test suite still passing.

- [x] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add jimp dependency for pets extension"
```

---

### Task 1: Extension package skeleton

**Files:**
- Create: `extensions/pets/package.json`
- Create: `extensions/pets/index.ts`
- Create: `extensions/pets/index.test.ts`

- [x] **Step 1: Write the failing entry-point test**

Create `extensions/pets/index.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import petsExtension from "./index.js";

function fakePi(): { on: any; registerCommand: any; registerTool?: any; appendEntry?: any } {
  return {
    on: vi.fn(),
    registerCommand: vi.fn(),
    registerTool: vi.fn(),
    appendEntry: vi.fn(),
  };
}

describe("pets extension entry point", () => {
  it("registers /pets commands and lifecycle handlers", async () => {
    const pi = fakePi();
    await petsExtension(pi as any);

    const commands = pi.registerCommand.mock.calls.map(([name]: [string]) => name);
    expect(commands).toContain("pets");

    const events = pi.on.mock.calls.map(([name]: [string]) => name);
    expect(events).toContain("session_start");
    expect(events).toContain("session_shutdown");
  });
});
```

- [x] **Step 2: Run the failing test**

Run:

```bash
npx vitest run extensions/pets/index.test.ts
```

Expected: FAIL. The file `extensions/pets/index.ts` does not exist yet.

- [x] **Step 3: Create the package manifest**

Create `extensions/pets/package.json`:

```json
{
  "name": "pets",
  "version": "0.1.0",
  "type": "module",
  "main": "index.ts",
  "pi": {
    "extensions": ["index.ts"]
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
    "typebox": "*"
  }
}
```

- [x] **Step 4: Create the minimal entry point**

Create `extensions/pets/index.ts`:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default async function petsExtension(pi: ExtensionAPI): Promise<void> {
  pi.registerCommand("pets", {
    description: "Configure the Codex-style terminal pet (stub).",
    handler: async () => {
      // Implemented in later tasks.
    },
  });

  pi.on("session_start", async () => {
    // Implemented in later tasks.
  });

  pi.on("session_shutdown", async () => {
    // Implemented in later tasks.
  });
}
```

- [x] **Step 5: Run the test to confirm it passes**

Run:

```bash
npx vitest run extensions/pets/index.test.ts
npm run typecheck
```

Expected: PASS, and `tsc --noEmit` reports no errors.

- [x] **Step 6: Commit**

```bash
git add extensions/pets/package.json extensions/pets/index.ts extensions/pets/index.test.ts
git commit -m "feat(pets): scaffold pets extension entry point"
```

---

### Task 2: Pet manifest schema and parser

**Files:**
- Create: `extensions/pets/loader/pet-manifest.ts`
- Create: `extensions/pets/loader/pet-manifest.test.ts`

- [x] **Step 1: Write the failing manifest parser tests**

Create `extensions/pets/loader/pet-manifest.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parsePetManifest } from "./pet-manifest.js";

describe("parsePetManifest", () => {
  it("parses a minimal manifest with defaults", () => {
    const manifest = parsePetManifest(
      JSON.stringify({
        id: "default",
        displayName: "Default",
        spritesheetPath: "spritesheet.webp",
        frame: { width: 192, height: 208, columns: 8, rows: 9 },
        animations: {
          idle: { frames: [0] },
        },
      }),
      "/abs/path/to/pet.json",
    );

    expect(manifest.id).toBe("default");
    expect(manifest.frame.width).toBe(192);
    expect(manifest.animations.idle).toEqual({
      frames: [0],
      fps: 4,
      loop: true,
      fallback: "idle",
    });
    expect(manifest.blockArt).toBeUndefined();
  });

  it("parses blockArt overrides", () => {
    const manifest = parsePetManifest(
      JSON.stringify({
        id: "x",
        displayName: "X",
        spritesheetPath: "s.png",
        frame: { width: 8, height: 8, columns: 1, rows: 1 },
        animations: { idle: { frames: [0] } },
        blockArt: { idle: ["a", "b"] },
      }),
      "/abs/path/to/pet.json",
    );

    expect(manifest.blockArt?.idle).toEqual(["a", "b"]);
  });

  it("rejects manifests with missing required fields", () => {
    expect(() => parsePetManifest("{}", "/p/pet.json")).toThrow(/id/);
  });

  it("rejects animations referencing out-of-range frames", () => {
    expect(() =>
      parsePetManifest(
        JSON.stringify({
          id: "x",
          displayName: "X",
          spritesheetPath: "s.png",
          frame: { width: 8, height: 8, columns: 1, rows: 1 },
          animations: { idle: { frames: [5] } },
        }),
        "/p/pet.json",
      ),
    ).toThrow(/frame index/);
  });
});
```

- [x] **Step 2: Run the failing test**

Run:

```bash
npx vitest run extensions/pets/loader/pet-manifest.test.ts
```

Expected: FAIL — `pet-manifest.ts` does not exist.

- [x] **Step 3: Implement the parser**

Create `extensions/pets/loader/pet-manifest.ts`:

```ts
export interface FrameGeometry {
  width: number;
  height: number;
  columns: number;
  rows: number;
}

export interface AnimationSpec {
  frames: number[];
  fps: number;
  loop: boolean;
  fallback: string;
}

export type PetStateName = "idle" | "running" | "waiting" | "review" | "failed";

export interface PetManifest {
  id: string;
  displayName: string;
  description: string;
  spritesheetPath: string;
  frame: FrameGeometry;
  animations: Record<PetStateName, AnimationSpec>;
  blockArt?: Partial<Record<PetStateName, string[]>>;
  /** Absolute path of the pet directory the manifest was loaded from. */
  manifestPath: string;
}

const STATES: PetStateName[] = ["idle", "running", "waiting", "review", "failed"];

export function parsePetManifest(jsonText: string, manifestPath: string): PetManifest {
  const raw = JSON.parse(jsonText) as Record<string, unknown>;
  requireString(raw, "id");
  requireString(raw, "displayName");
  requireString(raw, "spritesheetPath");

  const frame = requireFrame(raw.frame);
  const frameCount = frame.columns * frame.rows;
  if (frameCount <= 0) {
    throw new Error(`invalid frame geometry in ${manifestPath}: columns * rows must be > 0`);
  }

  const animations = requireAnimations(raw.animations, frameCount, manifestPath);
  const blockArt = parseBlockArt(raw.blockArt, manifestPath);

  return {
    id: String(raw.id),
    displayName: String(raw.displayName),
    description: typeof raw.description === "string" ? raw.description : "",
    spritesheetPath: String(raw.spritesheetPath),
    frame,
    animations,
    blockArt,
    manifestPath,
  };
}

function requireString(record: Record<string, unknown>, key: string): void {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`pet manifest field "${key}" must be a non-empty string`);
  }
}

function requireFrame(value: unknown): FrameGeometry {
  if (!value || typeof value !== "object") throw new Error(`pet manifest "frame" must be an object`);
  const frame = value as Record<string, unknown>;
  for (const key of ["width", "height", "columns", "rows"] as const) {
    const v = frame[key];
    if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
      throw new Error(`pet manifest "frame.${key}" must be a positive integer`);
    }
  }
  return {
    width: frame.width as number,
    height: frame.height as number,
    columns: frame.columns as number,
    rows: frame.rows as number,
  };
}

function requireAnimations(
  value: unknown,
  frameCount: number,
  manifestPath: string,
): Record<PetStateName, AnimationSpec> {
  if (!value || typeof value !== "object") {
    throw new Error(`pet manifest "animations" must be an object`);
  }
  const raw = value as Record<string, unknown>;
  if (!raw.idle) throw new Error(`pet manifest must define an "idle" animation`);

  const out: Partial<Record<PetStateName, AnimationSpec>> = {};
  for (const state of STATES) {
    const spec = raw[state];
    if (!spec) {
      out[state] = { frames: [0], fps: 4, loop: true, fallback: "idle" };
      continue;
    }
    out[state] = parseAnimationSpec(spec, frameCount, state, manifestPath);
  }
  return out as Record<PetStateName, AnimationSpec>;
}

function parseAnimationSpec(
  spec: unknown,
  frameCount: number,
  state: string,
  manifestPath: string,
): AnimationSpec {
  if (!spec || typeof spec !== "object") {
    throw new Error(`pet manifest animation "${state}" must be an object`);
  }
  const s = spec as Record<string, unknown>;
  if (!Array.isArray(s.frames) || s.frames.length === 0) {
    throw new Error(`pet manifest animation "${state}" must have at least one frame`);
  }
  const frames = s.frames.map((index) => {
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
      throw new Error(`pet manifest animation "${state}" frame index must be a non-negative integer`);
    }
    if (index >= frameCount) {
      throw new Error(`pet manifest animation "${state}" frame index ${index} out of range (max ${frameCount - 1}) in ${manifestPath}`);
    }
    return index;
  });
  const fps = typeof s.fps === "number" && s.fps > 0 ? s.fps : 4;
  const loop = typeof s.loop === "boolean" ? s.loop : true;
  const fallback = typeof s.fallback === "string" ? s.fallback : "idle";
  return { frames, fps, loop, fallback };
}

function parseBlockArt(
  value: unknown,
  manifestPath: string,
): Partial<Record<PetStateName, string[]>> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") {
    throw new Error(`pet manifest "blockArt" must be an object`);
  }
  const out: Partial<Record<PetStateName, string[]>> = {};
  for (const [state, lines] of Object.entries(value as Record<string, unknown>)) {
    if (!STATES.includes(state as PetStateName)) {
      throw new Error(`pet manifest blockArt key "${state}" is not a valid pet state in ${manifestPath}`);
    }
    if (!Array.isArray(lines) || lines.some((line) => typeof line !== "string")) {
      throw new Error(`pet manifest blockArt.${state} must be an array of strings`);
    }
    out[state as PetStateName] = lines as string[];
  }
  return out;
}
```

- [x] **Step 4: Run the test to confirm it passes**

Run:

```bash
npx vitest run extensions/pets/loader/pet-manifest.test.ts
npm run typecheck
```

Expected: PASS, no type errors.

- [x] **Step 5: Commit**

```bash
git add extensions/pets/loader/pet-manifest.ts extensions/pets/loader/pet-manifest.test.ts
git commit -m "feat(pets): parse pet manifest with state-keyed animations"
```

---

### Task 3: Pet catalog (built-in pet metadata)

**Files:**
- Create: `extensions/pets/catalog/catalog.ts`
- Create: `extensions/pets/catalog/catalog.test.ts`
- Create: `extensions/pets/catalog/default/pet.json`
- Create: `extensions/pets/catalog/default/LICENSE`
- Create: `extensions/pets/catalog/default/spritesheet.png` (placeholder file
  generated programmatically — see step 4 below)
- Create: `extensions/pets/catalog/default/fallback.ts`

- [x] **Step 1: Write the failing catalog test**

Create `extensions/pets/catalog/catalog.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { BUILTIN_PET_IDS, builtinPet } from "./catalog.js";

describe("pets catalog", () => {
  it("knows the bundled default pet", () => {
    expect(BUILTIN_PET_IDS).toEqual(["default"]);
    const entry = builtinPet("default");
    expect(entry).toBeDefined();
    expect(entry?.displayName).toBe("Default");
    expect(entry?.manifestRelPath).toBe("default/pet.json");
  });

  it("returns undefined for unknown ids", () => {
    expect(builtinPet("does-not-exist")).toBeUndefined();
  });
});
```

- [x] **Step 2: Run the failing test**

Run:

```bash
npx vitest run extensions/pets/catalog/catalog.test.ts
```

Expected: FAIL — `catalog.ts` not found.

- [x] **Step 3: Implement the catalog**

Create `extensions/pets/catalog/catalog.ts`:

```ts
export interface BuiltinPetEntry {
  id: string;
  displayName: string;
  description: string;
  /** Path to the pet directory's manifest, relative to this catalog folder. */
  manifestRelPath: string;
}

const BUILTIN_PETS: BuiltinPetEntry[] = [
  {
    id: "default",
    displayName: "Default",
    description: "A small CC0 pet bundled with the pets extension.",
    manifestRelPath: "default/pet.json",
  },
];

export const BUILTIN_PET_IDS = BUILTIN_PETS.map((pet) => pet.id);

export function builtinPet(id: string): BuiltinPetEntry | undefined {
  return BUILTIN_PETS.find((pet) => pet.id === id);
}

export function builtinPets(): readonly BuiltinPetEntry[] {
  return BUILTIN_PETS;
}
```

- [x] **Step 4: Create the bundled pet manifest, license, and placeholder
  spritesheet**

Create `extensions/pets/catalog/default/pet.json`:

```json
{
  "id": "default",
  "displayName": "Default",
  "description": "A small CC0 pet bundled with the pets extension.",
  "spritesheetPath": "spritesheet.png",
  "frame": { "width": 16, "height": 16, "columns": 4, "rows": 4 },
  "animations": {
    "idle":    { "frames": [0, 1, 2, 1], "fps": 4, "loop": true,  "fallback": "idle" },
    "running": { "frames": [4, 5, 6, 7], "fps": 8, "loop": true,  "fallback": "idle" },
    "waiting": { "frames": [8, 9], "fps": 2, "loop": true,  "fallback": "idle" },
    "review":  { "frames": [12, 13], "fps": 6, "loop": false, "fallback": "idle" },
    "failed":  { "frames": [14, 15], "fps": 4, "loop": true,  "fallback": "idle" }
  },
  "blockArt": {
    "idle":    ["  ▟█▙  ", "  ███  ", "  ▝▀▘  "],
    "running": ["  ▟█▙  ", "  ███  ", "  ↻↻↻  "],
    "waiting": ["  ▟█▙  ", "  ███  ", "  ???  "],
    "review":  ["  ▟█▙  ", "  ███  ", "  ✓✓✓  "],
    "failed":  ["  ▟█▙  ", "  ███  ", "  ✗✗✗  "]
  }
}
```

Create `extensions/pets/catalog/default/LICENSE`:

```text
This pet artwork and manifest are dedicated to the public domain under
CC0 1.0 Universal (https://creativecommons.org/publicdomain/zero/1.0/).

To the extent possible under law, the authors have waived all copyright
and related or neighboring rights to this work. The work is published from
the United States.
```

Generate a tiny placeholder spritesheet so manifest validation can succeed
even without external assets. Run (one-shot generator script):

```bash
node --input-type=module -e "
import { mkdirSync, writeFileSync } from 'node:fs';
import { Jimp } from 'jimp';

const cols = 4, rows = 4, frameW = 16, frameH = 16;
const image = new Jimp({ width: cols * frameW, height: rows * frameH, color: 0x00000000 });

const palette = [
  0xff5050ff, 0xff7070ff, 0xff9090ff, 0xffb0b0ff,
  0x50ff50ff, 0x70ff70ff, 0x90ff90ff, 0xb0ffb0ff,
  0x5050ffff, 0x7070ffff, 0x9090ffff, 0xb0b0ffff,
  0xffff50ff, 0xffff70ff, 0xff9090ff, 0xff70b0ff,
];

for (let r = 0; r < rows; r++) {
  for (let c = 0; c < cols; c++) {
    const idx = r * cols + c;
    const color = palette[idx];
    for (let y = 0; y < frameH; y++) {
      for (let x = 0; x < frameW; x++) {
        const inside = x > 2 && x < frameW - 3 && y > 2 && y < frameH - 3;
        image.setPixelColor(inside ? color : 0x00000000, c * frameW + x, r * frameH + y);
      }
    }
  }
}

mkdirSync('extensions/pets/catalog/default', { recursive: true });
writeFileSync('extensions/pets/catalog/default/spritesheet.png', await image.getBuffer('image/png'));
console.log('wrote extensions/pets/catalog/default/spritesheet.png');
"
```

Expected: prints `wrote extensions/pets/catalog/default/spritesheet.png` and
the file exists with non-zero size.

Create `extensions/pets/catalog/default/fallback.ts`:

```ts
import type { PetStateName } from "../../loader/pet-manifest.js";

export const FALLBACK_ASCII: Record<PetStateName, string[]> = {
  idle:    ["  /\\_/\\", "  (o.o)", "  ( - )"],
  running: ["  /\\_/\\", "  (^.^)", "  ( ~ )"],
  waiting: ["  /\\_/\\", "  (o.O)", "  ( ? )"],
  review:  ["  /\\_/\\", "  (^_^)", "  ( v )"],
  failed:  ["  /\\_/\\", "  (x.x)", "  ( ! )"],
};
```

- [x] **Step 5: Run the test to confirm it passes**

Run:

```bash
npx vitest run extensions/pets/catalog/catalog.test.ts
npm run typecheck
```

Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add extensions/pets/catalog
git commit -m "feat(pets): bundle a CC0 default pet with placeholder spritesheet"
```

---

### Task 4: Pet loader

**Files:**
- Create: `extensions/pets/loader/pet-loader.ts`
- Create: `extensions/pets/loader/pet-loader.test.ts`

- [x] **Step 1: Write the failing loader test**

Create `extensions/pets/loader/pet-loader.test.ts`:

```ts
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadPet } from "./pet-loader.js";

function writeTmpPet(id: string, manifest: object): { agentDir: string } {
  const agentDir = mkdtempSync(join(tmpdir(), "pets-loader-"));
  const petDir = join(agentDir, "pets", id);
  mkdirSync(petDir, { recursive: true });
  writeFileSync(join(petDir, "pet.json"), JSON.stringify(manifest));
  return { agentDir };
}

describe("loadPet", () => {
  it("loads the bundled default pet", () => {
    const result = loadPet("default", { agentDir: "/nonexistent" });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.pet.id).toBe("default");
      expect(result.pet.spritesheetAbsPath).toMatch(/spritesheet\.webp$/);
    }
  });

  it("loads a user-installed pet from <agentDir>/pets/<id>/pet.json", () => {
    const { agentDir } = writeTmpPet("cat", {
      id: "cat",
      displayName: "Cat",
      spritesheetPath: "sprite.png",
      frame: { width: 8, height: 8, columns: 1, rows: 1 },
      animations: { idle: { frames: [0] } },
    });
    writeFileSync(join(agentDir, "pets", "cat", "sprite.png"), Buffer.alloc(0));

    const result = loadPet("cat", { agentDir });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.pet.id).toBe("cat");
      expect(result.pet.spritesheetAbsPath.endsWith("sprite.png")).toBe(true);
    }
  });

  it("falls back to default with a reason when the id is unknown", () => {
    const result = loadPet("does-not-exist", { agentDir: "/nonexistent" });
    expect(result.kind).toBe("fallback");
    if (result.kind === "fallback") {
      expect(result.pet.id).toBe("default");
      expect(result.reason).toMatch(/does-not-exist/);
    }
  });

  it("falls back to default when the user manifest fails to parse", () => {
    const { agentDir } = writeTmpPet("broken", {});
    const result = loadPet("broken", { agentDir });
    expect(result.kind).toBe("fallback");
    if (result.kind === "fallback") {
      expect(result.pet.id).toBe("default");
      expect(result.reason).toMatch(/broken/);
    }
  });
});
```

- [x] **Step 2: Run the failing test**

Run:

```bash
npx vitest run extensions/pets/loader/pet-loader.test.ts
```

Expected: FAIL — `pet-loader.ts` does not exist.

- [x] **Step 3: Implement the loader**

Create `extensions/pets/loader/pet-loader.ts`:

```ts
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { builtinPet } from "../catalog/catalog.js";
import { type PetManifest, parsePetManifest } from "./pet-manifest.js";

const CATALOG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "catalog");

export interface LoadedPet {
  manifest: PetManifest;
  /** Absolute path to the spritesheet image on disk. */
  spritesheetAbsPath: string;
  id: string;
}

export interface LoadOptions {
  agentDir: string;
}

export type LoadResult =
  | { kind: "ok"; pet: LoadedPet }
  | { kind: "fallback"; pet: LoadedPet; reason: string };

export function loadPet(id: string, options: LoadOptions): LoadResult {
  try {
    const pet = resolvePet(id, options);
    return { kind: "ok", pet };
  } catch (error) {
    if (id === "default") {
      throw error;
    }
    const reason = `failed to load pet "${id}": ${error instanceof Error ? error.message : String(error)}`;
    const fallback = resolvePet("default", options);
    return { kind: "fallback", pet: fallback, reason };
  }
}

function resolvePet(id: string, options: LoadOptions): LoadedPet {
  const builtin = builtinPet(id);
  if (builtin) {
    const manifestPath = join(CATALOG_DIR, builtin.manifestRelPath);
    return parseAndAttach(manifestPath);
  }

  const userManifestPath = join(options.agentDir, "pets", id, "pet.json");
  if (!existsSync(userManifestPath)) {
    throw new Error(`pet "${id}" not found in agent dir`);
  }
  return parseAndAttach(userManifestPath);
}

function parseAndAttach(manifestPath: string): LoadedPet {
  const text = readFileSync(manifestPath, "utf8");
  const manifest = parsePetManifest(text, manifestPath);
  const spritesheetAbsPath = resolve(dirname(manifestPath), manifest.spritesheetPath);
  if (!existsSync(spritesheetAbsPath)) {
    throw new Error(`spritesheet missing at ${spritesheetAbsPath}`);
  }
  return {
    id: manifest.id,
    manifest,
    spritesheetAbsPath,
  };
}
```

- [x] **Step 4: Run the test to confirm it passes**

Run:

```bash
npx vitest run extensions/pets/loader/pet-loader.test.ts
npm run typecheck
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add extensions/pets/loader/pet-loader.ts extensions/pets/loader/pet-loader.test.ts
git commit -m "feat(pets): resolve pet id to manifest + spritesheet"
```

---

### Task 5: Frame extraction from spritesheet

**Files:**
- Create: `extensions/pets/loader/frames.ts`
- Create: `extensions/pets/loader/frames.test.ts`

- [x] **Step 1: Write the failing frame-extraction test**

Create `extensions/pets/loader/frames.test.ts`:

```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Jimp } from "jimp";
import type { LoadedPet } from "./pet-loader.js";
import { extractFrames } from "./frames.js";

async function writeSpritesheet(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "pets-frames-"));
  const image = new Jimp({ width: 4, height: 2, color: 0x00000000 });
  image.setPixelColor(0xff0000ff, 0, 0);
  image.setPixelColor(0x00ff00ff, 2, 0);
  image.setPixelColor(0x0000ffff, 0, 1);
  image.setPixelColor(0xffffffff, 2, 1);
  const path = join(dir, "s.png");
  writeFileSync(path, await image.getBuffer("image/png"));
  return path;
}

describe("extractFrames", () => {
  it("splits a spritesheet into per-frame RGBA buffers using manifest geometry", async () => {
    const path = await writeSpritesheet();
    const pet: LoadedPet = {
      id: "x",
      spritesheetAbsPath: path,
      manifest: {
        id: "x",
        displayName: "X",
        description: "",
        spritesheetPath: "s.png",
        frame: { width: 2, height: 1, columns: 2, rows: 2 },
        animations: { idle: { frames: [0], fps: 4, loop: true, fallback: "idle" } } as any,
        manifestPath: join(path, "..", "pet.json"),
      },
    };

    const frames = await extractFrames(pet);
    expect(frames.length).toBe(4);
    expect(frames[0].width).toBe(2);
    expect(frames[0].height).toBe(1);
    // Frame 0: top-left two pixels of the spritesheet.
    expect(frames[0].rgba[0]).toBe(0xff); // R of (0,0)
    expect(frames[0].rgba[1]).toBe(0x00); // G of (0,0)
    expect(frames[0].rgba[2]).toBe(0x00); // B of (0,0)
    // Frame 1: pixels (2,0) and (3,0).
    expect(frames[1].rgba[0]).toBe(0x00);
    expect(frames[1].rgba[1]).toBe(0xff);
  });
});
```

- [x] **Step 2: Run the failing test**

Run:

```bash
npx vitest run extensions/pets/loader/frames.test.ts
```

Expected: FAIL — `frames.ts` does not exist.

- [x] **Step 3: Implement frame extraction**

Create `extensions/pets/loader/frames.ts`:

```ts
import { readFile } from "node:fs/promises";
import { Jimp } from "jimp";
import type { LoadedPet } from "./pet-loader.js";

export interface RgbaFrame {
  width: number;
  height: number;
  /** Length = width * height * 4. Order: R, G, B, A. */
  rgba: Uint8ClampedArray;
}

export async function extractFrames(pet: LoadedPet): Promise<RgbaFrame[]> {
  const buffer = await readFile(pet.spritesheetAbsPath);
  const image = await Jimp.read(buffer);

  const { frame } = pet.manifest;
  const totalFrames = frame.columns * frame.rows;
  const frames: RgbaFrame[] = [];

  for (let index = 0; index < totalFrames; index++) {
    const column = index % frame.columns;
    const row = Math.floor(index / frame.columns);
    const subImage = image.clone().crop({
      x: column * frame.width,
      y: row * frame.height,
      w: frame.width,
      h: frame.height,
    });
    const rgba = new Uint8ClampedArray(subImage.bitmap.data.buffer.slice(
      subImage.bitmap.data.byteOffset,
      subImage.bitmap.data.byteOffset + subImage.bitmap.data.byteLength,
    ));
    frames.push({ width: frame.width, height: frame.height, rgba });
  }

  return frames;
}
```

- [x] **Step 4: Run the test to confirm it passes**

Run:

```bash
npx vitest run extensions/pets/loader/frames.test.ts
npm run typecheck
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add extensions/pets/loader/frames.ts extensions/pets/loader/frames.test.ts
git commit -m "feat(pets): extract per-frame RGBA buffers from spritesheet"
```

---

### Task 6: Capability detection

**Files:**
- Create: `extensions/pets/render/capability.ts`
- Create: `extensions/pets/render/capability.test.ts`

- [x] **Step 1: Write the failing capability tests**

Create `extensions/pets/render/capability.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { detectPetCapability } from "./capability.js";

const NO_TMUX_ENV = { TERM: "xterm-kitty" };

describe("detectPetCapability", () => {
  it("returns no-image when getCapabilities reports null", async () => {
    const caps = await detectPetCapability({
      env: { TERM: "xterm-256color" },
      getCapabilities: () => ({ images: null, trueColor: true, hyperlinks: false }),
      execTmux: async () => ({ ok: false, stdout: "", stderr: "" }),
    });
    expect(caps.images).toBeNull();
    expect(caps.inTmux).toBe(false);
  });

  it("reports kitty support outside tmux", async () => {
    const caps = await detectPetCapability({
      env: NO_TMUX_ENV,
      getCapabilities: () => ({ images: "kitty", trueColor: true, hyperlinks: true }),
      execTmux: async () => ({ ok: false, stdout: "", stderr: "" }),
    });
    expect(caps.images).toBe("kitty");
    expect(caps.inTmux).toBe(false);
  });

  it("detects tmux from env and probes allow-passthrough", async () => {
    const calls: string[][] = [];
    const caps = await detectPetCapability({
      env: { TMUX: "/tmp/tmux", TMUX_PANE: "%0", TERM: "xterm-kitty" },
      getCapabilities: () => ({ images: "kitty", trueColor: true, hyperlinks: false }),
      execTmux: async (args) => {
        calls.push(args);
        if (args[0] === "-V") return { ok: true, stdout: "tmux 3.4\n", stderr: "" };
        if (args[0] === "show") return { ok: true, stdout: "on\n", stderr: "" };
        return { ok: false, stdout: "", stderr: "" };
      },
    });
    expect(caps.inTmux).toBe(true);
    expect(caps.tmuxVersion).toBe("3.4");
    expect(caps.tmuxPassthroughEnabled).toBe(true);
    expect(calls).toContainEqual(["-V"]);
    expect(calls).toContainEqual(["show", "-gv", "allow-passthrough"]);
  });

  it("treats tmux probe failure as passthrough unknown", async () => {
    const caps = await detectPetCapability({
      env: { TMUX: "/tmp/tmux" },
      getCapabilities: () => ({ images: "kitty", trueColor: true, hyperlinks: false }),
      execTmux: async () => {
        throw new Error("tmux not installed");
      },
    });
    expect(caps.inTmux).toBe(true);
    expect(caps.tmuxPassthroughEnabled).toBeUndefined();
    expect(caps.tmuxVersion).toBeUndefined();
  });
});
```

- [x] **Step 2: Run the failing test**

Run:

```bash
npx vitest run extensions/pets/render/capability.test.ts
```

Expected: FAIL — `capability.ts` does not exist.

- [x] **Step 3: Implement capability detection**

Create `extensions/pets/render/capability.ts`:

```ts
import { getCapabilities, type ImageProtocol, type TerminalCapabilities } from "@earendil-works/pi-tui";

export interface PetCapability {
  images: ImageProtocol;
  trueColor: boolean;
  inTmux: boolean;
  tmuxVersion?: string;
  tmuxPassthroughEnabled?: boolean;
  reason: string;
}

export interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export interface DetectOptions {
  env: NodeJS.ProcessEnv;
  getCapabilities?: () => TerminalCapabilities;
  execTmux: (args: string[]) => Promise<ExecResult>;
}

export async function detectPetCapability(options: DetectOptions): Promise<PetCapability> {
  const tuiCaps = (options.getCapabilities ?? getCapabilities)();
  const inTmux = Boolean(options.env.TMUX || options.env.TMUX_PANE);

  if (!inTmux) {
    return {
      images: tuiCaps.images,
      trueColor: tuiCaps.trueColor,
      inTmux: false,
      reason: tuiCaps.images ? `terminal supports ${tuiCaps.images} graphics` : "terminal has no image protocol",
    };
  }

  let tmuxVersion: string | undefined;
  let tmuxPassthroughEnabled: boolean | undefined;
  try {
    const versionResult = await options.execTmux(["-V"]);
    if (versionResult.ok) {
      const match = versionResult.stdout.trim().match(/tmux\s+(\S+)/);
      if (match) tmuxVersion = match[1];
    }
    const passthroughResult = await options.execTmux(["show", "-gv", "allow-passthrough"]);
    if (passthroughResult.ok) {
      tmuxPassthroughEnabled = passthroughResult.stdout.trim() === "on";
    }
  } catch {
    // Probe failure leaves both values undefined.
  }

  return {
    images: tuiCaps.images,
    trueColor: tuiCaps.trueColor,
    inTmux: true,
    tmuxVersion,
    tmuxPassthroughEnabled,
    reason: `tmux detected; allow-passthrough=${tmuxPassthroughEnabled ?? "unknown"}`,
  };
}
```

- [x] **Step 4: Run the test to confirm it passes**

Run:

```bash
npx vitest run extensions/pets/render/capability.test.ts
npm run typecheck
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add extensions/pets/render/capability.ts extensions/pets/render/capability.test.ts
git commit -m "feat(pets): detect terminal + tmux capability for renderer pick"
```

---

### Task 7: tmux DCS passthrough wrapper

**Files:**
- Create: `extensions/pets/render/tmux-passthrough.ts`
- Create: `extensions/pets/render/tmux-passthrough.test.ts`

- [x] **Step 1: Write the failing passthrough test**

Create `extensions/pets/render/tmux-passthrough.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { wrapKittyEscapesForTmux } from "./tmux-passthrough.js";

const ESC = "\x1b";
const ST = "\x1b\\";

describe("wrapKittyEscapesForTmux", () => {
  it("wraps a Kitty graphics segment in tmux DCS passthrough", () => {
    const line = `${ESC}_Ga=T,f=100,c=4,r=2;ABCD${ST}`;
    const wrapped = wrapKittyEscapesForTmux(line);
    expect(wrapped.startsWith(`${ESC}Ptmux;`)).toBe(true);
    expect(wrapped.endsWith(ST)).toBe(true);
    expect(wrapped).toContain("\x1b\x1b_Ga=T");
    expect(wrapped).toContain("ABCD");
  });

  it("leaves non-Kitty escapes untouched", () => {
    const line = `${ESC}[31mred${ESC}[0m`;
    expect(wrapKittyEscapesForTmux(line)).toBe(line);
  });

  it("wraps every Kitty segment in a mixed line", () => {
    const line = `${ESC}_Gx${ST}plain${ESC}_Gy${ST}`;
    const wrapped = wrapKittyEscapesForTmux(line);
    const matches = wrapped.match(new RegExp(`${ESC.replace(/\\/g, "\\\\")}Ptmux;`, "g"));
    expect(matches?.length).toBe(2);
  });
});
```

- [x] **Step 2: Run the failing test**

Run:

```bash
npx vitest run extensions/pets/render/tmux-passthrough.test.ts
```

Expected: FAIL.

- [x] **Step 3: Implement the wrapper**

Create `extensions/pets/render/tmux-passthrough.ts`:

```ts
const KITTY_SEGMENT = /\x1b_G[^\x1b]*\x1b\\/g;

export function wrapKittyEscapesForTmux(line: string): string {
  return line.replace(KITTY_SEGMENT, (segment) => {
    const escaped = segment.replace(/\x1b/g, "\x1b\x1b");
    return `\x1bPtmux;${escaped}\x1b\\`;
  });
}

export function wrapKittyEscapesInLines(lines: string[]): string[] {
  return lines.map(wrapKittyEscapesForTmux);
}
```

- [x] **Step 4: Run the test to confirm it passes**

Run:

```bash
npx vitest run extensions/pets/render/tmux-passthrough.test.ts
npm run typecheck
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add extensions/pets/render/tmux-passthrough.ts extensions/pets/render/tmux-passthrough.test.ts
git commit -m "feat(pets): wrap Kitty graphics escapes in tmux DCS passthrough"
```

---

### Task 8: Block-art renderer

**Files:**
- Create: `extensions/pets/render/block-art.ts`
- Create: `extensions/pets/render/block-art.test.ts`

- [x] **Step 1: Write the failing block-art tests**

Create `extensions/pets/render/block-art.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { renderBlockArt } from "./block-art.js";
import type { RgbaFrame } from "../loader/frames.js";

function frame(width: number, height: number, pixels: number[]): RgbaFrame {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < pixels.length; i++) {
    const offset = i * 4;
    const color = pixels[i];
    rgba[offset + 0] = (color >>> 24) & 0xff;
    rgba[offset + 1] = (color >>> 16) & 0xff;
    rgba[offset + 2] = (color >>> 8) & 0xff;
    rgba[offset + 3] = color & 0xff;
  }
  return { width, height, rgba };
}

describe("renderBlockArt", () => {
  it("returns static blockArt when present, ignoring the spritesheet", () => {
    const lines = renderBlockArt({
      state: "idle",
      animationFrame: frame(2, 2, [0xff0000ff, 0x00ff00ff, 0x0000ffff, 0xffffffff]),
      blockArt: { idle: ["custom", "lines"] },
      trueColor: true,
    });
    expect(lines).toEqual(["custom", "lines"]);
  });

  it("derives half-block lines from RGBA pixels", () => {
    const lines = renderBlockArt({
      state: "idle",
      animationFrame: frame(2, 2, [0xff0000ff, 0x00ff00ff, 0x0000ffff, 0xffffffff]),
      blockArt: undefined,
      trueColor: true,
    });
    // 2 pixels wide → 2 cells; 2 pixels tall → 1 row of half-blocks.
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("\u2580"); // ▀
    expect(lines[0]).toContain("\x1b[38;2;255;0;0m");
    expect(lines[0]).toContain("\x1b[48;2;0;0;255m");
  });

  it("emits blanks for fully transparent cells", () => {
    const lines = renderBlockArt({
      state: "idle",
      animationFrame: frame(2, 2, [0, 0, 0, 0]),
      blockArt: undefined,
      trueColor: true,
    });
    expect(lines[0]).toBe("  ");
  });
});
```

- [x] **Step 2: Run the failing test**

Run:

```bash
npx vitest run extensions/pets/render/block-art.test.ts
```

Expected: FAIL.

- [x] **Step 3: Implement the block-art renderer**

Create `extensions/pets/render/block-art.ts`:

```ts
import type { RgbaFrame } from "../loader/frames.js";
import type { PetStateName } from "../loader/pet-manifest.js";

const HALF_BLOCK = "\u2580"; // ▀
const ALPHA_VISIBLE_MIN = 32;

export interface RenderBlockArtInput {
  state: PetStateName;
  animationFrame: RgbaFrame;
  blockArt: Partial<Record<PetStateName, string[]>> | undefined;
  trueColor: boolean;
}

export function renderBlockArt(input: RenderBlockArtInput): string[] {
  const staticLines = input.blockArt?.[input.state];
  if (staticLines && staticLines.length > 0) {
    return staticLines.slice();
  }
  return derivePixelLines(input.animationFrame, input.trueColor);
}

function derivePixelLines(frame: RgbaFrame, trueColor: boolean): string[] {
  const lines: string[] = [];
  for (let y = 0; y < frame.height; y += 2) {
    let line = "";
    for (let x = 0; x < frame.width; x++) {
      const top = pixelAt(frame, x, y);
      const bottom = y + 1 < frame.height ? pixelAt(frame, x, y + 1) : transparent();
      line += renderCell(top, bottom, trueColor);
    }
    lines.push(line);
  }
  return lines;
}

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

function pixelAt(frame: RgbaFrame, x: number, y: number): Rgba {
  const offset = (y * frame.width + x) * 4;
  return {
    r: frame.rgba[offset + 0],
    g: frame.rgba[offset + 1],
    b: frame.rgba[offset + 2],
    a: frame.rgba[offset + 3],
  };
}

function transparent(): Rgba {
  return { r: 0, g: 0, b: 0, a: 0 };
}

function renderCell(top: Rgba, bottom: Rgba, trueColor: boolean): string {
  const topVisible = top.a >= ALPHA_VISIBLE_MIN;
  const bottomVisible = bottom.a >= ALPHA_VISIBLE_MIN;
  if (!topVisible && !bottomVisible) return " ";

  if (trueColor) {
    const fg = topVisible ? `\x1b[38;2;${top.r};${top.g};${top.b}m` : "\x1b[39m";
    const bg = bottomVisible ? `\x1b[48;2;${bottom.r};${bottom.g};${bottom.b}m` : "\x1b[49m";
    return `${fg}${bg}${HALF_BLOCK}\x1b[0m`;
  }

  // Indexed 256-color fallback: nearest 6×6×6 cube color.
  const fg = topVisible ? `\x1b[38;5;${nearest256(top)}m` : "\x1b[39m";
  const bg = bottomVisible ? `\x1b[48;5;${nearest256(bottom)}m` : "\x1b[49m";
  return `${fg}${bg}${HALF_BLOCK}\x1b[0m`;
}

function nearest256(color: Rgba): number {
  const r = Math.round((color.r / 255) * 5);
  const g = Math.round((color.g / 255) * 5);
  const b = Math.round((color.b / 255) * 5);
  return 16 + 36 * r + 6 * g + b;
}
```

- [x] **Step 4: Run the test to confirm it passes**

Run:

```bash
npx vitest run extensions/pets/render/block-art.test.ts
npm run typecheck
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add extensions/pets/render/block-art.ts extensions/pets/render/block-art.test.ts
git commit -m "feat(pets): half-block + truecolor block-art renderer"
```

---

### Task 9: Renderer selection strategy

**Files:**
- Create: `extensions/pets/render/select-renderer.ts`
- Create: `extensions/pets/render/select-renderer.test.ts`

- [x] **Step 1: Write the failing strategy test**

Create `extensions/pets/render/select-renderer.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { selectRenderer } from "./select-renderer.js";

const baseSettings = { enabled: true, renderMode: "auto" as const, tmuxPassthrough: false };

describe("selectRenderer", () => {
  it("returns 'disabled' when settings.enabled is false", () => {
    const choice = selectRenderer({ settings: { ...baseSettings, enabled: false }, capability: { images: "kitty", trueColor: true, inTmux: false, reason: "" } });
    expect(choice).toEqual({ kind: "disabled" });
  });

  it("forces image when renderMode='image'", () => {
    const choice = selectRenderer({ settings: { ...baseSettings, renderMode: "image" }, capability: { images: "kitty", trueColor: true, inTmux: true, reason: "" } });
    expect(choice).toEqual({ kind: "image", wrapForTmux: false });
  });

  it("forces block-art when renderMode='block-art'", () => {
    const choice = selectRenderer({ settings: { ...baseSettings, renderMode: "block-art" }, capability: { images: "kitty", trueColor: true, inTmux: false, reason: "" } });
    expect(choice).toEqual({ kind: "block-art" });
  });

  it("auto: kitty outside tmux → image, no wrap", () => {
    const choice = selectRenderer({ settings: baseSettings, capability: { images: "kitty", trueColor: true, inTmux: false, reason: "" } });
    expect(choice).toEqual({ kind: "image", wrapForTmux: false });
  });

  it("auto: kitty in tmux + opt-in + passthrough on → image w/ wrap", () => {
    const choice = selectRenderer({
      settings: { ...baseSettings, tmuxPassthrough: true },
      capability: { images: "kitty", trueColor: true, inTmux: true, tmuxPassthroughEnabled: true, reason: "" },
    });
    expect(choice).toEqual({ kind: "image", wrapForTmux: true });
  });

  it("auto: kitty in tmux without opt-in → block-art", () => {
    const choice = selectRenderer({
      settings: baseSettings,
      capability: { images: "kitty", trueColor: true, inTmux: true, tmuxPassthroughEnabled: true, reason: "" },
    });
    expect(choice).toEqual({ kind: "block-art" });
  });

  it("auto: kitty in tmux with opt-in but passthrough off → block-art", () => {
    const choice = selectRenderer({
      settings: { ...baseSettings, tmuxPassthrough: true },
      capability: { images: "kitty", trueColor: true, inTmux: true, tmuxPassthroughEnabled: false, reason: "" },
    });
    expect(choice).toEqual({ kind: "block-art" });
  });

  it("auto: iterm2 outside tmux → image, no wrap", () => {
    const choice = selectRenderer({
      settings: baseSettings,
      capability: { images: "iterm2", trueColor: true, inTmux: false, reason: "" },
    });
    expect(choice).toEqual({ kind: "image", wrapForTmux: false });
  });

  it("auto: iterm2 in tmux → block-art (no opt-in path)", () => {
    const choice = selectRenderer({
      settings: { ...baseSettings, tmuxPassthrough: true },
      capability: { images: "iterm2", trueColor: true, inTmux: true, tmuxPassthroughEnabled: true, reason: "" },
    });
    expect(choice).toEqual({ kind: "block-art" });
  });

  it("auto: no image protocol → block-art", () => {
    const choice = selectRenderer({
      settings: baseSettings,
      capability: { images: null, trueColor: true, inTmux: false, reason: "" },
    });
    expect(choice).toEqual({ kind: "block-art" });
  });
});
```

- [x] **Step 2: Run the failing test**

Run:

```bash
npx vitest run extensions/pets/render/select-renderer.test.ts
```

Expected: FAIL.

- [x] **Step 3: Implement the strategy**

Create `extensions/pets/render/select-renderer.ts`:

```ts
import type { PetCapability } from "./capability.js";

export interface PetSettingsForSelect {
  enabled: boolean;
  renderMode: "auto" | "image" | "block-art";
  tmuxPassthrough: boolean;
}

export type RendererChoice =
  | { kind: "disabled" }
  | { kind: "image"; wrapForTmux: boolean }
  | { kind: "block-art" };

export function selectRenderer(input: {
  settings: PetSettingsForSelect;
  capability: PetCapability;
}): RendererChoice {
  const { settings, capability } = input;

  if (!settings.enabled) return { kind: "disabled" };
  if (settings.renderMode === "image") return { kind: "image", wrapForTmux: false };
  if (settings.renderMode === "block-art") return { kind: "block-art" };

  // renderMode === "auto"
  if (capability.images === "kitty") {
    if (!capability.inTmux) return { kind: "image", wrapForTmux: false };
    if (settings.tmuxPassthrough && capability.tmuxPassthroughEnabled === true) {
      return { kind: "image", wrapForTmux: true };
    }
    return { kind: "block-art" };
  }

  if (capability.images === "iterm2" && !capability.inTmux) {
    return { kind: "image", wrapForTmux: false };
  }

  return { kind: "block-art" };
}
```

- [x] **Step 4: Run the test to confirm it passes**

Run:

```bash
npx vitest run extensions/pets/render/select-renderer.test.ts
npm run typecheck
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add extensions/pets/render/select-renderer.ts extensions/pets/render/select-renderer.test.ts
git commit -m "feat(pets): deterministic renderer-selection strategy"
```

---

### Task 10: Pi-TUI Image wrapper renderer

**Files:**
- Create: `extensions/pets/render/image-renderer.ts`
- Create: `extensions/pets/render/image-renderer.test.ts`

- [x] **Step 1: Write the failing image-renderer tests**

Create `extensions/pets/render/image-renderer.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createImageRenderer } from "./image-renderer.js";

class FakeImage {
  static instances: FakeImage[] = [];
  constructor(public readonly base64: string, public readonly mime: string, _theme: unknown, public readonly options: { imageId?: number }) {
    FakeImage.instances.push(this);
  }
  invalidate = vi.fn();
  render(_width: number): string[] {
    return [`\x1b_Ga=T,id=${this.options.imageId ?? "?"};${this.base64.slice(0, 4)}\x1b\\`];
  }
}

describe("createImageRenderer", () => {
  it("reuses the same Image instance for repeated frames with the same key", () => {
    FakeImage.instances = [];
    const renderer = createImageRenderer({
      ImageCtor: FakeImage as any,
      theme: { fallbackColor: (s: string) => s },
      wrapForTmux: false,
    });
    const frame = { base64: "AAAA", mime: "image/png", frameKey: "k1" };
    renderer.render(frame, 40);
    renderer.render(frame, 40);
    expect(FakeImage.instances.length).toBe(1);
  });

  it("wraps Kitty graphics output when wrapForTmux is true", () => {
    FakeImage.instances = [];
    const renderer = createImageRenderer({
      ImageCtor: FakeImage as any,
      theme: { fallbackColor: (s: string) => s },
      wrapForTmux: true,
    });
    const out = renderer.render({ base64: "ZZZZ", mime: "image/png", frameKey: "k" }, 40);
    expect(out[0]).toContain("\x1bPtmux;");
  });

  it("invalidates cached Image components", () => {
    FakeImage.instances = [];
    const renderer = createImageRenderer({
      ImageCtor: FakeImage as any,
      theme: { fallbackColor: (s: string) => s },
      wrapForTmux: false,
    });
    renderer.render({ base64: "A", mime: "image/png", frameKey: "k" }, 40);
    renderer.invalidate();
    expect(FakeImage.instances[0].invalidate).toHaveBeenCalled();
  });
});
```

- [x] **Step 2: Run the failing test**

Run:

```bash
npx vitest run extensions/pets/render/image-renderer.test.ts
```

Expected: FAIL.

- [x] **Step 3: Implement the renderer**

Create `extensions/pets/render/image-renderer.ts`:

```ts
import { Image as PiImage, type ImageTheme } from "@earendil-works/pi-tui";
import { wrapKittyEscapesInLines } from "./tmux-passthrough.js";

export interface FrameImageInput {
  /** Cache key. Reuse means reuse the underlying Image instance + image id. */
  frameKey: string;
  base64: string;
  mime: "image/png" | "image/webp" | "image/jpeg" | "image/gif";
}

export interface ImageRenderer {
  render(input: FrameImageInput, width: number): string[];
  invalidate(): void;
}

export interface ImageRendererOptions {
  ImageCtor?: typeof PiImage;
  theme: ImageTheme;
  wrapForTmux: boolean;
  maxWidthCells?: number;
  maxHeightCells?: number;
}

export function createImageRenderer(options: ImageRendererOptions): ImageRenderer {
  const ImageCtor = options.ImageCtor ?? PiImage;
  const cache = new Map<string, InstanceType<typeof PiImage>>();

  return {
    render(input, width) {
      let image = cache.get(input.frameKey);
      if (!image) {
        image = new ImageCtor(input.base64, input.mime, options.theme, {
          maxWidthCells: options.maxWidthCells ?? 12,
          maxHeightCells: options.maxHeightCells ?? 6,
        });
        cache.set(input.frameKey, image);
      }
      const lines = image.render(width);
      return options.wrapForTmux ? wrapKittyEscapesInLines(lines) : lines;
    },
    invalidate() {
      for (const image of cache.values()) image.invalidate();
    },
  };
}
```

- [x] **Step 4: Run the test to confirm it passes**

Run:

```bash
npx vitest run extensions/pets/render/image-renderer.test.ts
npm run typecheck
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add extensions/pets/render/image-renderer.ts extensions/pets/render/image-renderer.test.ts
git commit -m "feat(pets): pi-tui Image wrapper with frame cache + tmux wrap"
```

---

### Task 11: Pet state machine

**Files:**
- Create: `extensions/pets/state/pet-state.ts`
- Create: `extensions/pets/state/pet-state.test.ts`

- [x] **Step 1: Write the failing state-machine tests**

Create `extensions/pets/state/pet-state.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { PetState } from "./pet-state.js";

const WAITING_TOOLS = ["request_user_input", "ask_user_question", "askUserQuestion"];

function make(now = () => 0): { state: PetState; advance: (ms: number) => void; timers: Array<() => void> } {
  let current = now();
  const timers: Array<{ at: number; fn: () => void }> = [];
  const sm = new PetState({
    waitingTools: WAITING_TOOLS,
    reviewLingerMs: 30_000,
    failedLingerMs: 5 * 60_000,
    now: () => current,
    schedule: (delay, fn) => {
      const entry = { at: current + delay, fn };
      timers.push(entry);
      return () => {
        const idx = timers.indexOf(entry);
        if (idx >= 0) timers.splice(idx, 1);
      };
    },
  });
  return {
    state: sm,
    advance: (ms) => {
      current += ms;
      while (true) {
        const due = timers.find((t) => t.at <= current);
        if (!due) break;
        timers.splice(timers.indexOf(due), 1);
        due.fn();
      }
    },
    timers: timers as any,
  };
}

describe("PetState", () => {
  it("starts in idle", () => {
    const { state } = make();
    expect(state.current).toBe("idle");
  });

  it("agent_start moves to running", () => {
    const { state } = make();
    state.onAgentStart();
    expect(state.current).toBe("running");
  });

  it("tool_execution_start for a known waiting tool moves to waiting", () => {
    const { state } = make();
    state.onAgentStart();
    state.onToolStart("request_user_input");
    expect(state.current).toBe("waiting");
  });

  it("tool_execution_end for the waiting tool returns to running", () => {
    const { state } = make();
    state.onAgentStart();
    state.onToolStart("request_user_input");
    state.onToolEnd("request_user_input", /*isError*/ false);
    expect(state.current).toBe("running");
  });

  it("tool_execution_end with isError moves to failed", () => {
    const { state } = make();
    state.onAgentStart();
    state.onToolEnd("read", /*isError*/ true);
    expect(state.current).toBe("failed");
  });

  it("turn_end with success moves to review and lingers, then idle", () => {
    const { state, advance } = make();
    state.onAgentStart();
    state.onTurnEnd({ stopReason: "stop", errorMessage: undefined });
    expect(state.current).toBe("review");
    advance(30_000);
    expect(state.current).toBe("idle");
  });

  it("turn_end with error stopReason moves to failed and lingers, then idle", () => {
    const { state, advance } = make();
    state.onAgentStart();
    state.onTurnEnd({ stopReason: "error", errorMessage: "boom" });
    expect(state.current).toBe("failed");
    advance(5 * 60_000);
    expect(state.current).toBe("idle");
  });

  it("agent_start while failed goes back to running", () => {
    const { state } = make();
    state.onAgentStart();
    state.onTurnEnd({ stopReason: "error", errorMessage: "boom" });
    expect(state.current).toBe("failed");
    state.onAgentStart();
    expect(state.current).toBe("running");
  });

  it("notifies subscribers on state changes", () => {
    const { state } = make();
    const listener = vi.fn();
    state.subscribe(listener);
    state.onAgentStart();
    state.onTurnEnd({ stopReason: "stop", errorMessage: undefined });
    expect(listener.mock.calls.map(([s]) => s)).toEqual(["running", "review"]);
  });
});
```

- [x] **Step 2: Run the failing test**

Run:

```bash
npx vitest run extensions/pets/state/pet-state.test.ts
```

Expected: FAIL.

- [x] **Step 3: Implement the state machine**

Create `extensions/pets/state/pet-state.ts`:

```ts
export type PetStateName = "idle" | "running" | "waiting" | "review" | "failed";

export interface TurnEndPayload {
  stopReason: string | undefined;
  errorMessage: string | undefined;
}

export interface PetStateOptions {
  waitingTools: readonly string[];
  reviewLingerMs: number;
  failedLingerMs: number;
  now?: () => number;
  schedule?: (delayMs: number, fn: () => void) => () => void;
}

type Listener = (state: PetStateName) => void;

export class PetState {
  private state: PetStateName = "idle";
  private listeners = new Set<Listener>();
  private cancelLinger?: () => void;
  private activeWaitingTool?: string;
  private readonly options: Required<PetStateOptions>;

  constructor(options: PetStateOptions) {
    this.options = {
      now: () => Date.now(),
      schedule: (delay, fn) => {
        const handle = setTimeout(fn, delay);
        return () => clearTimeout(handle);
      },
      ...options,
    };
  }

  get current(): PetStateName {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onAgentStart(): void {
    this.setState("running");
  }

  onToolStart(toolName: string): void {
    if (this.options.waitingTools.includes(toolName)) {
      this.activeWaitingTool = toolName;
      this.setState("waiting");
    }
  }

  onToolEnd(toolName: string, isError: boolean): void {
    if (isError) {
      this.setState("failed", this.options.failedLingerMs);
      return;
    }
    if (this.activeWaitingTool && this.activeWaitingTool === toolName) {
      this.activeWaitingTool = undefined;
      this.setState("running");
    }
  }

  onTurnEnd(payload: TurnEndPayload): void {
    const failed = payload.stopReason === "error" || payload.stopReason === "aborted"
      || (payload.errorMessage !== undefined && payload.errorMessage.length > 0);
    if (failed) {
      this.setState("failed", this.options.failedLingerMs);
    } else {
      this.setState("review", this.options.reviewLingerMs);
    }
  }

  onAgentEnd(payload: TurnEndPayload): void {
    if (payload.stopReason === "error" || payload.stopReason === "aborted"
      || (payload.errorMessage !== undefined && payload.errorMessage.length > 0)) {
      this.setState("failed", this.options.failedLingerMs);
    }
  }

  private setState(next: PetStateName, lingerMs?: number): void {
    if (this.cancelLinger) {
      this.cancelLinger();
      this.cancelLinger = undefined;
    }
    if (this.state !== next) {
      this.state = next;
      for (const listener of this.listeners) listener(next);
    }
    if (lingerMs !== undefined && lingerMs > 0) {
      this.cancelLinger = this.options.schedule(lingerMs, () => {
        this.cancelLinger = undefined;
        if (this.state === next) this.setState("idle");
      });
    }
  }
}
```

- [x] **Step 4: Run the test to confirm it passes**

Run:

```bash
npx vitest run extensions/pets/state/pet-state.test.ts
npm run typecheck
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add extensions/pets/state/pet-state.ts extensions/pets/state/pet-state.test.ts
git commit -m "feat(pets): event-driven pet state machine"
```

---

### Task 12: Settings persistence

**Files:**
- Create: `extensions/pets/config/settings.ts`
- Create: `extensions/pets/config/settings.test.ts`

- [x] **Step 1: Write the failing settings test**

Create `extensions/pets/config/settings.test.ts`:

```ts
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultSettings, loadSettings, saveSettings } from "./settings.js";

describe("pets settings", () => {
  it("returns defaults when no file exists", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pets-settings-"));
    const settings = await loadSettings(agentDir);
    expect(settings).toEqual(defaultSettings());
  });

  it("round-trips through disk", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pets-settings-"));
    const expected = { selectedPet: "x", enabled: false, placement: "aboveEditor" as const, tmuxPassthrough: true, renderMode: "block-art" as const };
    await saveSettings(agentDir, expected);
    const onDisk = JSON.parse(readFileSync(join(agentDir, "pets.json"), "utf8"));
    expect(onDisk).toEqual(expected);
    expect(await loadSettings(agentDir)).toEqual(expected);
  });

  it("ignores unknown fields and falls back to defaults for invalid values", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pets-settings-"));
    await saveSettings(agentDir, defaultSettings());
    // Manually overwrite to simulate corruption.
    const filePath = join(agentDir, "pets.json");
    const corrupted = JSON.stringify({ selectedPet: 42, enabled: "yes", placement: "elsewhere", renderMode: "nope", extra: true });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(filePath, corrupted);
    const merged = await loadSettings(agentDir);
    expect(merged).toEqual(defaultSettings());
  });
});
```

- [x] **Step 2: Run the failing test**

Run:

```bash
npx vitest run extensions/pets/config/settings.test.ts
```

Expected: FAIL.

- [x] **Step 3: Implement settings**

Create `extensions/pets/config/settings.ts`:

```ts
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface PetSettings {
  selectedPet: string;
  enabled: boolean;
  placement: "belowEditor" | "aboveEditor";
  tmuxPassthrough: boolean;
  renderMode: "auto" | "image" | "block-art";
}

const PLACEMENTS = ["belowEditor", "aboveEditor"] as const;
const RENDER_MODES = ["auto", "image", "block-art"] as const;

export function defaultSettings(): PetSettings {
  return {
    selectedPet: "default",
    enabled: true,
    placement: "belowEditor",
    tmuxPassthrough: false,
    renderMode: "auto",
  };
}

export async function loadSettings(agentDir: string): Promise<PetSettings> {
  const path = join(agentDir, "pets.json");
  if (!existsSync(path)) return defaultSettings();
  try {
    const text = await readFile(path, "utf8");
    const raw = JSON.parse(text) as Record<string, unknown>;
    return normalize(raw);
  } catch {
    return defaultSettings();
  }
}

export async function saveSettings(agentDir: string, settings: PetSettings): Promise<void> {
  const path = join(agentDir, "pets.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(normalize(settings), null, 2), { mode: 0o600 });
}

function normalize(raw: Record<string, unknown>): PetSettings {
  const defaults = defaultSettings();
  const selectedPet = typeof raw.selectedPet === "string" && raw.selectedPet.length > 0 ? raw.selectedPet : defaults.selectedPet;
  const enabled = typeof raw.enabled === "boolean" ? raw.enabled : defaults.enabled;
  const placement = PLACEMENTS.includes(raw.placement as any) ? (raw.placement as PetSettings["placement"]) : defaults.placement;
  const tmuxPassthrough = typeof raw.tmuxPassthrough === "boolean" ? raw.tmuxPassthrough : defaults.tmuxPassthrough;
  const renderMode = RENDER_MODES.includes(raw.renderMode as any) ? (raw.renderMode as PetSettings["renderMode"]) : defaults.renderMode;
  return { selectedPet, enabled, placement, tmuxPassthrough, renderMode };
}
```

- [x] **Step 4: Run the test to confirm it passes**

Run:

```bash
npx vitest run extensions/pets/config/settings.test.ts
npm run typecheck
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add extensions/pets/config/settings.ts extensions/pets/config/settings.test.ts
git commit -m "feat(pets): persist pet settings under getAgentDir/pets.json"
```

---

### Task 13: Pet component (widget body with animation tick)

**Files:**
- Create: `extensions/pets/widget/pet-component.ts`
- Create: `extensions/pets/widget/pet-component.test.ts`

- [x] **Step 1: Write the failing component tests**

Create `extensions/pets/widget/pet-component.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { PetState } from "../state/pet-state.js";
import { createPetComponent } from "./pet-component.js";

function makeState() {
  return new PetState({
    waitingTools: ["request_user_input"],
    reviewLingerMs: 1000,
    failedLingerMs: 1000,
    schedule: (_d, fn) => {
      // Linger timers are not exercised in this test.
      return () => {};
    },
    now: () => 0,
  });
}

describe("createPetComponent", () => {
  it("renders the current animation frame, advancing on tick", () => {
    const state = makeState();
    state.onAgentStart(); // → running
    const frames = {
      running: ["one", "two", "three"],
      idle: ["idle"],
      waiting: ["w"],
      review: ["r"],
      failed: ["f"],
    } as const;
    const renderFrame = vi.fn((stateName: keyof typeof frames, frameIndex: number) => [frames[stateName][frameIndex]]);

    const tui = { requestRender: vi.fn() };
    const component = createPetComponent({
      state,
      tui: tui as any,
      animationsByState: {
        running: { frames: [0, 1, 2], fps: 100, loop: true, fallback: "idle" },
        idle: { frames: [0], fps: 1, loop: true, fallback: "idle" },
        waiting: { frames: [0], fps: 1, loop: true, fallback: "idle" },
        review: { frames: [0], fps: 1, loop: false, fallback: "idle" },
        failed: { frames: [0], fps: 1, loop: true, fallback: "idle" },
      },
      renderFrame,
    });

    expect(component.render(20)).toEqual(["one"]);
    component.tickForTest();
    expect(component.render(20)).toEqual(["two"]);
    component.tickForTest();
    expect(component.render(20)).toEqual(["three"]);
    component.tickForTest();
    expect(component.render(20)).toEqual(["one"]);
    expect(tui.requestRender).toHaveBeenCalled();
  });

  it("re-renders when the state changes and resets the frame index", () => {
    const state = makeState();
    state.onAgentStart();
    const renderFrame = vi.fn(() => ["x"]);
    const tui = { requestRender: vi.fn() };
    createPetComponent({
      state,
      tui: tui as any,
      animationsByState: {
        running: { frames: [0, 1], fps: 1, loop: true, fallback: "idle" },
        idle: { frames: [0], fps: 1, loop: true, fallback: "idle" },
        waiting: { frames: [0], fps: 1, loop: true, fallback: "idle" },
        review: { frames: [0], fps: 1, loop: false, fallback: "idle" },
        failed: { frames: [0], fps: 1, loop: true, fallback: "idle" },
      },
      renderFrame,
    });
    state.onTurnEnd({ stopReason: "stop", errorMessage: undefined });
    expect(tui.requestRender).toHaveBeenCalled();
  });
});
```

- [x] **Step 2: Run the failing test**

Run:

```bash
npx vitest run extensions/pets/widget/pet-component.test.ts
```

Expected: FAIL.

- [x] **Step 3: Implement the component**

Create `extensions/pets/widget/pet-component.ts`:

```ts
import type { TUI } from "@earendil-works/pi-tui";
import type { AnimationSpec, PetStateName } from "../loader/pet-manifest.js";
import { PetState } from "../state/pet-state.js";

export interface PetComponent {
  render(width: number): string[];
  invalidate(): void;
  /** Visible for tests. Call to manually advance one tick. */
  tickForTest(): void;
}

export interface CreatePetComponentOptions {
  state: PetState;
  tui: Pick<TUI, "requestRender">;
  animationsByState: Record<PetStateName, AnimationSpec>;
  renderFrame: (state: PetStateName, frameIndex: number, width: number) => string[];
}

export function createPetComponent(options: CreatePetComponentOptions): PetComponent {
  let frameIndex = 0;
  let timer: NodeJS.Timeout | undefined;
  let lastTickAt = Date.now();
  let cachedWidth = -1;
  let cachedLines: string[] = [];
  let cachedKey = "";

  function scheduleTick(): void {
    if (timer) clearTimeout(timer);
    const spec = options.animationsByState[options.state.current];
    if (!spec || spec.frames.length <= 1) {
      timer = undefined;
      return;
    }
    const delay = Math.max(16, Math.floor(1000 / spec.fps));
    timer = setTimeout(() => {
      const now = Date.now();
      lastTickAt = now;
      const current = options.animationsByState[options.state.current];
      const len = current.frames.length;
      if (current.loop) {
        frameIndex = (frameIndex + 1) % len;
      } else if (frameIndex + 1 < len) {
        frameIndex += 1;
      }
      cachedWidth = -1;
      options.tui.requestRender();
      scheduleTick();
    }, delay);
  }

  options.state.subscribe(() => {
    frameIndex = 0;
    cachedWidth = -1;
    scheduleTick();
    options.tui.requestRender();
  });

  scheduleTick();

  return {
    render(width) {
      const stateName = options.state.current;
      const spec = options.animationsByState[stateName];
      const realFrameIndex = spec.frames[Math.min(frameIndex, spec.frames.length - 1)];
      const key = `${stateName}:${realFrameIndex}:${width}`;
      if (key === cachedKey && cachedWidth === width) return cachedLines;
      cachedLines = options.renderFrame(stateName, realFrameIndex, width);
      cachedWidth = width;
      cachedKey = key;
      return cachedLines;
    },
    invalidate() {
      cachedWidth = -1;
    },
    tickForTest() {
      const spec = options.animationsByState[options.state.current];
      const len = spec.frames.length;
      if (spec.loop) frameIndex = (frameIndex + 1) % len;
      else if (frameIndex + 1 < len) frameIndex += 1;
      cachedWidth = -1;
      options.tui.requestRender();
    },
  };
}
```

- [x] **Step 4: Run the test to confirm it passes**

Run:

```bash
npx vitest run extensions/pets/widget/pet-component.test.ts
npm run typecheck
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add extensions/pets/widget/pet-component.ts extensions/pets/widget/pet-component.test.ts
git commit -m "feat(pets): component drives animation tick and frame cache"
```

---

### Task 14: Widget installation glue

**Files:**
- Create: `extensions/pets/widget/pet-widget.ts`
- Create: `extensions/pets/widget/pet-widget.test.ts`

- [x] **Step 1: Write the failing widget-glue test**

Create `extensions/pets/widget/pet-widget.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { installPetWidget } from "./pet-widget.js";

describe("installPetWidget", () => {
  it("registers a setWidget factory with the requested placement", () => {
    const setWidget = vi.fn();
    const handle = installPetWidget({
      ctx: { hasUI: true, ui: { setWidget } } as any,
      placement: "belowEditor",
      componentFactory: () => ({ render: () => ["pet"], invalidate: () => {} }) as any,
    });
    expect(setWidget).toHaveBeenCalledWith("codex-pet", expect.any(Function), { placement: "belowEditor" });
    handle.uninstall();
    expect(setWidget).toHaveBeenLastCalledWith("codex-pet", undefined, { placement: "belowEditor" });
  });

  it("is a no-op when ctx.hasUI is false", () => {
    const setWidget = vi.fn();
    installPetWidget({
      ctx: { hasUI: false, ui: { setWidget } } as any,
      placement: "belowEditor",
      componentFactory: () => ({ render: () => [], invalidate: () => {} }) as any,
    });
    expect(setWidget).not.toHaveBeenCalled();
  });
});
```

- [x] **Step 2: Run the failing test**

Run:

```bash
npx vitest run extensions/pets/widget/pet-widget.test.ts
```

Expected: FAIL.

- [x] **Step 3: Implement the widget glue**

Create `extensions/pets/widget/pet-widget.ts`:

```ts
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

export const PET_WIDGET_KEY = "codex-pet";

export interface InstallPetWidgetOptions {
  ctx: Pick<ExtensionContext, "hasUI" | "ui">;
  placement: "belowEditor" | "aboveEditor";
  componentFactory: (tui: TUI, theme: unknown) => Component;
}

export interface InstalledWidgetHandle {
  uninstall(): void;
}

export function installPetWidget(options: InstallPetWidgetOptions): InstalledWidgetHandle {
  if (!options.ctx.hasUI) {
    return { uninstall() {} };
  }
  options.ctx.ui.setWidget(PET_WIDGET_KEY, options.componentFactory as any, { placement: options.placement });
  return {
    uninstall() {
      options.ctx.ui.setWidget(PET_WIDGET_KEY, undefined, { placement: options.placement });
    },
  };
}
```

- [x] **Step 4: Run the test to confirm it passes**

Run:

```bash
npx vitest run extensions/pets/widget/pet-widget.test.ts
npm run typecheck
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add extensions/pets/widget/pet-widget.ts extensions/pets/widget/pet-widget.test.ts
git commit -m "feat(pets): widget install/uninstall helper"
```

---

### Task 15: Commands (subcommand router + non-interactive subcommands)

**Files:**
- Create: `extensions/pets/commands/pets-command.ts`
- Create: `extensions/pets/commands/pets-command.test.ts`

This task wires up `/pets list`, `/pets set <id>`, `/pets on`, `/pets off`,
`/pets diagnose`, `/pets tmux-passthrough on|off`. The interactive `SelectList`
picker is added in Task 16 to keep this task focused.

- [x] **Step 1: Write the failing command tests**

Create `extensions/pets/commands/pets-command.test.ts`:

```ts
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { defaultSettings } from "../config/settings.js";
import { handlePetsCommand } from "./pets-command.js";

function makeCtx(agentDir: string) {
  return {
    hasUI: false,
    ui: { notify: vi.fn() },
    exec: vi.fn(async () => ({ exitCode: 1, stdout: "", stderr: "tmux not installed" })),
    cwd: process.cwd(),
    sessionManager: {} as any,
    isIdle: () => true,
    signal: undefined,
    abort: () => {},
    hasPendingMessages: () => false,
    shutdown: () => {},
    getContextUsage: () => undefined,
    compact: () => {},
    getSystemPrompt: () => "",
    appendEntry: () => {},
  } as any;
}

describe("handlePetsCommand", () => {
  it("`/pets set <id>` writes settings on disk", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pets-cmd-"));
    const ctx = makeCtx(agentDir);
    await handlePetsCommand("set default", ctx, { agentDir });
    const json = JSON.parse(readFileSync(join(agentDir, "pets.json"), "utf8"));
    expect(json.selectedPet).toBe("default");
    expect(json.enabled).toBe(true);
  });

  it("`/pets off` toggles enabled=false", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pets-cmd-"));
    const ctx = makeCtx(agentDir);
    await handlePetsCommand("off", ctx, { agentDir });
    const json = JSON.parse(readFileSync(join(agentDir, "pets.json"), "utf8"));
    expect(json.enabled).toBe(false);
  });

  it("`/pets on` re-enables and keeps the previous selection", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pets-cmd-"));
    const ctx = makeCtx(agentDir);
    await handlePetsCommand("set default", ctx, { agentDir });
    await handlePetsCommand("off", ctx, { agentDir });
    await handlePetsCommand("on", ctx, { agentDir });
    const json = JSON.parse(readFileSync(join(agentDir, "pets.json"), "utf8"));
    expect(json.enabled).toBe(true);
    expect(json.selectedPet).toBe("default");
  });

  it("`/pets tmux-passthrough on` sets the flag", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pets-cmd-"));
    const ctx = makeCtx(agentDir);
    await handlePetsCommand("tmux-passthrough on", ctx, { agentDir });
    const json = JSON.parse(readFileSync(join(agentDir, "pets.json"), "utf8"));
    expect(json.tmuxPassthrough).toBe(true);
  });

  it("`/pets diagnose` calls ui.notify with a report", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pets-cmd-"));
    const ctx = makeCtx(agentDir);
    await handlePetsCommand("diagnose", ctx, { agentDir });
    expect(ctx.ui.notify).toHaveBeenCalled();
    const text = ctx.ui.notify.mock.calls[0][0] as string;
    expect(text).toMatch(/selected pet/);
    expect(text).toMatch(/render mode/);
  });

  it("`/pets set <id>` for an unknown id reports an error and leaves settings unchanged", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pets-cmd-"));
    const ctx = makeCtx(agentDir);
    await handlePetsCommand("set bogus", ctx, { agentDir });
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/unknown pet/), "error");
    // No file should have been written.
    expect(() => readFileSync(join(agentDir, "pets.json"), "utf8")).toThrow();
  });
});
```

- [x] **Step 2: Run the failing test**

Run:

```bash
npx vitest run extensions/pets/commands/pets-command.test.ts
```

Expected: FAIL.

- [x] **Step 3: Implement the commands**

Create `extensions/pets/commands/pets-command.ts`:

```ts
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { builtinPet, builtinPets } from "../catalog/catalog.js";
import { detectPetCapability } from "../render/capability.js";
import { selectRenderer } from "../render/select-renderer.js";
import { defaultSettings, loadSettings, saveSettings, type PetSettings } from "../config/settings.js";

export interface HandlePetsOptions {
  agentDir: string;
}

export async function handlePetsCommand(
  args: string,
  ctx: ExtensionCommandContext | ExtensionContext,
  options: HandlePetsOptions,
): Promise<void> {
  const trimmed = args.trim();
  const [subcommand, ...rest] = trimmed.split(/\s+/);

  switch (subcommand) {
    case "":
    case "list":
      await handleList(ctx, options);
      return;
    case "set":
      await handleSet(ctx, options, rest.join(" ").trim());
      return;
    case "on":
      await handleEnabled(ctx, options, true);
      return;
    case "off":
      await handleEnabled(ctx, options, false);
      return;
    case "diagnose":
      await handleDiagnose(ctx, options);
      return;
    case "tmux-passthrough":
      await handleTmuxPassthrough(ctx, options, rest.join(" ").trim());
      return;
    default:
      ctx.ui.notify(
        `Unknown /pets subcommand: ${subcommand}. Try: /pets list, /pets set <id>, /pets on, /pets off, /pets diagnose, /pets tmux-passthrough on|off`,
        "error",
      );
  }
}

async function handleList(ctx: { ui: { notify: (msg: string, kind?: string) => void } }, options: HandlePetsOptions): Promise<void> {
  const builtins = builtinPets().map((pet) => `${pet.id} (built-in): ${pet.description}`);
  const customDir = join(options.agentDir, "pets");
  let customLines: string[] = [];
  if (existsSync(customDir)) {
    const entries = await readdir(customDir, { withFileTypes: true });
    customLines = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${entry.name} (custom): from ${join(customDir, entry.name)}`);
  }
  const lines = ["Available pets:", ...builtins, ...customLines];
  ctx.ui.notify(lines.join("\n"));
}

async function handleSet(ctx: { ui: { notify: (msg: string, kind?: string) => void } }, options: HandlePetsOptions, id: string): Promise<void> {
  if (!id) {
    ctx.ui.notify("Usage: /pets set <id>", "error");
    return;
  }
  const known = builtinPet(id) !== undefined || existsSync(join(options.agentDir, "pets", id, "pet.json"));
  if (!known) {
    ctx.ui.notify(`unknown pet: ${id}`, "error");
    return;
  }
  const current = await loadSettings(options.agentDir);
  const next: PetSettings = { ...current, selectedPet: id, enabled: true };
  await saveSettings(options.agentDir, next);
  ctx.ui.notify(`Pet set to ${id}.`);
}

async function handleEnabled(ctx: { ui: { notify: (msg: string, kind?: string) => void } }, options: HandlePetsOptions, enabled: boolean): Promise<void> {
  const current = await loadSettings(options.agentDir);
  const next: PetSettings = { ...current, enabled };
  await saveSettings(options.agentDir, next);
  ctx.ui.notify(enabled ? "Pet enabled." : "Pet disabled.");
}

async function handleTmuxPassthrough(ctx: { ui: { notify: (msg: string, kind?: string) => void } }, options: HandlePetsOptions, value: string): Promise<void> {
  if (value !== "on" && value !== "off") {
    ctx.ui.notify("Usage: /pets tmux-passthrough on|off", "error");
    return;
  }
  const current = await loadSettings(options.agentDir);
  const next: PetSettings = { ...current, tmuxPassthrough: value === "on" };
  await saveSettings(options.agentDir, next);
  ctx.ui.notify(`tmux passthrough set to ${value}.`);
}

async function handleDiagnose(
  ctx: ExtensionCommandContext | ExtensionContext,
  options: HandlePetsOptions,
): Promise<void> {
  const settings = await loadSettings(options.agentDir);
  const capability = await detectPetCapability({
    env: process.env,
    execTmux: async (args) => {
      if (typeof (ctx as ExtensionCommandContext).exec !== "function") {
        return { ok: false, stdout: "", stderr: "exec not available" };
      }
      try {
        const result = await (ctx as ExtensionCommandContext).exec("tmux", args, { timeoutMs: 5000 });
        return { ok: result.exitCode === 0, stdout: result.stdout, stderr: result.stderr };
      } catch (error) {
        return { ok: false, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
      }
    },
  });
  const choice = selectRenderer({ settings, capability });
  const decision =
    choice.kind === "disabled"
      ? "disabled"
      : choice.kind === "image"
        ? `Image renderer${choice.wrapForTmux ? " (tmux DCS passthrough)" : ""}`
        : "BlockArt renderer";

  const lines = [
    `/pets diagnose`,
    `  selected pet:           ${settings.selectedPet}`,
    `  enabled:                ${settings.enabled}`,
    `  render mode:            ${settings.renderMode}`,
    `  pi-tui images:          ${capability.images ?? "none"}`,
    `  pi-tui trueColor:       ${capability.trueColor}`,
    `  in tmux:                ${capability.inTmux}`,
    `  tmux version:           ${capability.tmuxVersion ?? "unknown"}`,
    `  allow-passthrough:      ${capability.tmuxPassthroughEnabled === undefined ? "unknown" : capability.tmuxPassthroughEnabled ? "on" : "off"}`,
    `  tmux passthrough opt-in:${settings.tmuxPassthrough}`,
    `  decision:               ${decision}`,
  ];
  ctx.ui.notify(lines.join("\n"));
}

export const __test = { defaultSettings };
```

- [x] **Step 4: Run the test to confirm it passes**

Run:

```bash
npx vitest run extensions/pets/commands/pets-command.test.ts
npm run typecheck
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add extensions/pets/commands/pets-command.ts extensions/pets/commands/pets-command.test.ts
git commit -m "feat(pets): /pets subcommands for list/set/on/off/diagnose/tmux"
```

---

### Task 16: Interactive picker (`/pets`)

**Files:**
- Modify: `extensions/pets/commands/pets-command.ts:1-end`
- Modify: `extensions/pets/commands/pets-command.test.ts:1-end`

- [x] **Step 1: Add a failing test for the interactive picker**

Append this test to `extensions/pets/commands/pets-command.test.ts`:

```ts
import type { SelectItem } from "@earendil-works/pi-tui";

describe("handlePetsCommand interactive picker", () => {
  it("`/pets` opens a SelectList overlay listing built-ins and disable entry", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pets-cmd-"));
    const customCall = vi.fn(async (factory: any) => {
      let pickedValue: string | undefined;
      const fakeTui = { requestRender: vi.fn() } as any;
      const fakeTheme = {
        fg: (_color: string, t: string) => t,
        bg: (_color: string, t: string) => t,
        bold: (t: string) => t,
      };
      const done = (value: string | null) => {
        pickedValue = value ?? undefined;
      };
      // Call the factory to inspect what SelectList items it builds.
      const component = factory(fakeTui, fakeTheme, undefined, done);
      // The factory should expose the built items via component for tests.
      const items = (component as any).__items as SelectItem[];
      expect(items.map((item) => item.value)).toEqual(["disabled", "default"]);
      // Simulate selecting "default".
      done("default");
      return "default";
    });

    const ctx: any = {
      hasUI: true,
      ui: { notify: vi.fn(), custom: customCall, setWidget: vi.fn() },
      sessionManager: {},
    };
    await handlePetsCommand("", ctx, { agentDir });
    expect(customCall).toHaveBeenCalled();
    const json = JSON.parse(readFileSync(join(agentDir, "pets.json"), "utf8"));
    expect(json.selectedPet).toBe("default");
  });
});
```

- [x] **Step 2: Run the failing test**

Run:

```bash
npx vitest run extensions/pets/commands/pets-command.test.ts
```

Expected: FAIL — the current router calls `handleList` for `""`, and never
invokes `ctx.ui.custom`.

- [x] **Step 3: Modify the router to open the picker when `hasUI` is true**

In `extensions/pets/commands/pets-command.ts`, replace the `case "":` /
`case "list":` branch with:

```ts
    case "":
      if ("custom" in (ctx.ui ?? {}) && (ctx as ExtensionContext).hasUI) {
        await handlePicker(ctx, options);
      } else {
        await handleList(ctx, options);
      }
      return;
    case "list":
      await handleList(ctx, options);
      return;
```

Add at the bottom of the file:

```ts
async function handlePicker(
  ctx: ExtensionCommandContext | ExtensionContext,
  options: HandlePetsOptions,
): Promise<void> {
  const settings = await loadSettings(options.agentDir);
  const builtins = builtinPets().map((pet) => ({
    value: pet.id,
    label: pet.displayName,
    description: pet.description,
  }));
  const customDir = join(options.agentDir, "pets");
  let custom: { value: string; label: string; description: string }[] = [];
  if (existsSync(customDir)) {
    const entries = await readdir(customDir, { withFileTypes: true });
    custom = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ value: entry.name, label: entry.name, description: "custom pet" }));
  }
  const items = [
    { value: "disabled", label: "Disable terminal pets" },
    ...builtins,
    ...custom,
  ];

  if (typeof (ctx as any).ui?.custom !== "function") {
    await handleList(ctx, options);
    return;
  }

  const pick = await (ctx as any).ui.custom((tui: any, theme: any, _kb: any, done: (value: string | null) => void) => {
    const { SelectList, Container, Text } = require("@earendil-works/pi-tui");
    const { DynamicBorder } = require("@earendil-works/pi-coding-agent");
    const container = new Container();
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    container.addChild(new Text(theme.fg("accent", theme.bold("Select Pet")), 1, 0));
    const select = new SelectList(items, Math.min(items.length, 10), {
      selectedPrefix: (t: string) => theme.fg("accent", t),
      selectedText: (t: string) => theme.fg("accent", t),
      description: (t: string) => theme.fg("muted", t),
    });
    select.onSelect = (item: any) => done(item.value);
    select.onCancel = () => done(null);
    container.addChild(select);
    container.addChild(new Text(theme.fg("dim", "↑↓ navigate · enter select · esc cancel"), 1, 0));
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    (container as any).__items = items; // for tests
    return {
      render: (w: number) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => { select.handleInput(data); tui.requestRender(); },
    };
  });

  if (!pick) return;
  if (pick === "disabled") {
    await saveSettings(options.agentDir, { ...settings, enabled: false });
    ctx.ui.notify("Pet disabled.");
    return;
  }
  await saveSettings(options.agentDir, { ...settings, selectedPet: pick, enabled: true });
  ctx.ui.notify(`Pet set to ${pick}.`);
}
```

- [x] **Step 4: Run all tests in the file**

Run:

```bash
npx vitest run extensions/pets/commands/pets-command.test.ts
npm run typecheck
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add extensions/pets/commands/pets-command.ts extensions/pets/commands/pets-command.test.ts
git commit -m "feat(pets): /pets interactive picker via SelectList"
```

---

### Task 17: Wire everything in the extension entry point

**Files:**
- Modify: `extensions/pets/index.ts:1-end`
- Modify: `extensions/pets/index.test.ts:1-end`

- [x] **Step 1: Replace the entry test with an end-to-end install/uninstall test**

Replace `extensions/pets/index.test.ts` entirely:

```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import petsExtension from "./index.js";

function fakePi() {
  const handlers: Record<string, Function> = {};
  return {
    handlers,
    api: {
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      registerMessageRenderer: vi.fn(),
      on: vi.fn((event: string, fn: Function) => {
        handlers[event] = fn;
      }),
      appendEntry: vi.fn(),
      sendMessage: vi.fn(),
    },
  };
}

function fakeCtx(agentDir: string) {
  const ui = {
    setWidget: vi.fn(),
    notify: vi.fn(),
    theme: { fg: (_c: string, t: string) => t },
  };
  return {
    agentDir,
    ui: ui as any,
    ctx: {
      hasUI: true,
      ui,
      cwd: process.cwd(),
      sessionManager: {} as any,
      exec: vi.fn(async () => ({ exitCode: 1, stdout: "", stderr: "tmux not installed" })),
      isIdle: () => true,
      signal: undefined,
      abort: () => {},
      hasPendingMessages: () => false,
      shutdown: () => {},
      getContextUsage: () => undefined,
      compact: () => {},
      getSystemPrompt: () => "",
      appendEntry: () => {},
    } as any,
  };
}

describe("pets extension lifecycle", () => {
  it("installs the widget on session_start and removes it on session_shutdown", async () => {
    const pi = fakePi();
    await petsExtension(pi.api as any);

    const agentDir = mkdtempSync(join(tmpdir(), "pets-ext-"));
    writeFileSync(join(agentDir, "pets.json"), JSON.stringify({ selectedPet: "default", enabled: true, placement: "belowEditor", tmuxPassthrough: false, renderMode: "block-art" }));

    const { ctx, ui } = fakeCtx(agentDir);
    // Inject agent dir override via env so the extension uses our temp dir.
    process.env.PI_PETS_AGENT_DIR = agentDir;
    try {
      await pi.handlers.session_start({ type: "session_start", reason: "startup" }, ctx);
      expect(ui.setWidget).toHaveBeenCalledWith("codex-pet", expect.any(Function), { placement: "belowEditor" });
      await pi.handlers.session_shutdown({ type: "session_shutdown" }, ctx);
      expect(ui.setWidget).toHaveBeenLastCalledWith("codex-pet", undefined, { placement: "belowEditor" });
    } finally {
      delete process.env.PI_PETS_AGENT_DIR;
    }
  });

  it("does not install the widget when settings.enabled is false", async () => {
    const pi = fakePi();
    await petsExtension(pi.api as any);
    const agentDir = mkdtempSync(join(tmpdir(), "pets-ext-"));
    writeFileSync(join(agentDir, "pets.json"), JSON.stringify({ selectedPet: "default", enabled: false, placement: "belowEditor", tmuxPassthrough: false, renderMode: "block-art" }));
    const { ctx, ui } = fakeCtx(agentDir);
    process.env.PI_PETS_AGENT_DIR = agentDir;
    try {
      await pi.handlers.session_start({ type: "session_start", reason: "startup" }, ctx);
      expect(ui.setWidget).not.toHaveBeenCalled();
    } finally {
      delete process.env.PI_PETS_AGENT_DIR;
    }
  });
});
```

- [x] **Step 2: Run the failing test**

Run:

```bash
npx vitest run extensions/pets/index.test.ts
```

Expected: FAIL — current `index.ts` stub does nothing on `session_start`.

- [x] **Step 3: Implement the entry point**

Replace `extensions/pets/index.ts` with:

```ts
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { extractFrames } from "./loader/frames.js";
import { loadPet } from "./loader/pet-loader.js";
import { loadSettings, type PetSettings } from "./config/settings.js";
import { detectPetCapability } from "./render/capability.js";
import { selectRenderer } from "./render/select-renderer.js";
import { createImageRenderer } from "./render/image-renderer.js";
import { renderBlockArt } from "./render/block-art.js";
import { PetState } from "./state/pet-state.js";
import { createPetComponent } from "./widget/pet-component.js";
import { installPetWidget, type InstalledWidgetHandle } from "./widget/pet-widget.js";
import { handlePetsCommand } from "./commands/pets-command.js";
import { FALLBACK_ASCII } from "./catalog/default/fallback.js";

const WAITING_TOOLS = ["request_user_input", "ask_user_question", "askUserQuestion"];
const REVIEW_LINGER_MS = 30_000;
const FAILED_LINGER_MS = 5 * 60_000;

interface RuntimeContext {
  widget?: InstalledWidgetHandle;
  state?: PetState;
  settings: PetSettings;
}

function getAgentDirOverride(): string {
  return process.env.PI_PETS_AGENT_DIR ?? getAgentDir();
}

export default async function petsExtension(pi: ExtensionAPI): Promise<void> {
  const runtime: RuntimeContext = { settings: { selectedPet: "default", enabled: true, placement: "belowEditor", tmuxPassthrough: false, renderMode: "auto" } };

  pi.registerCommand("pets", {
    description: "Configure the Codex-style terminal pet (pet, picker, diagnose, tmux passthrough).",
    handler: async (args, ctx) => {
      await handlePetsCommand(args, ctx, { agentDir: getAgentDirOverride() });
      // Re-install widget so changes take effect immediately.
      await installFromSettings(pi, runtime, ctx);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    await installFromSettings(pi, runtime, ctx);
  });

  pi.on("session_shutdown", async () => {
    runtime.widget?.uninstall();
    runtime.widget = undefined;
    runtime.state = undefined;
  });

  pi.on("agent_start", async () => {
    runtime.state?.onAgentStart();
  });

  pi.on("turn_start", async () => {
    runtime.state?.onAgentStart();
  });

  pi.on("turn_end", async (event) => {
    const message = (event as any).message;
    const stopReason = message?.stopReason as string | undefined;
    const errorMessage = message?.errorMessage as string | undefined;
    runtime.state?.onTurnEnd({ stopReason, errorMessage });
  });

  pi.on("agent_end", async (event) => {
    const messages = (event as any).messages as any[] | undefined;
    const last = messages?.[messages.length - 1];
    runtime.state?.onAgentEnd({
      stopReason: last?.stopReason,
      errorMessage: last?.errorMessage,
    });
  });

  pi.on("tool_execution_start", async (event) => {
    runtime.state?.onToolStart((event as any).toolName);
  });

  pi.on("tool_execution_end", async (event) => {
    runtime.state?.onToolEnd((event as any).toolName, Boolean((event as any).isError));
  });
}

async function installFromSettings(
  pi: ExtensionAPI,
  runtime: RuntimeContext,
  ctx: ExtensionContext,
): Promise<void> {
  runtime.widget?.uninstall();
  runtime.widget = undefined;

  const agentDir = getAgentDirOverride();
  runtime.settings = await loadSettings(agentDir);

  if (!runtime.settings.enabled || !ctx.hasUI) {
    runtime.state = undefined;
    return;
  }

  const load = loadPet(runtime.settings.selectedPet, { agentDir });
  const pet = load.pet;

  const capability = await detectPetCapability({
    env: process.env,
    execTmux: async (args) => {
      try {
        const result = await (ctx as any).exec("tmux", args, { timeoutMs: 5000 });
        return { ok: result.exitCode === 0, stdout: result.stdout, stderr: result.stderr };
      } catch (error) {
        return { ok: false, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
      }
    },
  });

  const choice = selectRenderer({ settings: runtime.settings, capability });
  if (choice.kind === "disabled") return;

  let frames;
  try {
    frames = await extractFrames(pet);
  } catch {
    // Fall back to ASCII when even the spritesheet decode fails.
    frames = undefined;
  }

  runtime.state = new PetState({
    waitingTools: WAITING_TOOLS,
    reviewLingerMs: REVIEW_LINGER_MS,
    failedLingerMs: FAILED_LINGER_MS,
  });

  const imageRenderer = choice.kind === "image"
    ? createImageRenderer({
        theme: { fallbackColor: (s) => s },
        wrapForTmux: choice.wrapForTmux,
      })
    : undefined;

  runtime.widget = installPetWidget({
    ctx,
    placement: runtime.settings.placement,
    componentFactory: (tui) =>
      createPetComponent({
        state: runtime.state!,
        tui: tui as any,
        animationsByState: pet.manifest.animations,
        renderFrame: (stateName, frameIndex, width) => {
          if (choice.kind === "image" && imageRenderer && frames) {
            const frame = frames[frameIndex];
            const base64 = Buffer.from(frame.rgba).toString("base64");
            return imageRenderer.render(
              { frameKey: `${pet.id}:${frameIndex}`, base64, mime: "image/png" },
              width,
            );
          }
          if (frames) {
            return renderBlockArt({
              state: stateName,
              animationFrame: frames[frameIndex],
              blockArt: pet.manifest.blockArt,
              trueColor: capability.trueColor,
            });
          }
          return FALLBACK_ASCII[stateName];
        },
      }),
  });
}
```

- [x] **Step 4: Run the tests**

Run:

```bash
npx vitest run extensions/pets/index.test.ts
npm test
npm run typecheck
```

Expected: PASS on all tests; whole suite green.

- [x] **Step 5: Commit**

```bash
git add extensions/pets/index.ts extensions/pets/index.test.ts
git commit -m "feat(pets): wire state, renderer, widget, and lifecycle events"
```

---

### Task 18: README and root docs

**Files:**
- Create: `extensions/pets/README.md`
- Modify: `README.md` (root)

- [x] **Step 1: Create the extension README**

Create `extensions/pets/README.md`:

```markdown
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

```
/pets set default
# then edit <agentDir>/pets.json:
#   "renderMode": "image" | "block-art" | "auto"
```

## Tmux + Kitty graphics

Image rendering is supported inside tmux through DCS passthrough. Requirements:

1. tmux 3.3 or newer.
2. `set -g allow-passthrough on` in `~/.tmux.conf`, then `tmux kill-server && tmux`.
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

## Files

- `<agentDir>/pets.json` — selected pet and rendering preferences.
- `<agentDir>/pets/<id>/` — custom pet packages.

## Future work

Generating new pet artwork from prompts is the responsibility of the
`imagegen` extension plus a future `pets` skill that drives image generation,
frame packing, and pet manifest creation; that work is independent of this
extension.

## Manual verification matrix

(See spec `docs/superpowers/specs/2026-05-26-codex-pets-extension-design.md`.)
```

- [x] **Step 2: Update root README**

Append to `README.md` at root, under the section that lists extensions, a
single bullet:

```markdown
- `extensions/pets`: ambient Codex-style terminal pet (Kitty graphics with
  block-art fallback; tmux opt-in via DCS passthrough).
```

- [x] **Step 3: Verify the suite still passes and types still check**

Run:

```bash
npm test
npm run typecheck
```

Expected: PASS, no errors.

- [x] **Step 4: Commit**

```bash
git add extensions/pets/README.md README.md
git commit -m "docs: document pets extension"
```

---

### Task 19: Final manual verification

This task does not produce code, but is the final gate before declaring the
plan done.

**Files:** none.

- [x] **Step 1: Run the full suite one more time**

Run:

```bash
npm test
npm run typecheck
```

Expected: all tests green, zero type errors.

- [x] **Step 2: Manually verify in at least one terminal**

In an interactive Pi session inside the current terminal:

```bash
pi install .
pi
# In Pi:
#   /pets diagnose
#   /pets
#   /pets set default
#   /pets tmux-passthrough on   # only if in tmux 3.3+ with allow-passthrough on
#   ask Pi to perform a small turn (e.g. "list files in cwd") and observe the
#   pet transitioning running → review → idle
#   /pets off
```

Expected, in order:

1. `/pets diagnose` prints the capability report with a clear decision.
2. `/pets` opens a `SelectList` overlay; selecting `default` writes
   `<agentDir>/pets.json`.
3. The pet appears below (or above, per settings) the editor and animates.
4. Asking Pi a small turn causes the pet to switch animation states.
5. `/pets off` removes the pet from the screen.

If any step fails, file a follow-up issue and link it in the README's
"Known issues" section. Do not patch over the issue in the same task — leave
the failing observation in the issue tracker for the next plan to address.

- [x] **Step 3: Tag the work as ready for review**

Run:

```bash
git log --oneline | head
```

Expected: A clean linear sequence of commits matching the task order above.
This plan is done.

---

## Self-review checklist (run before declaring done)

- [x] All tasks have explicit file paths, full code, and exact commands.
- [x] No `TODO`, `TBD`, "similar to above", or "add appropriate error handling"
  appears anywhere in the file (only the document's own intentional reference
  to `imagegen` future work in README, which is concrete).
- [x] Type names and method signatures used in later tasks (`PetState`,
  `loadPet`, `extractFrames`, `selectRenderer`, `createPetComponent`,
  `installPetWidget`, `handlePetsCommand`, `loadSettings`/`saveSettings`)
  match their declarations in earlier tasks.
- [x] Spec coverage: `default` pet bundling, manifest format with `blockArt`,
  `getAgentDir()`-rooted settings, capability detection, renderer selection
  matrix, Kitty graphics via pi-tui `Image`, tmux DCS passthrough wrapper,
  block-art renderer, state machine with linger + failed-from-active
  transitions, `/pets` subcommands, README with manual matrix.
- [x] Each task ends with a green-suite check and a commit.
