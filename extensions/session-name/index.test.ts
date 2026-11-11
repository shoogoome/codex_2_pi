import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import sessionNameExtension from "./index.js";

function setup(initialName?: string) {
  let currentName = initialName;
  let tool: any;
  const setSessionName = vi.fn((name: string) => { currentName = name; });
  const pi = {
    registerTool: vi.fn((definition) => { tool = definition; }),
    getSessionName: () => currentName,
    setSessionName,
    on: vi.fn(),
  };
  sessionNameExtension(pi as unknown as ExtensionAPI);
  const ctx = { sessionManager: { getSessionId: () => "session-1" } } as unknown as ExtensionContext;
  return {
    pi, tool, ctx,
    execute: (name: unknown, signal?: AbortSignal) => tool.execute("call-1", { name }, signal, undefined, ctx),
  };
}

describe("set_session_name", () => {
  it("registers a conventional tool with guidance only in its description", () => {
    const { pi, tool } = setup();
    expect(tool.name).toBe("set_session_name");
    expect(tool.parameters.additionalProperties).toBe(false);
    expect(tool.parameters.properties.name).toMatchObject({ minLength: 1, maxLength: 80 });
    expect(tool.description).toContain("每次开始用户任务前");
    expect(tool.exposure ?? "direct").toBe("direct");
    expect(pi.on).not.toHaveBeenCalled();
  });

  it("names the current session through the Pi API and reports verified results", async () => {
    const { pi, execute } = setup();
    const result = await execute("  修复登录超时  ");
    expect(pi.setSessionName).toHaveBeenCalledWith("修复登录超时");
    expect(result.details).toEqual({
      ok: true, sessionId: "session-1", name: "修复登录超时", changed: true,
    });
    expect(JSON.parse(result.content[0].text)).toEqual(result.details);
  });

  it("does not append a duplicate name on repeated calls", async () => {
    const { pi, execute } = setup("修复登录超时");
    expect((await execute("修复登录超时")).details.changed).toBe(false);
    expect(pi.setSessionName).not.toHaveBeenCalled();
    expect((await execute("新增订单导出")).details.changed).toBe(true);
    expect(pi.setSessionName).toHaveBeenCalledTimes(1);
  });

  it.each(["", "  ", "a\nb", "\u001b[0m", "\u009b", "字".repeat(81), null, 7])(
    "rejects an invalid name (%j) without modifying the session",
    async (name) => {
      const { pi, execute } = setup("原名称");
      await expect(execute(name)).rejects.toThrow("name must be");
      expect(pi.setSessionName).not.toHaveBeenCalled();
    },
  );

  it("accepts at most 80 Unicode code points", async () => {
    const { execute } = setup();
    expect((await execute("😀".repeat(80))).details.name).toBe("😀".repeat(80));
  });

  it("does not modify the session after cancellation", async () => {
    const { pi, execute } = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(execute("新名称", controller.signal)).rejects.toThrow("aborted");
    expect(pi.setSessionName).not.toHaveBeenCalled();
  });

  it("propagates API errors and never falsely reports success", async () => {
    const { pi, execute } = setup();
    pi.setSessionName.mockImplementation(() => { throw new Error("session unavailable"); });
    await expect(execute("新名称")).rejects.toThrow("session unavailable");
    pi.setSessionName.mockImplementation(() => {});
    await expect(execute("新名称")).rejects.toThrow("could not be confirmed");
  });

  it("uses the current runtime session after a session switch, not a captured ID", async () => {
    const { tool, ctx, execute } = setup("原名称");
    await execute("任务一");
    const switchedCtx = {
      ...ctx, sessionManager: { getSessionId: () => "session-2" },
    };
    const result = await tool.execute("call-2", { name: "任务二" }, undefined, undefined, switchedCtx);
    expect(result.details.sessionId).toBe("session-2");
  });

  it("does not share name state between independent extension instances", async () => {
    const first = setup("主会话");
    const second = setup("子会话");
    await second.execute("子任务");
    expect(first.pi.getSessionName()).toBe("主会话");
    expect(first.pi.setSessionName).not.toHaveBeenCalled();
    expect(second.pi.getSessionName()).toBe("子任务");
  });
});
