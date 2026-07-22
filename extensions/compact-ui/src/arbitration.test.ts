import { describe, expect, it } from "vitest";
import {
  CLAUDE_UI_FLAG,
  COMPACT_UI_FLAG,
  createFlagGetter,
  shouldActivateCompactUi,
} from "./arbitration.js";

function getFlagFrom(values: Record<string, unknown>) {
  return (name: string): unknown => values[name];
}

describe("shouldActivateCompactUi", () => {
  it("yields (false) when claude-ui is enabled", () => {
    expect(shouldActivateCompactUi(getFlagFrom({ [CLAUDE_UI_FLAG]: true }))).toBe(
      false,
    );
  });

  it("yields (false) when the claude-ui flag is unregistered (undefined = default on)", () => {
    expect(shouldActivateCompactUi(getFlagFrom({}))).toBe(false);
  });

  it("activates (true) when claude-ui is explicitly disabled", () => {
    expect(
      shouldActivateCompactUi(getFlagFrom({ [CLAUDE_UI_FLAG]: false })),
    ).toBe(true);
  });

  it("still yields when claude-ui enabled even if compact-ui is on", () => {
    expect(
      shouldActivateCompactUi(
        getFlagFrom({ [CLAUDE_UI_FLAG]: true, [COMPACT_UI_FLAG]: true }),
      ),
    ).toBe(false);
  });

  it("yields when claude-ui disabled but compact-ui is explicitly disabled", () => {
    expect(
      shouldActivateCompactUi(
        getFlagFrom({ [CLAUDE_UI_FLAG]: false, [COMPACT_UI_FLAG]: false }),
      ),
    ).toBe(false);
  });

  it("activates when claude-ui disabled and compact-ui flag unset (defaults on)", () => {
    expect(
      shouldActivateCompactUi(getFlagFrom({ [CLAUDE_UI_FLAG]: false })),
    ).toBe(true);
  });
});

describe("createFlagGetter", () => {
  it("delegates to pi.getFlag", () => {
    const getFlag = createFlagGetter({
      getFlag: (name: string) => (name === CLAUDE_UI_FLAG ? false : undefined),
    } as never);
    expect(getFlag(CLAUDE_UI_FLAG)).toBe(false);
    expect(getFlag(COMPACT_UI_FLAG)).toBeUndefined();
  });

  it("never throws — returns undefined when pi.getFlag throws", () => {
    const getFlag = createFlagGetter({
      getFlag: () => {
        throw new Error("flag registry not ready");
      },
    } as never);
    expect(getFlag(CLAUDE_UI_FLAG)).toBeUndefined();
  });
});
