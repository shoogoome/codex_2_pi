import { describe, it, expect } from "vitest";
import { runAsTeammate, getCurrentTeammate, _resetForTest } from "./als.js";
import type { TeammateIdentity } from "./types.js";

const id = (overrides: Partial<TeammateIdentity> = {}): TeammateIdentity => ({
  agentId: "a@t",
  agentName: "a",
  teamName: "t",
  agentType: "general-purpose",
  ...overrides,
});

describe("AsyncLocalStorage isolation", () => {
  it("getCurrentTeammate returns undefined outside runAsTeammate", () => {
    _resetForTest();
    expect(getCurrentTeammate()).toBeUndefined();
  });

  it("getCurrentTeammate returns identity inside runAsTeammate", () => {
    runAsTeammate(id({ agentName: "alpha" }), () => {
      expect(getCurrentTeammate()?.agentName).toBe("alpha");
    });
  });

  it("survives across awaits and microtasks", async () => {
    const target = id({ agentName: "beta" });
    await new Promise<void>((resolve, reject) => {
      runAsTeammate(target, async () => {
        try {
          await Promise.resolve();
          await new Promise((r) => setTimeout(r, 0));
          expect(getCurrentTeammate()?.agentName).toBe("beta");
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
  });

  it("nested runs override correctly", () => {
    const a = id({ agentName: "outer" });
    const b = id({ agentName: "inner" });
    runAsTeammate(a, () => {
      runAsTeammate(b, () => {
        expect(getCurrentTeammate()?.agentName).toBe("inner");
      });
      expect(getCurrentTeammate()?.agentName).toBe("outer");
    });
  });

  it("returns the function's return value", () => {
    const result = runAsTeammate(id(), () => 42);
    expect(result).toBe(42);
  });

  it("propagates exceptions thrown inside fn", () => {
    expect(() => {
      runAsTeammate(id(), () => {
        throw new Error("boom");
      });
    }).toThrow("boom");
  });
});
