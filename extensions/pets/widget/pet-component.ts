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
