import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  createAgentSessionServices, createAgentSessionFromServices,
  SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import fastModeExtension from "../fast-mode/index.js";
import type { FastModeState } from "../fast-mode/core.js";
import { buildWorkerRuntime } from "./workerRuntime.js";
import { registerForkWorker } from "./workerIdentity.js";

// Exercise the real SDK extension runner without model requests, credentials,
// globally installed extensions, or the leader's session_start lifecycle.
it("SDK child applies parent routing and leaf gates without bindExtensions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-worker-runtime-"));
  const sm = SessionManager.create(dir, dir);
  const release = registerForkWorker(sm.getSessionFile()!);
  let session: Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"] | undefined;
  let state: FastModeState = { enabled: true, tier: "priority" };
  const startup = vi.fn();
  try {
    const services = await createAgentSessionServices({
      cwd: dir, agentDir: dir, settingsManager: SettingsManager.inMemory(),
      resourceLoaderOptions: {
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        extensionFactories: [
          (pi) => {
            fastModeExtension(pi, { loadSettings: () => ({ mode: "ultrafast", warnings: [] }) });
            pi.on("session_start", startup);
          },
          buildWorkerRuntime(() => state),
        ],
      },
    });
    vi.spyOn(services.modelRuntime, "isUsingOAuth").mockReturnValue(true);
    const model = { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.6-sol",
      name: "test", reasoning: true, input: ["text"], contextWindow: 128000, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as const;
    ({ session } = await createAgentSessionFromServices({ services, sessionManager: sm, model: model as never, thinkingLevel: "high", tools: [] }));
    expect(services.diagnostics).toEqual([]);
    expect(startup).not.toHaveBeenCalled();
    expect(session.model).toBe(model);
    expect(session.thinkingLevel).toBe("high");
    const request = () => session!.extensionRunner.emitBeforeProviderRequest({ model: model.id, input: [] });
    expect(await request()).toMatchObject({ service_tier: "priority" });
    state = { enabled: true, tier: "ultrafast" };
    expect(await request()).toMatchObject({ service_tier: "ultrafast" });
    // A real compaction event restores child-local defaults; those must not win.
    await session.extensionRunner.emit({
      type: "session_compact", fromExtension: false, reason: "threshold", willRetry: false,
      compactionEntry: {
        type: "compaction", id: "compact-test", parentId: null, timestamp: new Date().toISOString(),
        summary: "test", firstKeptEntryId: "compact-test", tokensBefore: 100,
      },
    });
    state = { enabled: false };
    expect(await request()).not.toHaveProperty("service_tier");
    for (const toolName of ["task_agent", "team_create"]) {
      expect(await session.extensionRunner.emitToolCall({ type: "tool_call", toolName, toolCallId: "nested", input: { team_name: "a", name: "b" } } as never)).toMatchObject({ block: true });
    }
    expect(startup).not.toHaveBeenCalled();
  } finally {
    session?.dispose();
    release();
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  }
});


it("cancels delayed SDK input after close/dispose without starting a provider request", async () => {
  const { guardWorkerStream } = await import("./workerRuntime.js");
  const dir = await mkdtemp(join(tmpdir(), "pi-worker-input-"));
  let release!: () => void;
  let entered!: () => void;
  const enteredHook = new Promise<void>((resolve) => { entered = resolve; });
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  let open = true;
  let session: Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"] | undefined;
  try {
    const services = await createAgentSessionServices({
      cwd: dir, agentDir: dir, settingsManager: SettingsManager.inMemory(),
      resourceLoaderOptions: {
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        extensionFactories: [
          (pi) => { pi.on("input", async () => { entered(); await barrier; }); },
          buildWorkerRuntime(() => ({ enabled: false }), () => open),
        ],
      },
    });
    ({ session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(dir), tools: [] }));
    const request = vi.fn(() => { throw new Error("must not execute"); });
    session.agent.streamFunction = request;
    guardWorkerStream(session, () => open);
    const pending = session.prompt("delayed input", { expandPromptTemplates: false });
    await enteredHook;
    open = false;
    await session.abort();
    session.dispose();
    release();
    await pending;
    expect(request).not.toHaveBeenCalled();
    expect(() => session!.agent.streamFunction({} as never, {} as never)).toThrow(/closed/);
    expect(request).not.toHaveBeenCalled();
  } finally {
    open = false; release?.(); session?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
