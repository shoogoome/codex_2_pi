import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { piSocketPath } from "./piTransport.js";

const processes: ChildProcess[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(processes.splice(0).map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    if (child.connected) child.disconnect();
    const kill = setTimeout(() => child.kill("SIGKILL"), 2000);
    await exited; clearTimeout(kill);
  }));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function worker() {
  const child = fork(fileURLToPath(new URL("./fixtures/piTransportProcess.ts", import.meta.url)), [], {
    execArgv: ["--import", "tsx"], silent: true,
  });
  processes.push(child);
  let stderr = "";
  child.stderr?.on("data", (data) => { stderr += String(data); });
  child.stdout?.resume();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`worker start timeout: ${stderr}`)), 5000);
    child.once("message", () => { clearTimeout(timer); resolve(); });
    child.once("error", reject);
  });
  let sequence = 0;
  const call = (action: string, params: Record<string, unknown> = {}) => new Promise<any>((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { child.off("message", onMessage); reject(new Error(`worker timeout ${action}: ${stderr}`)); }, 6000);
    const onMessage = (reply: any) => {
      if (reply.id !== id) return;
      clearTimeout(timer); child.off("message", onMessage);
      if (reply.error) reject(new Error(reply.error)); else resolve(reply.data);
    };
    child.on("message", onMessage); child.send({ id, action, ...params });
  });
  return { child, call };
}

describe("Pi IPC across independent processes", () => {
  it("supports direct mutual messaging without an IP listener or implicit third-party membership", async () => {
    const rootDir = await mkdtemp("/tmp/pi-proc-"); roots.push(rootDir);
    const [a, b, outsider] = await Promise.all([worker(), worker(), worker()]);
    const room = await a.call("create", { rootDir, mode: "direct", name: "后端" });
    expect((await lstat(piSocketPath(rootDir, room.snapshot.channelId))).isSocket()).toBe(true);
    expect(room.snapshot).not.toHaveProperty("port");
    await b.call("join", { rootDir, code: room.pairingCode, name: "前端" });
    expect((await a.call("send", { content: "api ready", messageId: "a1" })).delivered).toBe(true);
    expect((await b.call("send", { content: "ui ready", messageId: "b1" })).delivered).toBe(true);
    expect(await a.call("messages")).toHaveLength(1); expect(await b.call("messages")).toHaveLength(1);
    expect(await outsider.call("snapshot")).toBeNull(); expect(await outsider.call("messages")).toEqual([]);
    await expect(outsider.call("join", { rootDir, code: room.pairingCode })).rejects.toThrow("channel_full");
  });
  it("broadcasts three ways, detects owner SIGKILL, rejects stale socket and pairs a new room", async () => {
    const rootDir = await mkdtemp("/tmp/pi-proc-"); roots.push(rootDir);
    const [a, b, c] = await Promise.all([worker(), worker(), worker()]);
    const room = await a.call("create", { rootDir });
    await Promise.all([b.call("join", { rootDir, code: room.pairingCode }), c.call("join", { rootDir, code: room.pairingCode })]);
    const receipt = await b.call("send", { content: "广播", messageId: "broadcast" });
    expect(receipt.delivered).toBe(true); expect(receipt.targets).toHaveLength(2);
    expect(await a.call("messages")).toHaveLength(1); expect(await c.call("messages")).toHaveLength(1);
    const exit = once(a.child, "exit"); a.child.kill("SIGKILL"); await exit;
    await vi.waitFor(async () => expect((await b.call("snapshot")).status).toBe("closed"));
    await expect(b.call("send", { content: "after crash" })).rejects.toThrow("channel_closed");
    await expect(c.call("join", { rootDir, code: room.pairingCode })).rejects.toThrow("channel_unavailable");
    // A fresh creator always uses a fresh endpoint; no stale-room takeover.
    const next = await b.call("create", { rootDir });
    expect(next.snapshot.channelId).not.toBe(room.snapshot.channelId);
    await c.call("join", { rootDir, code: next.pairingCode });
    expect((await b.call("send", { content: "new room" })).delivered).toBe(true);
  });
});
