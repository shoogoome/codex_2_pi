import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createAgentConversations } from "../tasks/agentConversations.js";
import { createInteractionController } from "./interactionController.js";
import { createConversationProjection } from "./conversationProjection.js";

it("the real SDK drains user steering before one-shot completion", async () => {
  const entry = process.env.PI_TEST_RUNTIME_ENTRY ?? resolve("node_modules/@earendil-works/pi-coding-agent/dist/index.js");
  const sdk = await import(pathToFileURL(entry).href) as typeof import("@earendil-works/pi-coding-agent");
  const dir = await mkdtemp(join(tmpdir(), "pi-steering-sdk-"));
  let session: Awaited<ReturnType<typeof sdk.createAgentSessionFromServices>>["session"] | undefined;
  try {
    const services = await sdk.createAgentSessionServices({
      cwd: dir, agentDir: dir, settingsManager: sdk.SettingsManager.inMemory(),
      resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true },
    });
    vi.spyOn(services.modelRuntime, "hasConfiguredAuth").mockReturnValue(true);
    const model = { api: "openai-completions", provider: "test", id: "test", name: "test", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    ({ session } = await sdk.createAgentSessionFromServices({ services, sessionManager: sdk.SessionManager.inMemory(dir), model: model as never, tools: [] }));
    const streams: ReturnType<typeof createAssistantMessageEventStream>[] = [];
    const request = vi.fn(() => {
      const stream = createAssistantMessageEventStream(); streams.push(stream); return stream;
    });
    session.agent.streamFunction = request;
    const conversations = createAgentConversations();
    const generation = conversations.begin({ id: "a", description: "test", cwd: dir, startTime: 0 }, "initial task");
    const error = vi.fn();
    const controller = createInteractionController({ session, conversations, generation, taskId: "a", isCurrent: () => true, closeWorker() {}, onRunError: error });
    const project = createConversationProjection(conversations, "a", generation);
    let firstUser = true;
    const unsub = session.subscribe((event) => {
      project(event as never);
      if (event.type === "message_start" && event.message.role === "user") {
        if (firstUser) firstUser = false; else controller.entered();
      }
      if (event.type === "queue_update" && event.steering.length) controller.queued();
    });
    const done = controller.run("initial task");
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(await controller.control.submit("change direction")).toEqual({ accepted: true });
    expect(conversations.get("a")!.submissions[0]!.status).toBe("queued");
    const finish = (index: number, text: string) => {
      const message = { role: "assistant", content: [{ type: "text", text }], api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as const;
      streams[index]!.push({ type: "done", reason: "stop", message } as never);
      streams[index]!.end();
    };
    finish(0, "initial answer");
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(conversations.get("a")!.submissions[0]!.status).toBe("entered");
    finish(1, "intervened answer");
    await done;
    expect(error).not.toHaveBeenCalled();
    expect(controller.isOpen()).toBe(false);
    expect(JSON.stringify(conversations.get("a"))).toContain("intervened answer");
    expect((await controller.control.submit("late")).accepted).toBe(false);
    unsub();
  } finally {
    session?.dispose(); vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  }
});
