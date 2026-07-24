// extensions/context-pipeline/src/config.test.ts
import { describe, it, expect } from "vitest";
import { DEFAULTS, loadConfig } from "./config.js";

describe("loadConfig pruneMode", () => {
  it("defaults to manual when the env var is absent or invalid", () => {
    expect(DEFAULTS.pruneMode).toBe("manual");
    expect(loadConfig({}).pruneMode).toBe("manual");
    expect(loadConfig({ PI_CTXPIPE_PRUNE_MODE: "bogus" }).pruneMode).toBe("manual");
    expect(loadConfig({ PI_CTXPIPE_PRUNE_MODE: "" }).pruneMode).toBe("manual");
  });

  it("parses auto/manual case-insensitively", () => {
    expect(loadConfig({ PI_CTXPIPE_PRUNE_MODE: "auto" }).pruneMode).toBe("auto");
    expect(loadConfig({ PI_CTXPIPE_PRUNE_MODE: " AUTO " }).pruneMode).toBe("auto");
    expect(loadConfig({ PI_CTXPIPE_PRUNE_MODE: "manual" }).pruneMode).toBe("manual");
  });
});
