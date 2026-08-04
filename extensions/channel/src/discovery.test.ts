import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  channelDiscoveryPath,
  removeChannelDiscovery,
  writeChannelDiscovery,
} from "./discovery.js";
import type { ChannelDiscoveryRecord } from "./types.js";

function record(instanceId = "instance-1"): ChannelDiscoveryRecord {
  return {
    version: 1,
    instanceId,
    sessionId: "session/with unsafe chars",
    pid: 123,
    cwd: "/repo",
    host: "0.0.0.0",
    port: 4317,
    localUrl: "http://127.0.0.1:4317",
    startedAt: "2026-08-02T12:00:00.000Z",
  };
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("channel discovery", () => {
  it("writes a private record under the agent channels directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-channel-discovery-"));
    roots.push(root);
    const path = await writeChannelDiscovery(root, record());
    expect(path).toBe(channelDiscoveryPath(root, "session/with unsafe chars"));
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(record());
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("only removes a discovery record owned by the same runtime instance", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-channel-discovery-"));
    roots.push(root);
    const path = await writeChannelDiscovery(root, record("new-instance"));

    await removeChannelDiscovery(path, "old-instance");
    await expect(readFile(path, "utf8")).resolves.toContain("new-instance");

    await removeChannelDiscovery(path, "new-instance");
    await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
