import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { createLineReader } from "./pi-rpc.js";

describe("createLineReader", () => {
  it("emits parsed JSON-lines in order", async () => {
    const lines: string[] = [];
    const stream = Readable.from(['{"type":"event","a":1}\n', '{"type":"response","b":2}\n']);
    const stop = createLineReader(stream, (line) => lines.push(JSON.parse(line)));
    await new Promise((resolve) => stream.on("end", resolve));
    stop();
    expect(lines).toEqual([
      { type: "event", a: 1 },
      { type: "response", b: 2 },
    ]);
  });

  it("handles chunks splitting a line across boundaries", async () => {
    const lines: string[] = [];
    const stream = Readable.from(["{\"type\":\"resp", "onse\",\"ok\":true}\n"]);
    const stop = createLineReader(stream, (line) => lines.push(line));
    await new Promise((resolve) => stream.on("end", resolve));
    stop();
    expect(lines).toEqual(['{"type":"response","ok":true}']);
  });

  it("ignores empty lines", async () => {
    const lines: string[] = [];
    const stream = Readable.from(["\n\n{\"type\":\"x\"}\n\n"]);
    const stop = createLineReader(stream, (line) => lines.push(line));
    await new Promise((resolve) => stream.on("end", resolve));
    stop();
    expect(lines).toEqual(['{"type":"x"}']);
  });
});
