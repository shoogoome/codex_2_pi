import {
  DEFAULT_CHANNEL_HOST,
  DEFAULT_CHANNEL_PORT,
  resolveChannelConfig,
} from "./config.js";

describe("resolveChannelConfig", () => {
  it("stays inactive until a token is configured", () => {
    expect(resolveChannelConfig({ env: {} })).toEqual({
      enabled: false,
      reason: "missing-token",
    });
  });

  it("binds 0.0.0.0:4317 by default once configured", () => {
    const result = resolveChannelConfig({ env: { PI_CHANNEL_TOKEN: "secret" } });
    expect(result.enabled).toBe(true);
    if (!result.enabled) return;
    expect(result.config.host).toBe(DEFAULT_CHANNEL_HOST);
    expect(result.config.port).toBe(DEFAULT_CHANNEL_PORT);
  });

  it("lets CLI host/port override environment values", () => {
    const result = resolveChannelConfig({
      flagHost: "127.0.0.1",
      flagPort: "0",
      env: {
        PI_CHANNEL_TOKEN: "secret",
        PI_CHANNEL_HOST: "0.0.0.0",
        PI_CHANNEL_PORT: "9999",
      },
    });
    expect(result.enabled).toBe(true);
    if (!result.enabled) return;
    expect(result.config.host).toBe("127.0.0.1");
    expect(result.config.port).toBe(0);
  });

  it("can be disabled by flag or environment", () => {
    expect(
      resolveChannelConfig({
        flagEnabled: false,
        env: { PI_CHANNEL_TOKEN: "secret" },
      }),
    ).toEqual({ enabled: false, reason: "disabled" });
    expect(
      resolveChannelConfig({
        env: { PI_CHANNEL: "0", PI_CHANNEL_TOKEN: "secret" },
      }),
    ).toEqual({ enabled: false, reason: "disabled" });
  });

  it("rejects invalid numeric configuration", () => {
    const result = resolveChannelConfig({
      env: { PI_CHANNEL_TOKEN: "secret", PI_CHANNEL_PORT: "70000" },
    });
    expect(result).toEqual(
      expect.objectContaining({ enabled: false, reason: "invalid-config" }),
    );
  });
});
