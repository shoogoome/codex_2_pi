import { coordinatorCliValue, effectiveMode, parseMode, resolveMode } from "./mode.js";
describe("coordinator mode selection", () => {
  it.each(["1", "true", "ON", " True "])("accepts enabled %s", value => expect(parseMode(value)).toBe(true));
  it.each(["0", "false", "OFF", " False "])("accepts disabled %s", value => expect(parseMode(value)).toBe(false));
  it.each(["", undefined, "invalid"])("leaves invalid/unset %s undefined", value => expect(parseMode(value)).toBeUndefined());
  it("recovers explicit false from real CLI argv even when the SDK returns true", () => {
    expect(coordinatorCliValue(true, ["--coordinator=false"])).toBe(false);
    expect(coordinatorCliValue(undefined, ["--coordinator"])).toBe(true);
    expect(coordinatorCliValue(true, ["--coordinator=off"])).toBe(false);
    expect(coordinatorCliValue(false, [])).toBe(false);
    expect(coordinatorCliValue(undefined, [])).toBeUndefined();
    expect(coordinatorCliValue(true, ["--", "--coordinator=false"])).toBe(true);
    expect(() => coordinatorCliValue(true, ["--coordinator=garbage"])).toThrow(/Invalid/);
  });
  it("honors CLI including false, saved choice, env and default", () => {
    const saved = { schemaVersion: 1, enabled: true, source: "command" } as const;
    expect(resolveMode(false, saved, "on")).toMatchObject({ enabled: false, source: "cli" });
    expect(resolveMode(undefined, saved, "off")).toMatchObject({ enabled: true, source: "saved" });
    expect(resolveMode(undefined, undefined, "on")).toMatchObject({ enabled: true, source: "environment" });
    expect(resolveMode(undefined, undefined, "")).toMatchObject({ enabled: false, source: "default" });
  });
  it("pauses without changing the desired mode or loadout", () => {
    expect(effectiveMode(true, ["exit_plan_mode"], ["task_agent"], true, true)).toBe("paused-plan");
    expect(effectiveMode(true, [], ["task_agent"], true)).toBe("paused-task-agent-inactive");
    expect(effectiveMode(true, [], [], true)).toBe("paused-task-agent-unavailable");
    expect(effectiveMode(true, ["task_agent"], ["task_agent"], false)).toBe("paused-session-unpersisted");
    expect(effectiveMode(true, ["task_agent"], ["task_agent"], true)).toBe("active");
  });
});
