import { createAgentConversations } from "../tasks/agentConversations.js";
import { createInteractionController } from "./interactionController.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
function harness() {
  const store = createAgentConversations();
  const g = store.begin({ id: "a", description: "task", cwd: "/repo", startTime: 0 }, "task");
  const initial = deferred();
  const prompt = vi.fn().mockImplementationOnce((_text, options) => { options.preflightResult(true); return initial.promise; });
  const closeWorker = vi.fn();
  const error = vi.fn();
  const controller = createInteractionController({
    session: { prompt }, conversations: store, taskId: "a", generation: g,
    isCurrent: () => store.generation === g, closeWorker, onRunError: error,
  });
  const done = controller.run("initial");
  return { controller, store, initial, prompt, closeWorker, error, done };
}

it("rejects blank, commands and closed inputs without starting requests", async () => {
  const h = harness();
  expect((await h.controller.control.submit(" ")).accepted).toBe(false);
  expect((await h.controller.control.submit("/new")).accepted).toBe(false);
  h.initial.resolve(); await h.done;
  expect((await h.controller.control.submit("late")).accepted).toBe(false);
  expect(h.prompt).toHaveBeenCalledTimes(1);
});

it("tracks a submission that crosses initial settlement, without serializing on model completion", async () => {
  const h = harness();
  const second = deferred();
  let ack!: (state: "started") => void;
  h.prompt.mockImplementationOnce((_text, opts) => { ack = opts.preflightResult; return second.promise; });
  const receipt = h.controller.control.submit("change direction");
  await Promise.resolve();
  h.initial.resolve();
  let finished = false;
  void h.done.then(() => { finished = true; });
  await Promise.resolve(); await Promise.resolve();
  expect(finished).toBe(false);
  ack("started");
  expect(await receipt).toEqual({ accepted: true });
  h.controller.entered();
  second.resolve();
  await h.done;
  expect(h.store.get("a")!.submissions[0]!.status).toBe("entered");
  expect(h.closeWorker).toHaveBeenCalledOnce();
});

it("keeps FIFO identities for repeated text, queuing the next without waiting for a full run", async () => {
  const h = harness();
  let ack!: (state: "queued") => void;
  const processing = deferred();
  h.prompt.mockImplementationOnce((_text, opts) => { ack = opts.preflightResult; return processing.promise; })
    .mockImplementationOnce((_text, opts) => { opts.preflightResult("queued"); return Promise.resolve(); });
  const a = h.controller.control.submit("same");
  const b = h.controller.control.submit("same");
  await Promise.resolve();
  expect(h.prompt).toHaveBeenCalledTimes(2);
  ack("queued"); await a; await b;
  expect(h.prompt).toHaveBeenCalledTimes(3);
  h.controller.entered(); h.controller.entered();
  expect(h.store.get("a")!.submissions.map((s) => s.id)).toEqual(["a:1", "a:2"]);
  expect(h.store.get("a")!.submissions.map((s) => s.status)).toEqual(["entered", "entered"]);
  processing.resolve(); h.initial.resolve(); await h.done;
});

it("records handled extensions distinctly from entered messages, including legacy boolean preflight", async () => {
  const h = harness();
  h.prompt.mockImplementationOnce((_text, opts) => { opts.preflightResult(true); return Promise.resolve(); });
  await expect(h.controller.control.submit("handled")).resolves.toEqual({ accepted: true });
  expect(h.store.get("a")!.submissions[0]!.status).toBe("handled");
  h.initial.resolve(); await h.done;
});

it("cancels queued dispatches on kill without waiting for an asynchronous input hook", async () => {
  const h = harness();
  const hook = deferred();
  h.prompt.mockImplementationOnce(() => hook.promise);
  const a = h.controller.control.submit("first");
  const b = h.controller.control.submit("second");
  await Promise.resolve();
  h.controller.control.close("killed");
  expect((await a).accepted).toBe(false);
  expect((await b).accepted).toBe(false);
  await h.done;
  expect(h.store.get("a")!.submissions.every((s) => s.status === "cancelled")).toBe(true);
  hook.resolve(); h.initial.resolve();
  await Promise.resolve();
  expect(h.prompt).toHaveBeenCalledTimes(2);
});

it("handles rejection and stale root generation without silent queue loss", async () => {
  const h = harness();
  h.prompt.mockRejectedValueOnce(new Error("input rejected"));
  expect(await h.controller.control.submit("fail")).toMatchObject({ accepted: false, error: "input rejected" });
  h.store.reset();
  expect((await h.controller.control.submit("stale")).accepted).toBe(false);
  h.controller.control.close("reset"); h.initial.resolve(); await h.done;
});


it("does not attribute unrelated queue drains to a pending asynchronous dispatch", async () => {
  const h = harness();
  const barrier = deferred();
  h.prompt.mockImplementationOnce(async (_text, options) => {
    await barrier.promise;
    h.controller.queued();
    options.preflightResult(true); // legacy SDK reports only a boolean
  }).mockImplementationOnce((_text, options) => { options.preflightResult("handled"); return Promise.resolve(); });
  const first = h.controller.control.submit("first");
  const second = h.controller.control.submit("second");
  await Promise.resolve();
  h.controller.queued(); // an unrelated event outside the input async context
  await Promise.resolve();
  expect(h.prompt).toHaveBeenCalledTimes(2);
  expect(h.store.get("a")!.submissions[0]!.status).toBe("submitting");
  barrier.resolve();
  expect((await first).accepted).toBe(true);
  expect((await second).accepted).toBe(true);
  h.controller.entered();
  h.initial.resolve();
  await h.done;
});


it("settles even when error reporting itself throws", async () => {
  const controller = createInteractionController({
    session: { prompt: () => Promise.reject(new Error("run failed")) },
    taskId: "a", generation: 0, isCurrent: () => true,
    closeWorker: vi.fn(), onRunError: () => { throw new Error("output failed"); },
  });
  await expect(controller.run("task")).resolves.toBeUndefined();
  expect(controller.isOpen()).toBe(false);
});


it("accepts but does not dispatch input while the initial SDK prompt is preparing", async () => {
  let initialReady!: (state: boolean) => void;
  let finishInitial!: () => void;
  const prompt = vi.fn()
    .mockImplementationOnce((_text, options) => {
      initialReady = options.preflightResult;
      return new Promise<void>((resolve) => { finishInitial = resolve; });
    })
    .mockImplementationOnce((_text, options) => { options.preflightResult("handled"); return Promise.resolve(); });
  const controller = createInteractionController({
    session: { prompt }, taskId: "a", generation: 0, isCurrent: () => true, closeWorker() {}, onRunError: vi.fn(),
  });
  const done = controller.run("initial");
  const receipt = controller.control.submit("during startup");
  await Promise.resolve();
  expect(prompt).toHaveBeenCalledTimes(1);
  initialReady(true);
  expect((await receipt).accepted).toBe(true);
  expect(prompt).toHaveBeenCalledTimes(2);
  finishInitial(); await done;
});
