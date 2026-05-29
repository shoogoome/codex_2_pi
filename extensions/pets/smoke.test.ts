/**
 * Smoke test that exercises the pets extension entry-point against an empty
 * agent dir. Not part of the regular test suite; run with:
 *   npx vitest run extensions/pets/smoke.test.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import petsExtension from "./index.js";

describe("pets smoke", () => {
  it("renders the default pet through state transitions", async () => {
    const handlers: Record<string, Function> = {};
    let widgetFactory: any;
    const ui = {
      setWidget: (key: string, factory: any) => {
        if (factory) widgetFactory = factory;
      },
      notify: vi.fn(),
      theme: { fg: (_c: string, t: string) => t },
    };
    const piApi: any = {
      on: (event: string, fn: Function) => {
        handlers[event] = fn;
      },
      registerCommand: () => {},
      registerTool: () => {},
      registerMessageRenderer: () => {},
      appendEntry: () => {},
      sendMessage: () => {},
      exec: vi.fn(async () => ({ stdout: "", stderr: "no tmux", code: 1, killed: false })),
    };
    await petsExtension(piApi);

    const agentDir = mkdtempSync(join(tmpdir(), "pets-smoke-"));
    process.env.PI_PETS_AGENT_DIR = agentDir;
    try {
      const ctx: any = {
        hasUI: true,
        ui,
        cwd: process.cwd(),
        sessionManager: {},
        isIdle: () => true,
        signal: undefined,
        abort: () => {},
        hasPendingMessages: () => false,
        shutdown: () => {},
        getContextUsage: () => undefined,
        compact: () => {},
        getSystemPrompt: () => "",
        appendEntry: () => {},
      };
      await handlers.session_start({ type: "session_start", reason: "startup" }, ctx);
      expect(widgetFactory).toBeDefined();

      const fakeTui = { requestRender: vi.fn() };
      const fakeTheme = {
        fg: (_c: string, t: string) => t,
        bg: (_c: string, t: string) => t,
        bold: (t: string) => t,
      };
      const component = widgetFactory(fakeTui, fakeTheme);

      // Wait long enough for the optional async frame extraction.
      await new Promise((r) => setTimeout(r, 200));

      const idleLines = component.render(40);
      expect(Array.isArray(idleLines)).toBe(true);
      expect(idleLines.length).toBeGreaterThan(0);

      await handlers.agent_start({ type: "agent_start" }, ctx);
      await new Promise((r) => setTimeout(r, 50));
      const runningLines = component.render(40);
      expect(runningLines.length).toBeGreaterThan(0);

      await handlers.turn_end(
        { type: "turn_end", message: { stopReason: "stop", errorMessage: undefined } },
        ctx,
      );
      await new Promise((r) => setTimeout(r, 50));
      const reviewLines = component.render(40);
      expect(reviewLines.length).toBeGreaterThan(0);

      await handlers.session_shutdown({ type: "session_shutdown" }, ctx);
    } finally {
      delete process.env.PI_PETS_AGENT_DIR;
      rmSync(agentDir, { recursive: true, force: true });
    }
  });
});
