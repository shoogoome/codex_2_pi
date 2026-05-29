import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import petsExtension from "./index.js";

function fakePi() {
  const handlers: Record<string, Function> = {};
  return {
    handlers,
    api: {
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      registerMessageRenderer: vi.fn(),
      on: vi.fn((event: string, fn: Function) => {
        handlers[event] = fn;
      }),
      appendEntry: vi.fn(),
      sendMessage: vi.fn(),
      exec: vi.fn(async () => ({ exitCode: 1, stdout: "", stderr: "tmux not installed", code: 1 })),
    },
  };
}

function fakeCtx(_agentDir: string) {
  const ui = {
    setWidget: vi.fn(),
    notify: vi.fn(),
    theme: { fg: (_c: string, t: string) => t },
  };
  return {
    ui: ui as any,
    ctx: {
      hasUI: true,
      ui,
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
    } as any,
  };
}

describe("pets extension lifecycle", () => {
  it("installs the widget on session_start and removes it on session_shutdown", async () => {
    const pi = fakePi();
    await petsExtension(pi.api as any);

    const agentDir = mkdtempSync(join(tmpdir(), "pets-ext-"));
    writeFileSync(join(agentDir, "pets.json"), JSON.stringify({ selectedPet: "default", enabled: true, placement: "belowEditor", tmuxPassthrough: false, renderMode: "block-art" }));

    const { ctx, ui } = fakeCtx(agentDir);
    process.env.PI_PETS_AGENT_DIR = agentDir;
    try {
      await pi.handlers.session_start({ type: "session_start", reason: "startup" }, ctx);
      expect(ui.setWidget).toHaveBeenCalledWith("codex-pet", expect.any(Function), { placement: "belowEditor" });
      await pi.handlers.session_shutdown({ type: "session_shutdown" }, ctx);
      expect(ui.setWidget).toHaveBeenLastCalledWith("codex-pet", undefined, { placement: "belowEditor" });
    } finally {
      delete process.env.PI_PETS_AGENT_DIR;
    }
  });

  it("does not install the widget when settings.enabled is false", async () => {
    const pi = fakePi();
    await petsExtension(pi.api as any);
    const agentDir = mkdtempSync(join(tmpdir(), "pets-ext-"));
    writeFileSync(join(agentDir, "pets.json"), JSON.stringify({ selectedPet: "default", enabled: false, placement: "belowEditor", tmuxPassthrough: false, renderMode: "block-art" }));
    const { ctx, ui } = fakeCtx(agentDir);
    process.env.PI_PETS_AGENT_DIR = agentDir;
    try {
      await pi.handlers.session_start({ type: "session_start", reason: "startup" }, ctx);
      expect(ui.setWidget).not.toHaveBeenCalled();
    } finally {
      delete process.env.PI_PETS_AGENT_DIR;
    }
  });

  it("registers all relevant lifecycle handlers", async () => {
    const pi = fakePi();
    await petsExtension(pi.api as any);
    const events = (pi.api.on as any).mock.calls.map(([name]: [string]) => name);
    for (const event of [
      "session_start",
      "session_shutdown",
      "agent_start",
      "turn_start",
      "turn_end",
      "agent_end",
      "tool_execution_start",
      "tool_execution_end",
    ]) {
      expect(events).toContain(event);
    }
    const commands = (pi.api.registerCommand as any).mock.calls.map(([name]: [string]) => name);
    expect(commands).toContain("pets");
  });
});
