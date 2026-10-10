import { describe, expect, it } from "vitest";
import { OPENSPEC_PROGRESS_ENTRY, restoreState, setChange, setVisible } from "./state.js";

describe("OpenSpec progress state", () => {
  it("restores branch apply and last persisted visibility", () => {
    const entries = [
      { type: "message", message: { role: "user", content: "/opsx-apply demo-change" } },
      { type: "custom", customType: OPENSPEC_PROGRESS_ENTRY, data: { visible: false, updatedAt: 1 } },
    ];
    expect(restoreState(entries)).toMatchObject({ change: "demo-change", visible: false });
  });

  it("prefers explicit binding", () => {
    const entries = [
      { type: "message", message: { role: "user", content: "/opsx-apply auto-change" } },
      { type: "custom", customType: OPENSPEC_PROGRESS_ENTRY, data: { change: "manual-change", explicitChange: "manual-change", visible: true } },
    ];
    expect(restoreState(entries).change).toBe("manual-change");
  });

  it("updates visibility and explicit change", () => {
    const state = restoreState([]);
    expect(setVisible(state, false).visible).toBe(false);
    expect(setChange(state, "manual")).toMatchObject({ change: "manual", explicitChange: "manual", visible: true });
  });
});
