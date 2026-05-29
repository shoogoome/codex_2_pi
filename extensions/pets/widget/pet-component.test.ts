import { describe, expect, it, vi } from "vitest";
import { PetState } from "../state/pet-state.js";
import { createPetComponent } from "./pet-component.js";

function makeState() {
  return new PetState({
    waitingTools: ["request_user_input"],
    reviewLingerMs: 1000,
    failedLingerMs: 1000,
    schedule: (_d, _fn) => {
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
