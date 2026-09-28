import { copyTaskOrigin, registerTaskOrigin, taskOriginFromContext } from "./origin.js";
import { createTaskStateBase } from "./Task.js";
import { createTaskStore } from "./taskStore.js";

const context = (id: string, file: string, cwd = "/repo") => ({ cwd, sessionManager: { getSessionId: () => id, getSessionFile: () => file } }) as never;
describe("task root origins", () => {
  it("captures root, inherits across nested child sessions and never substitutes child cwd", () => {
    const root = taskOriginFromContext(context("root", "/root.jsonl"));
    const unregister = registerTaskOrigin("/child.jsonl", root);
    const child = taskOriginFromContext(context("child", "/child.jsonl", "/another-worktree"));
    const unregisterNested = registerTaskOrigin("/nested.jsonl", child);
    expect(taskOriginFromContext(context("nested", "/nested.jsonl"))).toEqual(root);
    expect(taskOriginFromContext(context("new", "/new.jsonl")).originSessionId).toBe("new");
    expect(child.originSessionId).toBe("root");
    unregister(); unregisterNested();
  });
  it("explicit unknown restored children are not attributed to the current session", () => {
    const unregister = registerTaskOrigin("/old-child.jsonl", {});
    expect(taskOriginFromContext(context("child", "/old-child.jsonl"))).toEqual({});
    unregister();
  });
  it("locks task attribution while preserving ownerAgentId/toolUseId semantics", () => {
    const store = createTaskStore();
    const origin = copyTaskOrigin({ originSessionId: "root", originSessionFile: "/root.jsonl", originCwd: "/repo" });
    const task = createTaskStateBase({ ...origin, id: "t", type: "local_bash", description: "test", outputFile: "/tmp/t", ownerAgentId: "alice@team", toolUseId: "call" });
    store.set(() => ({ t: task }));
    store._setSessionId("new");
    store.set((prev) => ({ t: { ...prev.t!, originSessionId: "new", status: "completed" } }));
    expect(store.getTask("t")).toMatchObject({ ...origin, ownerAgentId: "alice@team", toolUseId: "call", status: "completed" });
    const legacy = createTaskStateBase({ id: "old", type: "local_bash", description: "old", outputFile: "/tmp/old" });
    store.set((prev) => ({ ...prev, old: legacy }));
    store.set((prev) => ({ ...prev, old: { ...prev.old!, originSessionId: "new" } }));
    expect(store.getTask("old")?.originSessionId).toBeUndefined();
  });
});
