import { createTaskActivityHandle } from "./activity.js";

const activity = { originSessionId: "root", originCwd: "/root", taskId: "task", operationId: "run", cwd: "/other" };
describe("task activity", () => {
  it("awaits baseline, pairs once and replays only active windows", async () => {
    const hub = createTaskActivityHandle();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const events: string[] = [];
    hub.subscribe(async (e) => { events.push(e.phase); if (e.phase === "before-start") await gate; });
    const start = hub.begin(activity);
    expect(hub.getActive()).toEqual([]);
    expect(hub.begin(activity)).toBe(start);
    release(); await start;
    expect(hub.getActive()).toEqual([activity]);
    await Promise.all([hub.end(activity), hub.end(activity)]);
    expect(events).toEqual(["before-start", "end"]);
    expect(hub.getActive()).toEqual([]);
  });
  it("unsubscribes without ending child tasks and ignores unknown attribution", async () => {
    const hub = createTaskActivityHandle();
    const listener = vi.fn();
    const unsubscribe = hub.subscribe(listener);
    await hub.begin(activity); unsubscribe();
    await hub.end(activity);
    await hub.begin({ ...activity, originSessionId: undefined });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(hub.getActive()).toEqual([]);
  });
  it("rolls back a failed baseline without executing or leaving a window", async () => {
    const hub = createTaskActivityHandle();
    const events: string[] = [];
    hub.subscribe((e) => { events.push(e.phase); if (e.phase === "before-start") throw Error("baseline"); });
    await expect(hub.begin(activity)).rejects.toThrow("baseline");
    expect(events).toEqual(["before-start", "end"]);
    expect(hub.getActive()).toEqual([]);
  });
});
