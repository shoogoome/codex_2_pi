import { describe, it, expect } from "vitest";
import {
  splitJsonRpcFrames,
  createLineBuffer,
  buildJsonRpcRequest,
  encodeFrame,
  classifyRpcMessage,
} from "./framing.js";

describe("splitJsonRpcFrames", () => {
  it("splits multiple messages in one chunk", () => {
    const { messages, rest } = splitJsonRpcFrames('{"a":1}\n{"b":2}\n');
    expect(messages).toEqual([{ a: 1 }, { b: 2 }]);
    expect(rest).toBe("");
  });

  it("retains a trailing partial line", () => {
    const { messages, rest } = splitJsonRpcFrames('{"a":1}\n{"b":');
    expect(messages).toEqual([{ a: 1 }]);
    expect(rest).toBe('{"b":');
  });

  it("ignores empty lines", () => {
    const { messages } = splitJsonRpcFrames('\n\n{"a":1}\n\n');
    expect(messages).toEqual([{ a: 1 }]);
  });

  it("skips malformed lines without throwing", () => {
    const { messages } = splitJsonRpcFrames('garbage{\n{"ok":true}\n');
    expect(messages).toEqual([{ ok: true }]);
  });
});

describe("createLineBuffer", () => {
  it("buffers a half line across chunks", () => {
    const buf = createLineBuffer();
    expect(buf.push('{"a"')).toEqual([]);
    expect(buf.push(':1}\n')).toEqual([{ a: 1 }]);
  });

  it("emits multiple messages accumulated across chunks", () => {
    const buf = createLineBuffer();
    expect(buf.push('{"x":1}\n{"y"')).toEqual([{ x: 1 }]);
    expect(buf.push(':2}\n{"z":3}\n')).toEqual([{ y: 2 }, { z: 3 }]);
  });
});

describe("buildJsonRpcRequest / encodeFrame", () => {
  it("builds a request frame with params", () => {
    expect(buildJsonRpcRequest(7, "tools/list", { a: 1 })).toEqual({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/list",
      params: { a: 1 },
    });
  });

  it("omits params when undefined", () => {
    const req = buildJsonRpcRequest(1, "ping");
    expect(req).toEqual({ jsonrpc: "2.0", id: 1, method: "ping" });
    expect("params" in req).toBe(false);
  });

  it("encodes a frame terminated by newline", () => {
    expect(encodeFrame({ a: 1 })).toBe('{"a":1}\n');
  });
});

describe("classifyRpcMessage", () => {
  it("classifies a result frame by id", () => {
    expect(classifyRpcMessage({ jsonrpc: "2.0", id: 5, result: { ok: 1 } })).toEqual({
      kind: "result",
      id: 5,
      result: { ok: 1 },
    });
  });

  it("classifies an error frame by id", () => {
    const c = classifyRpcMessage({ jsonrpc: "2.0", id: "abc", error: { code: -32601, message: "no method" } });
    expect(c).toEqual({ kind: "error", id: "abc", error: { code: -32601, message: "no method" } });
  });

  it("ignores notifications (no id) and non-objects", () => {
    expect(classifyRpcMessage({ jsonrpc: "2.0", method: "notify" }).kind).toBe("ignore");
    expect(classifyRpcMessage({ id: null, result: 1 }).kind).toBe("ignore");
    expect(classifyRpcMessage(null).kind).toBe("ignore");
    expect(classifyRpcMessage("x").kind).toBe("ignore");
  });
});

describe("byte-stream framing + id correlation", () => {
  // Mirrors StdioTransport.onData: feed raw bytes through the line buffer, then
  // route each classified frame to the pending request keyed by its id.
  it("resolves out-of-order responses to the right pending id and skips notifications", () => {
    const buf = createLineBuffer();
    const resolved: Record<number | string, unknown> = {};
    const rejected: Record<number | string, string> = {};
    const pending = new Set<number | string>([1, 2, 3]);

    const feed = (bytes: string): void => {
      for (const msg of buf.push(bytes)) {
        const c = classifyRpcMessage(msg);
        if (c.kind === "ignore") continue;
        if (!pending.has(c.id)) continue;
        pending.delete(c.id);
        if (c.kind === "error") rejected[c.id] = c.error.message;
        else resolved[c.id] = c.result;
      }
    };

    // A server notification (no id), then id:2 arrives before id:1, split across
    // arbitrary byte boundaries, plus an error for id:3.
    feed('{"jsonrpc":"2.0","method":"log","params":{}}\n{"jsonrpc":"2.0","id":2,"resu');
    expect(resolved).toEqual({});
    feed('lt":{"b":2}}\n{"jsonrpc":"2.0","id":1,"result":{"a":1}}\n');
    feed('{"jsonrpc":"2.0","id":3,"error":{"code":7,"message":"boom"}}\n');

    expect(resolved[1]).toEqual({ a: 1 });
    expect(resolved[2]).toEqual({ b: 2 });
    expect(rejected[3]).toBe("boom");
    expect(pending.size).toBe(0);
  });

  it("drops a response whose id has no pending request", () => {
    const buf = createLineBuffer();
    const pending = new Set<number>([1]);
    const seen: number[] = [];
    for (const msg of buf.push('{"jsonrpc":"2.0","id":99,"result":1}\n')) {
      const c = classifyRpcMessage(msg);
      if (c.kind !== "ignore" && pending.has(c.id as number)) seen.push(c.id as number);
    }
    expect(seen).toEqual([]);
  });
});
