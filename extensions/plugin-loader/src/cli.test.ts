import { describe, expect, it } from "vitest";
import { parsePluginCommand, shellSplit } from "./cli.js";

describe("shellSplit", () => {
  it("handles quoting and escaping", () => {
    expect(shellSplit(`install "hello world@market" --config token='a b'`)).toEqual([
      "install", "hello world@market", "--config", "token=a b",
    ]);
  });
  it("rejects an unterminated quote", () => expect(() => shellSplit(`install "x`)).toThrow(/Unterminated/));
});

describe("parsePluginCommand", () => {
  it("parses scope, flags and typed config", () => {
    expect(parsePluginCommand("install demo@m -s project --config retries=3 --config enabled=true")).toMatchObject({
      command: "install", args: ["demo@m"], scope: "project", configs: { retries: 3, enabled: true },
    });
  });
  it("supports equals options", () => {
    expect(parsePluginCommand("list --scope=local --available --json")).toMatchObject({ scope: "local", available: true, json: true });
  });
  it("rejects unknown options", () => expect(() => parsePluginCommand("list --wat")).toThrow(/Unknown option/));
});
