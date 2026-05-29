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
