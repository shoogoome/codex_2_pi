import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import loopExtension from "./index.js";

interface Harness {
  commands: Map<string, { handler: (args: string, ctx: any) => unknown }>;
  handlers: Map<string, (event: unknown, ctx: any) => unknown>;
  sendUserMessage: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
  setStatus: ReturnType<typeof vi.fn>;
  ctx: any;
  setIdle(value: boolean): void;
}

function createHarness(): Harness {
  const commands = new Map<string, { handler: (args: string, ctx: any) => unknown }>();
  const handlers = new Map<string, (event: unknown, ctx: any) => unknown>();
  const sendUserMessage = vi.fn();
  const notify = vi.fn();
  const setStatus = vi.fn();
  let idle = true;
  const pi = {
    registerCommand(name: string, command: { handler: (args: string, ctx: any) => unknown }) {
      commands.set(name, command);
    },
    on(name: string, handler: (event: unknown, ctx: any) => unknown) {
      handlers.set(name, handler);
    },
    sendUserMessage,
  };
  const ctx = {
    hasUI: true,
    isIdle: () => idle,
    hasPendingMessages: () => false,
    ui: { notify, setStatus },
  };
  loopExtension(pi as never);
  return {
    commands,
    handlers,
    sendUserMessage,
    notify,
    setStatus,
    ctx,
    setIdle(value: boolean) {
      idle = value;
    },
  };
}

function getJobId(harness: Harness): string {
  const confirmation = harness.notify.mock.calls
    .map((call) => String(call[0]))
    .find((message) => message.includes("已创建"));
  const match = confirmation?.match(/loop-[0-9a-f]{8}/);
  if (!match) throw new Error("job id not found");
  return match[0];
}

describe("loop extension", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("registers /loop and shows usage without arguments", async () => {
    const harness = createHarness();
    expect(harness.commands.has("loop")).toBe(true);

    await harness.commands.get("loop")!.handler("", harness.ctx);
    expect(harness.notify).toHaveBeenCalledWith(expect.stringContaining("/loop [间隔]"), "info");
    expect(harness.sendUserMessage).not.toHaveBeenCalled();
  });

  it("executes immediately, then repeats at the requested interval", async () => {
    const harness = createHarness();
    await harness.commands.get("loop")!.handler("5m 检查部署", harness.ctx);

    expect(harness.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(harness.sendUserMessage).toHaveBeenLastCalledWith("检查部署");
    expect(harness.setStatus).toHaveBeenLastCalledWith("loop", "Loop: 1 · next 5m");

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(harness.sendUserMessage).toHaveBeenCalledTimes(2);
    expect(harness.sendUserMessage).toHaveBeenLastCalledWith("检查部署");
  });

  it("waits until the agent is idle instead of interrupting a turn", async () => {
    const harness = createHarness();
    await harness.commands.get("loop")!.handler("1m poll", harness.ctx);
    harness.setIdle(false);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.sendUserMessage).toHaveBeenCalledTimes(1);

    harness.setIdle(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(harness.sendUserMessage).toHaveBeenCalledTimes(2);
  });

  it("lists and cancels a scheduled loop", async () => {
    const harness = createHarness();
    await harness.commands.get("loop")!.handler("10m check", harness.ctx);
    const id = getJobId(harness);

    await harness.commands.get("loop")!.handler("list", harness.ctx);
    expect(harness.notify).toHaveBeenLastCalledWith(expect.stringContaining(id), "info");

    await harness.commands.get("loop")!.handler(`cancel ${id}`, harness.ctx);
    expect(harness.notify).toHaveBeenLastCalledWith(`已取消循环任务 ${id}。`, "info");
    expect(harness.setStatus).toHaveBeenLastCalledWith("loop", undefined);

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(harness.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("clears session-only loops on shutdown", async () => {
    const harness = createHarness();
    await harness.commands.get("loop")!.handler("1m ping", harness.ctx);

    await harness.handlers.get("session_shutdown")!({}, harness.ctx);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(harness.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(harness.setStatus).toHaveBeenLastCalledWith("loop", undefined);
  });
});
