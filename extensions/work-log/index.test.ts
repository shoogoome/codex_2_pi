import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import workLogExtension from "./index.js";
import { resolveLogDirectory, writeWorkLog } from "./store.js";

vi.mock("./store.js", () => ({ resolveLogDirectory: vi.fn(() => "/logs"), writeWorkLog: vi.fn() }));

function setup(flag?: string) {
  let tool: any;
  const pi = {
    registerTool: vi.fn((definition) => { tool = definition; }),
    registerFlag: vi.fn(),
    getFlag: vi.fn(() => flag),
    getSessionName: vi.fn(() => "当前任务"),
  };
  workLogExtension(pi as unknown as ExtensionAPI);
  return { pi, tool };
}

beforeEach(() => vi.clearAllMocks());

describe("record_work", () => {
  it("registers the tool with lifecycle guidance and configurable directory", () => {
    const { pi, tool } = setup();
    expect(pi.registerFlag).toHaveBeenCalledWith("work-log-dir", expect.objectContaining({ type: "string" }));
    expect(tool.name).toBe("record_work");
    expect(tool.parameters.additionalProperties).toBe(false);
    expect(tool.promptGuidelines.join("")).toContain("最终回答前");
    expect(tool.description).toContain("记录动作本身无需再次记录");
  });

  it("uses execution-time project and session context, returning success only after writing", async () => {
    const { tool } = setup("/custom");
    vi.mocked(writeWorkLog).mockResolvedValue({ path: "/logs/record.json", record: { id: "id", timestamp: "time", date: "date" } } as any);
    const params = { task: "任务", status: "completed", progress: "测试通过" };
    const signal = new AbortController().signal;
    const ctx = { cwd: "/new-project", sessionManager: { getSessionId: () => "new-session" } };
    const result = await tool.execute("call", params, signal, undefined, ctx);
    expect(resolveLogDirectory).toHaveBeenCalledWith("/custom");
    expect(writeWorkLog).toHaveBeenCalledWith("/logs", params, {
      cwd: "/new-project", sessionId: "new-session", sessionName: "当前任务",
    }, signal);
    expect(JSON.parse(result.content[0].text)).toEqual(result.details);
    expect(result.details.ok).toBe(true);
    vi.mocked(writeWorkLog).mockRejectedValueOnce(new Error("disk full"));
    await expect(tool.execute("call", params, signal, undefined, ctx)).rejects.toThrow("disk full");
  });
});
