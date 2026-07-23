import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { loadPluginHooks, mergeHooksConfig, substitutePluginHookVars } from "./pluginHooks.js";

const descriptor = {
  plugin: "demo",
  path: "",
  root: "/plugins/demo",
  data: "/data/demo",
  userConfig: { mode: "strict" },
};

describe("plugin hooks", () => {
  it("substitutes root, data and user config", () => {
    expect(substitutePluginHookVars("${CLAUDE_PLUGIN_ROOT}/x ${CLAUDE_PLUGIN_DATA} ${user_config.mode}", descriptor))
      .toBe("/plugins/demo/x /data/demo strict");
  });

  it("loads wrapped Claude hooks and merges them", () => {
    const root = mkdtempSync(join(tmpdir(), "plugin-hooks-"));
    const path = join(root, "hooks.json");
    writeFileSync(path, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/check" }] }] } }));
    const plugin = loadPluginHooks([{ ...descriptor, path }]);
    expect(plugin.PreToolUse?.[0]?.hooks[0]).toMatchObject({ command: "/plugins/demo/check" });
    expect(mergeHooksConfig({ Stop: [{ hooks: [{ type: "command", command: "x" }] }] }, plugin).Stop).toHaveLength(1);
  });
});
