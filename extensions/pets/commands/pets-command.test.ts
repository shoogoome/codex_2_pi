import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { handlePetsCommand } from "./pets-command.js";

function makeCtx(_agentDir: string) {
  return {
    hasUI: false,
    ui: { notify: vi.fn() },
    exec: vi.fn(async () => ({ exitCode: 1, stdout: "", stderr: "tmux not installed" })),
    cwd: process.cwd(),
    sessionManager: {} as any,
    isIdle: () => true,
    signal: undefined,
    abort: () => {},
    hasPendingMessages: () => false,
    shutdown: () => {},
    getContextUsage: () => undefined,
    compact: () => {},
    getSystemPrompt: () => "",
    appendEntry: () => {},
  } as any;
}

describe("handlePetsCommand", () => {
  it("`/pets set <id>` writes settings on disk", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pets-cmd-"));
    const ctx = makeCtx(agentDir);
    await handlePetsCommand("set default", ctx, { agentDir });
    const json = JSON.parse(readFileSync(join(agentDir, "pets.json"), "utf8"));
    expect(json.selectedPet).toBe("default");
    expect(json.enabled).toBe(true);
  });

  it("`/pets off` toggles enabled=false", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pets-cmd-"));
    const ctx = makeCtx(agentDir);
    await handlePetsCommand("off", ctx, { agentDir });
    const json = JSON.parse(readFileSync(join(agentDir, "pets.json"), "utf8"));
    expect(json.enabled).toBe(false);
  });

  it("`/pets on` re-enables and keeps the previous selection", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pets-cmd-"));
    const ctx = makeCtx(agentDir);
    await handlePetsCommand("set default", ctx, { agentDir });
    await handlePetsCommand("off", ctx, { agentDir });
    await handlePetsCommand("on", ctx, { agentDir });
    const json = JSON.parse(readFileSync(join(agentDir, "pets.json"), "utf8"));
    expect(json.enabled).toBe(true);
    expect(json.selectedPet).toBe("default");
  });

  it("`/pets tmux-passthrough on` sets the flag", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pets-cmd-"));
    const ctx = makeCtx(agentDir);
    await handlePetsCommand("tmux-passthrough on", ctx, { agentDir });
    const json = JSON.parse(readFileSync(join(agentDir, "pets.json"), "utf8"));
    expect(json.tmuxPassthrough).toBe(true);
  });

  it("`/pets diagnose` calls ui.notify with a report", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pets-cmd-"));
    const ctx = makeCtx(agentDir);
    await handlePetsCommand("diagnose", ctx, { agentDir });
    expect(ctx.ui.notify).toHaveBeenCalled();
    const text = ctx.ui.notify.mock.calls[0][0] as string;
    expect(text).toMatch(/selected pet/);
    expect(text).toMatch(/render mode/);
  });

  it("`/pets set <id>` for an unknown id reports an error and leaves settings unchanged", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pets-cmd-"));
    const ctx = makeCtx(agentDir);
    await handlePetsCommand("set bogus", ctx, { agentDir });
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/unknown pet/), "error");
    expect(() => readFileSync(join(agentDir, "pets.json"), "utf8")).toThrow();
  });
});

describe("handlePetsCommand interactive picker", () => {
  it("`/pets` opens a SelectList overlay listing built-ins and disable entry", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pets-cmd-"));
    const customCall = vi.fn(async (factory: any) => {
      const fakeTui = { requestRender: vi.fn() } as any;
      const fakeTheme = {
        fg: (_color: string, t: string) => t,
        bg: (_color: string, t: string) => t,
        bold: (t: string) => t,
      };
      const done = (_value: string | null) => {};
      const component = factory(fakeTui, fakeTheme, undefined, done);
      const items = (component as any).__items as Array<{ value: string }>;
      expect(items.map((item) => item.value)).toEqual(["disabled", "default"]);
      return "default";
    });

    const ctx: any = {
      hasUI: true,
      ui: { notify: vi.fn(), custom: customCall, setWidget: vi.fn() },
      sessionManager: {},
    };
    await handlePetsCommand("", ctx, { agentDir });
    expect(customCall).toHaveBeenCalled();
    const json = JSON.parse(readFileSync(join(agentDir, "pets.json"), "utf8"));
    expect(json.selectedPet).toBe("default");
  });
});
