import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installChannelExtension } from "./index.js";

interface Harness {
  pi: Record<string, unknown>;
  handlers: Map<string, (event: unknown, ctx: any) => unknown>;
  commands: Map<string, { handler: (args: string, ctx: any) => unknown }>;
  sendMessage: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
  ctx: any;
}

function buildHarness(): Harness {
  const handlers = new Map<string, (event: unknown, ctx: any) => unknown>();
  const commands = new Map<string, { handler: (args: string, ctx: any) => unknown }>();
  const defaults = new Map<string, boolean | string | undefined>();
  const sendMessage = vi.fn();
  const notify = vi.fn();
  const pi = {
    registerFlag(name: string, options: { default?: boolean | string }) {
      defaults.set(name, options.default);
    },
    getFlag(name: string) {
      return defaults.get(name);
    },
    on(name: string, handler: (event: unknown, ctx: any) => unknown) {
      handlers.set(name, handler);
    },
    registerCommand(name: string, command: { handler: (args: string, ctx: any) => unknown }) {
      commands.set(name, command);
    },
    registerMessageRenderer: vi.fn(),
    sendMessage,
  };
  const ctx = {
    cwd: "/repo",
    hasUI: true,
    ui: { notify },
    sessionManager: { getSessionId: () => "session-1" },
  };
  return { pi, handlers, commands, sendMessage, notify, ctx };
}

const tempRoots: string[] = [];
afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("channel extension entrypoint", () => {
  it("registers lifecycle, command, renderer, and remains quiet without a token", async () => {
    const harness = buildHarness();
    installChannelExtension(harness.pi as never, { env: {}, agentDir: "/unused" });

    expect(harness.handlers.has("session_start")).toBe(true);
    expect(harness.handlers.has("session_shutdown")).toBe(true);
    expect(harness.commands.has("channel")).toBe(true);

    await harness.handlers.get("session_start")!({}, harness.ctx);
    expect(harness.notify).not.toHaveBeenCalled();

    await harness.commands.get("channel")!.handler("status", harness.ctx);
    expect(harness.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("PI_CHANNEL_TOKEN is not configured"),
      "info",
    );
  });

  it("accepts HTTP input, injects it into Pi, writes discovery, and cleans up", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-channel-index-"));
    tempRoots.push(agentDir);
    const harness = buildHarness();
    installChannelExtension(harness.pi as never, {
      env: {
        PI_CHANNEL_TOKEN: "integration-token",
        PI_CHANNEL_HOST: "127.0.0.1",
        PI_CHANNEL_PORT: "0",
      },
      agentDir,
    });

    await harness.handlers.get("session_start")!({}, harness.ctx);
    const files = await readdir(join(agentDir, "channels"));
    expect(files).toHaveLength(1);
    const discoveryPath = join(agentDir, "channels", files[0]!);
    const discovery = JSON.parse(await readFile(discoveryPath, "utf8")) as {
      port: number;
      sessionId: string;
    };
    expect(discovery.sessionId).toBe("session-1");

    const response = await fetch(`http://127.0.0.1:${discovery.port}/v1/messages`, {
      method: "POST",
      headers: {
        Authorization: "Bearer integration-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: "external-1",
        source: "alertmanager",
        content: "Investigate this alert",
        delivery: "followUp",
        wake: true,
      }),
    });
    expect(response.status).toBe(202);
    expect(harness.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "channel/message",
        display: true,
        content: expect.stringContaining("Investigate this alert"),
      }),
      { deliverAs: "followUp", triggerTurn: true },
    );

    await harness.handlers.get("session_shutdown")!({}, harness.ctx);
    expect(await readdir(join(agentDir, "channels"))).toEqual([]);
  });
});
