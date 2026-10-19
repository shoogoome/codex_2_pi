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

  it.each(["inbound", "outbound", "both"] as const)("validates MCP %s listeners without requiring an HTTP callback", (direction) => {
    const channel = createChannelDefinition({
      name: "session-mcp",
      protocol: "mcp",
      direction,
      scope: "selected",
      sessionId: "session-a",
      mcp: { token: "mcp-secret" },
    });

    expect(channel.mcp).toEqual({
      host: "127.0.0.1", port: 0, token: "mcp-secret", auth: "bearer",
      maxBodyBytes: 65536, rateLimitPerMinute: 30, idempotencyTtlMs: 600000,
    });
    expect(channel.http).toBeUndefined();
    expect(channel.wechat).toBeUndefined();
    expect(isChannelMounted(channel, "session-a")).toBe(true);
    expect(isChannelMounted(channel, "session-b")).toBe(false);
    expect(effectiveChannelDirection(channel, "session-a")).toBe(direction);

    expect(() => createChannelDefinition({
      name: "unauthenticated-mcp", protocol: "mcp", direction, scope: "selected", sessionId: "session-a",
    })).toThrow("mcp.token is required");
  });

  it("requires explicit auth=none to allow an empty MCP token and round-trips it", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-channel-mcp-noauth-"));
    roots.push(root);
    const channel = createChannelDefinition({ name: "no-auth", protocol: "mcp", direction: "both", scope: "selected", sessionId: "session-a", mcp: { auth: "none" } });
    expect(channel.mcp).toMatchObject({ auth: "none", token: "" });
    await saveChannelSettings(root, { version: 1, channels: [channel] });
    expect((await loadChannelSettings(root)).channels[0]).toEqual(channel);
    expect(() => validateChannelSettings({ version: 1, channels: [{ ...channel, mcp: { ...channel.mcp, auth: "bearer" } }] })).toThrow("token");
    expect(() => validateChannelSettings({ version: 1, channels: [{ ...channel, mcp: { ...channel.mcp, auth: "invalid" } }] })).toThrow("mcp.auth");
  });

  it("persists MCP settings privately and requires explicit session mounts", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-channel-mcp-store-"));
    roots.push(root);
    const channel = createChannelDefinition({
      name: "session-mcp", protocol: "mcp", direction: "both", scope: "selected", sessionId: "session-a",
      mcp: { token: "mcp-secret", port: 54321, maxBodyBytes: 8192, rateLimitPerMinute: 12, idempotencyTtlMs: 12345 },
    });
    channel.scope.sessionIds.push("session-b");
    channel.sessionDirections = { "session-a": "both", "session-b": "outbound" };
    await saveChannelSettings(root, { version: 1, channels: [channel] });
    const persisted = (await loadChannelSettings(root)).channels[0]!;
    expect(persisted).toEqual(channel);
    expect(effectiveChannelDirection(persisted, "session-b")).toBe("outbound");
    expect((await stat(channelConfigPath(root))).mode & 0o777).toBe(0o600);
    expect(() => validateChannelSettings({ version: 1, channels: [{ ...channel, scope: { kind: "all", sessionIds: [] } }] })).toThrow("require selected scope");
    expect(() => createChannelDefinition({
      name: "all-mcp", protocol: "mcp", direction: "both", scope: "all", sessionId: "session-a", mcp: { token: "secret" },
    })).toThrow("require selected scope");
    for (const invalid of [{ port: 65536 }, { maxBodyBytes: 100 }, { rateLimitPerMinute: 0 }, { idempotencyTtlMs: 1 }, { token: "bad\nvalue" }]) {
      expect(() => validateChannelSettings({ version: 1, channels: [{ ...channel, mcp: { ...channel.mcp, ...invalid } }] })).toThrow(/mcp\./);
    }
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


describe("dots Channel configuration", () => {
  it("round-trips private settings with distinct dots options and safe defaults", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-dots-store-")); roots.push(root);
    const dots = createChannelDefinition({ name: "my-dot", protocol: "dots", direction: "both", scope: "selected", sessionId: "a", dots: { token: "dots-secret" } });
    expect(dots).toMatchObject({ protocol: "dots", delivery: "followUp", wake: true, scope: { kind: "selected", sessionIds: ["a"] },
      dots: { host: "127.0.0.1", port: 0, auth: "bearer", token: "dots-secret", subscriptionTtlMs: 3_600_000, retryIntervalMs: 1000, maxAttempts: 6 } });
    expect(dots.mcp).toBeUndefined(); expect(dots.http).toBeUndefined(); expect(dots.wechat).toBeUndefined();
    await saveChannelSettings(root, { version: 1, channels: [dots] });
    expect((await loadChannelSettings(root)).channels[0]).toEqual(dots);
    expect((await stat(channelConfigPath(root))).mode & 0o777).toBe(0o600);
    expect(isChannelMounted(dots, "b")).toBe(false);
  });

  it("requires explicit no-auth, explicit session mounts, and bounded event configuration", () => {
    const input = { name: "my-dot", protocol: "dots" as const, direction: "both" as const, scope: "selected" as const, sessionId: "a" };
    expect(() => createChannelDefinition(input)).toThrow("dots.token");
    const dots = createChannelDefinition({ ...input, dots: { auth: "none" } });
    expect(dots.dots).toMatchObject({ auth: "none", token: "" });
    expect(() => createChannelDefinition({ ...input, scope: "all", dots: { token: "secret" } })).toThrow("require selected scope");
    for (const invalid of [{ subscriptionTtlMs: 0 }, { subscriptionTtlMs: 86_400_001 }, { retryIntervalMs: 60_001 }, { retryIntervalMs: 0 }, { maxAttempts: 0 }, { maxAttempts: 21 }, { auth: "invalid" }, { token: "bad\nvalue" }]) {
      expect(() => validateChannelSettings({ version: 1, channels: [{ ...dots, dots: { ...dots.dots, ...invalid } }] })).toThrow(/dots\./);
    }
  });
});
