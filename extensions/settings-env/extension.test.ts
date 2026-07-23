import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("settings-env extension", () => {
  const roots: string[] = [];

  afterEach(() => {
    delete process.env.SETTINGS_ENV_RELOAD_TEST;
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock("@earendil-works/pi-coding-agent");
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("reloads settings on session_start so /reload sees updated env", async () => {
    const root = mkdtempSync(join(tmpdir(), "settings-env-extension-"));
    roots.push(root);
    const cwd = join(root, "project");
    const agentDir = join(root, "agent");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ env: { SETTINGS_ENV_RELOAD_TEST: "first" } }),
    );

    vi.doMock("@earendil-works/pi-coding-agent", () => ({ getAgentDir: () => agentDir }));
    let sessionStart: ((event: unknown, ctx: { cwd: string }) => void) | undefined;
    const pi = {
      on: vi.fn((event: string, handler: (event: unknown, ctx: { cwd: string }) => void) => {
        if (event === "session_start") sessionStart = handler;
      }),
    };

    const { default: extension } = await import("./index.js");
    extension(pi as never);
    expect(process.env.SETTINGS_ENV_RELOAD_TEST).toBe("first");

    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ envOverride: true, env: { SETTINGS_ENV_RELOAD_TEST: "second" } }),
    );
    sessionStart?.({}, { cwd });

    expect(process.env.SETTINGS_ENV_RELOAD_TEST).toBe("second");
  });

  it("does not throw when settings are invalid", async () => {
    const root = mkdtempSync(join(tmpdir(), "settings-env-extension-invalid-"));
    roots.push(root);
    const agentDir = join(root, "agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "settings.json"), "{not-json");
    vi.doMock("@earendil-works/pi-coding-agent", () => ({ getAgentDir: () => agentDir }));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const { default: extension } = await import("./index.js");
    expect(() => extension({ on: vi.fn() } as never)).not.toThrow();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("[settings-env]"));
  });
});
