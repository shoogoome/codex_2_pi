import { describe, expect, it, vi } from "vitest";
import { resolveWebConfig } from "./config.js";

describe("resolveWebConfig", () => {
  it("defaults to disabled with 0.0.0.0:8600 and no token", () => {
    const config = resolveWebConfig(() => undefined, {});
    expect(config).toEqual({ enabled: false, host: "0.0.0.0", port: 8600, token: "" });
  });

  it("flags enable the server", () => {
    const config = resolveWebConfig((name) => (name === "web" ? true : undefined), {});
    expect(config.enabled).toBe(true);
  });

  it("--web=false disables even when env says on", () => {
    const config = resolveWebConfig((name) => (name === "web" ? false : undefined), { PI_WEB: "1" });
    expect(config.enabled).toBe(false);
  });

  it("env PI_WEB=1 enables", () => {
    const config = resolveWebConfig(() => undefined, { PI_WEB: "1" });
    expect(config.enabled).toBe(true);
  });

  it("prefers flags over env for host/port/token", () => {
    const flags = new Map([
      ["web-host", "0.0.0.0"],
      ["web-port", "9000"],
      ["web-token", "secret"],
    ]);
    const config = resolveWebConfig((name) => flags.get(name), { PI_WEB_HOST: "127.0.0.1", PI_WEB_PORT: "1111", PI_WEB_TOKEN: "envtoken" });
    expect(config).toEqual({ enabled: false, host: "0.0.0.0", port: 9000, token: "secret" });
  });

  it("falls back to env for port when no flag", () => {
    const config = resolveWebConfig(() => undefined, { PI_WEB_PORT: "0" });
    expect(config.port).toBe(0);
  });
});
