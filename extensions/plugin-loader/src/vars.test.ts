import { describe, it, expect } from "vitest";
import { substituteVars, substituteDeep, pluginVars, CLAUDE_PLUGIN_ROOT_VAR } from "./vars.js";

const ROOT = "/home/u/.pi/agent/plugins/demo";
const vars = { [CLAUDE_PLUGIN_ROOT_VAR]: ROOT };

describe("substituteVars", () => {
  it("replaces braced ${CLAUDE_PLUGIN_ROOT}", () => {
    expect(substituteVars("${CLAUDE_PLUGIN_ROOT}/bin/run", vars)).toBe(`${ROOT}/bin/run`);
  });

  it("replaces bare $CLAUDE_PLUGIN_ROOT", () => {
    expect(substituteVars("$CLAUDE_PLUGIN_ROOT/x", vars)).toBe(`${ROOT}/x`);
  });

  it("replaces multiple occurrences", () => {
    const out = substituteVars("${CLAUDE_PLUGIN_ROOT}:a:${CLAUDE_PLUGIN_ROOT}", vars);
    expect(out).toBe(`${ROOT}:a:${ROOT}`);
  });

  it("leaves an absent var intact", () => {
    expect(substituteVars("${OTHER_VAR}/x", vars)).toBe("${OTHER_VAR}/x");
  });

  it("is a no-op with no placeholder", () => {
    expect(substituteVars("plain text", vars)).toBe("plain text");
  });

  it("does not touch a longer identifier prefixed by the var", () => {
    expect(substituteVars("$CLAUDE_PLUGIN_ROOT_EXTRA", vars)).toBe("$CLAUDE_PLUGIN_ROOT_EXTRA");
  });

  it("passes through non-strings and empty strings", () => {
    expect(substituteVars(42, vars)).toBe(42);
    expect(substituteVars("", vars)).toBe("");
    expect(substituteVars(undefined, vars)).toBe(undefined);
  });
});

describe("substituteDeep", () => {
  it("substitutes through nested args arrays", () => {
    const input = {
      command: "${CLAUDE_PLUGIN_ROOT}/server",
      args: ["--root", "${CLAUDE_PLUGIN_ROOT}/data"],
      env: { PATH: "$CLAUDE_PLUGIN_ROOT/bin" },
    };
    expect(substituteDeep(input, vars)).toEqual({
      command: `${ROOT}/server`,
      args: ["--root", `${ROOT}/data`],
      env: { PATH: `${ROOT}/bin` },
    });
  });

  it("does not mutate the input", () => {
    const input = { a: "${CLAUDE_PLUGIN_ROOT}" };
    substituteDeep(input, vars);
    expect(input.a).toBe("${CLAUDE_PLUGIN_ROOT}");
  });
});

describe("pluginVars", () => {
  it("builds the standard record", () => {
    expect(pluginVars(ROOT)).toEqual({ CLAUDE_PLUGIN_ROOT: ROOT });
  });
});
