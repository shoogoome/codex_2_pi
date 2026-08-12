import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  channelConfigPath,
  createChannelDefinition,
  effectiveChannelDirection,
  isChannelMounted,
  loadChannelSettings,
  saveChannelSettings,
  validateChannelSettings,
} from "./store.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("named channel config store", () => {
  it("persists multiple named channels in a private global config", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-channel-store-"));
    roots.push(root);
    const inbound = createChannelDefinition({
      name: "alerts",
      protocol: "http",
      direction: "inbound",
      scope: "selected",
      sessionId: "session-a",
      http: { token: "secret" },
    });
    const outbound = createChannelDefinition({
      name: "release-room",
      protocol: "http",
      direction: "outbound",
      scope: "all",
      sessionId: "session-a",
      http: { callbackUrl: "https://example.com/pi" },
    });

    await saveChannelSettings(root, { version: 1, channels: [inbound, outbound] });
    const loaded = await loadChannelSettings(root);

    expect(loaded.channels.map((entry) => entry.name)).toEqual(["alerts", "release-room"]);
    expect((await stat(channelConfigPath(root))).mode & 0o777).toBe(0o600);
    expect(await readFile(channelConfigPath(root), "utf8")).toContain("secret");
  });

  it("implements selected/all mounting and resolves direction per Pi session", () => {
    const selected = createChannelDefinition({
      name: "selected",
      protocol: "wechat",
      direction: "both",
      scope: "selected",
      sessionId: "a",
    });
    selected.scope.sessionIds.push("b", "c");
    selected.sessionDirections = { a: "both", b: "outbound", c: "inbound" };
    const all = createChannelDefinition({
      name: "all",
      protocol: "wechat",
      direction: "outbound",
      scope: "all",
      sessionId: "a",
    });

    expect(isChannelMounted(selected, "b")).toBe(true);
    expect(isChannelMounted(selected, "d")).toBe(false);
    expect(isChannelMounted(all, "d")).toBe(true);
    expect(effectiveChannelDirection(selected, "a")).toBe("both");
    expect(effectiveChannelDirection(selected, "b")).toBe("outbound");
    expect(effectiveChannelDirection(selected, "c")).toBe("inbound");
    expect(effectiveChannelDirection(selected, "unconfigured")).toBe("both");
  });

  it("migrates legacy single-session scope to selected multi-session scope", () => {
    const migrated = validateChannelSettings({
      version: 1,
      channels: [{
        id: "legacy-wx",
        name: "旧微信",
        enabled: true,
        protocol: "wechat",
        direction: "inbound",
        scope: { kind: "session", sessionIds: ["session-a"] },
        delivery: "steer",
        wake: true,
        wechat: {},
        createdAt: "2026-08-13T00:00:00.000Z",
        updatedAt: "2026-08-13T00:00:00.000Z",
      }],
    });

    expect(migrated.channels[0]?.scope).toEqual({ kind: "selected", sessionIds: ["session-a"] });
    expect(effectiveChannelDirection(migrated.channels[0]!, "session-a")).toBe("inbound");
  });

  it("rejects duplicate names and protocol/direction configurations that cannot work", () => {
    const channel = createChannelDefinition({
      name: "same",
      protocol: "wechat",
      direction: "both",
      scope: "all",
      sessionId: "a",
    });
    expect(() => validateChannelSettings({
      version: 1,
      channels: [channel, { ...channel, id: "different-id", name: "SAME" }],
    })).toThrow("duplicate channel name");

    expect(() => createChannelDefinition({
      name: "broken-http",
      protocol: "http",
      direction: "both",
      scope: "all",
      sessionId: "a",
      http: { token: "secret" },
    })).toThrow("callbackUrl is required");
  });
});
