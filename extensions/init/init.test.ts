import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import initExtension from "./index.js";
import { buildInitPrompt } from "./init-prompt.js";

function makePi() {
  const commands = new Map<string, any>();
  return {
    commands,
    sendUserMessage: vi.fn(),
    registerCommand(name: string, command: any) {
      commands.set(name, command);
    },
  };
}

describe("/init command", () => {
  it("builds a prompt that asks for AGENTS.md", () => {
    expect(buildInitPrompt()).toContain("AGENTS.md");
    expect(buildInitPrompt()).toContain("Inspect this project");
  });

  it("skips when AGENTS.md exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-init-"));
    try {
      await writeFile(join(dir, "AGENTS.md"), "existing");
      const pi = makePi();
      initExtension(pi as any);
      const notify = vi.fn();

      await pi.commands.get("init").handler("", { cwd: dir, isIdle: () => true, ui: { notify } });

      expect(pi.sendUserMessage).not.toHaveBeenCalled();
      expect(notify).toHaveBeenCalledWith("AGENTS.md already exists here. Skipping /init to avoid overwriting it.", "info");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("sends init prompt when AGENTS.md is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-init-"));
    try {
      const pi = makePi();
      initExtension(pi as any);

      await pi.commands.get("init").handler("", { cwd: dir, isIdle: () => true, ui: { notify: vi.fn() } });

      expect(pi.sendUserMessage).toHaveBeenCalledWith(buildInitPrompt());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("warns when agent is busy", async () => {
    const pi = makePi();
    initExtension(pi as any);
    const notify = vi.fn();

    await pi.commands.get("init").handler("", { cwd: "/repo", isIdle: () => false, ui: { notify } });

    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith("Agent is busy. Run /init when idle.", "warning");
  });
});
