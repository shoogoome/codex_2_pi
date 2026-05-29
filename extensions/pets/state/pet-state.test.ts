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
