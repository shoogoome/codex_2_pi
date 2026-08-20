import { describe, expect, it, vi } from "vitest";
import {
  applyWorkingIndicatorPerformancePolicy,
  shouldUseStaticWorkingIndicator,
  STATIC_WORKING_INDICATOR_ENTRY_THRESHOLD,
} from "./working-indicator.js";

describe("working indicator performance policy", () => {
  it("keeps the animated default for short sessions", () => {
    expect(shouldUseStaticWorkingIndicator(STATIC_WORKING_INDICATOR_ENTRY_THRESHOLD - 1)).toBe(
      false,
    );
  });

  it("uses a static indicator for long sessions", () => {
    expect(shouldUseStaticWorkingIndicator(STATIC_WORKING_INDICATOR_ENTRY_THRESHOLD)).toBe(true);
  });

  it("sets a single-frame indicator only for long branches", () => {
    const setWorkingIndicator = vi.fn();
    const shortContext = {
      sessionManager: { getBranch: () => Array(10) },
      ui: { setWorkingIndicator },
    };
    const longContext = {
      sessionManager: {
        getBranch: () => Array(STATIC_WORKING_INDICATOR_ENTRY_THRESHOLD),
      },
      ui: { setWorkingIndicator },
    };

    expect(applyWorkingIndicatorPerformancePolicy(shortContext as never)).toBe(false);
    expect(setWorkingIndicator).not.toHaveBeenCalled();

    expect(applyWorkingIndicatorPerformancePolicy(longContext as never)).toBe(true);
    expect(setWorkingIndicator).toHaveBeenCalledWith({ frames: ["●"] });
  });
});
