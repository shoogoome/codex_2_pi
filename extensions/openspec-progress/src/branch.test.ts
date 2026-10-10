import { describe, expect, it } from "vitest";
import { extractApplyChangeFromInput, lastApplyChange } from "./branch.js";

describe("OpenSpec apply branch replay", () => {
  it("returns the last apply change from user messages", () => {
    const entries = [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "/opsx-apply first-change" }] } },
      { type: "message", message: { role: "assistant", content: "ok" } },
      { type: "message", message: { role: "user", content: "/opsx-apply second-change --continue" } },
    ];
    expect(lastApplyChange(entries)).toBe("second-change");
  });

  it("ignores malformed or absent commands", () => {
    expect(lastApplyChange([{ type: "message", message: { role: "user", content: "/opsx-apply" } }])).toBeUndefined();
    expect(extractApplyChangeFromInput("please /opsx-apply demo-change now")).toBe("demo-change");
  });
});
