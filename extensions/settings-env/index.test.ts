import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadSettingsEnv,
  parseSettingsJson,
} from "./src/settingsEnv.js";

function makeFixture(): { cwd: string; agentDir: string } {
  const root = mkdtempSync(join(tmpdir(), "pi-settings-env-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  return { cwd, agentDir };
}

describe("parseSettingsJson", () => {
  it("支持 Pi settings.json 中的注释和尾逗号", () => {
    expect(
      parseSettingsJson(`{
        // comment
        "env": {
          "URL": "https://example.com/a//b", /* comment */
        },
      }`),
    ).toEqual({ env: { URL: "https://example.com/a//b" } });
  });
});

describe("loadSettingsEnv", () => {
  it("读取全局和项目 env，且项目值覆盖全局值", () => {
    const { cwd, agentDir } = makeFixture();
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ env: { GLOBAL_ONLY: "global", SHARED: "global" } }),
    );
    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({ env: { PROJECT_ONLY: 42, SHARED: "project", FLAG: true } }),
    );
    const environ: NodeJS.ProcessEnv = {};

    const result = loadSettingsEnv({ cwd, agentDir, environ });

    expect(environ).toEqual({
      GLOBAL_ONLY: "global",
      SHARED: "project",
      PROJECT_ONLY: "42",
      FLAG: "true",
    });
    expect(result.loaded).toEqual([
      "GLOBAL_ONLY",
      "SHARED",
      "PROJECT_ONLY",
      "FLAG",
    ]);
    expect(result.skipped).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("默认不覆盖启动 Pi 时已有的环境变量", () => {
    const { cwd, agentDir } = makeFixture();
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ env: { API_KEY: "from-settings", ADDED: "yes" } }),
    );
    const environ: NodeJS.ProcessEnv = { API_KEY: "from-shell" };

    const result = loadSettingsEnv({ cwd, agentDir, environ });

    expect(environ).toEqual({ API_KEY: "from-shell", ADDED: "yes" });
    expect(result.loaded).toEqual(["ADDED"]);
    expect(result.skipped).toEqual(["API_KEY"]);
  });

  it("envOverride=true 时覆盖已有环境变量", () => {
    const { cwd, agentDir } = makeFixture();
    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({ envOverride: true, env: { API_KEY: "from-settings" } }),
    );
    const environ: NodeJS.ProcessEnv = { API_KEY: "from-shell" };

    const result = loadSettingsEnv({ cwd, agentDir, environ });

    expect(environ.API_KEY).toBe("from-settings");
    expect(result.loaded).toEqual(["API_KEY"]);
    expect(result.skipped).toEqual([]);
  });

  it("无效配置产生警告，不阻止其他 settings 文件生效", () => {
    const { cwd, agentDir } = makeFixture();
    writeFileSync(join(agentDir, "settings.json"), "{ invalid");
    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({
        env: { VALID: "ok", INVALID: { nested: true } },
        envOverride: "yes",
      }),
    );
    const environ: NodeJS.ProcessEnv = {};

    const result = loadSettingsEnv({ cwd, agentDir, environ });

    expect(environ).toEqual({ VALID: "ok" });
    expect(result.warnings).toHaveLength(3);
    expect(result.warnings[0]).toContain("无法解析");
    expect(result.warnings[1]).toContain("envOverride 必须是 boolean");
    expect(result.warnings[2]).toContain("env.INVALID");
  });
});
