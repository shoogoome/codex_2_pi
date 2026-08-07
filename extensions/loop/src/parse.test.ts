import { describe, expect, it } from "vitest";
import {
  DEFAULT_INTERVAL_MS,
  parseLoopInput,
} from "./parse.js";

function parsed(input: string) {
  const result = parseLoopInput(input);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

describe("parseLoopInput", () => {
  it("parses a leading compact interval", () => {
    expect(parsed("5m 检查部署")).toEqual({
      prompt: "检查部署",
      intervalMs: 5 * 60_000,
      intervalLabel: "5m",
    });
  });

  it("parses trailing English every clauses", () => {
    expect(parsed("check the deploy every 2 hours")).toMatchObject({
      prompt: "check the deploy",
      intervalMs: 2 * 60 * 60_000,
      intervalLabel: "2h",
    });
  });

  it("parses Chinese intervals", () => {
    expect(parsed("检查部署 每20分钟")).toMatchObject({
      prompt: "检查部署",
      intervalMs: 20 * 60_000,
      intervalLabel: "20m",
    });
  });

  it("defaults to ten minutes without an interval", () => {
    expect(parsed("check every PR")).toEqual({
      prompt: "check every PR",
      intervalMs: DEFAULT_INTERVAL_MS,
      intervalLabel: "10m",
    });
  });

  it("rounds seconds up to the nearest minute", () => {
    expect(parsed("30s ping")).toEqual({
      prompt: "ping",
      intervalMs: 60_000,
      intervalLabel: "1m",
      roundedFrom: "30s",
    });
    expect(parsed("90s ping")).toEqual({
      prompt: "ping",
      intervalMs: 120_000,
      intervalLabel: "2m",
      roundedFrom: "90s",
    });
  });

  it("rejects an empty prompt and intervals over seven days", () => {
    expect(parseLoopInput("5m")).toMatchObject({ ok: false });
    expect(parseLoopInput("8d check")).toMatchObject({ ok: false });
  });
});
