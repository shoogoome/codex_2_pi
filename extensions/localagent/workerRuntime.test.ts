import { describe, expect, it } from "vitest";
import { buildWorkerRuntime } from "./workerRuntime.js";
import type { FastModeState } from "../fast-mode/core.js";
import { isForkWorker, registerForkWorker } from "./workerIdentity.js";
import { setAgentMutationPaused, _resetAgentMutationPauseForTest } from "../shared/agentMutationPause.js";
afterEach(() => _resetAgentMutationPauseForTest());

function harness(read: () => FastModeState, oauth = true) {
  const handlers = new Map<string, (...args: any[]) => any>();
  buildWorkerRuntime(read)({ on: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn) } as never);
  const ctx = { model: { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.6-sol" },
    modelRegistry: { isUsingOAuth: () => oauth } };
  return { handlers, ctx, request: (payload: unknown) => handlers.get("before_provider_request")!({ payload }, ctx) };
}

describe("leaf worker runtime", () => {
  it("follows off → Fast → UltraFast → off without changing prior payloads", () => {
    let state: FastModeState = { enabled: false };
    const h = harness(() => state);
    const payload = { model: h.ctx.model.id, input: [] };
    expect(h.request(payload)).toBeUndefined();
    state = { enabled: true, tier: "priority" };
    const fast = h.request(payload);
    expect(fast.service_tier).toBe("priority");
    state = { enabled: true, tier: "ultrafast" };
    expect(h.request(payload).service_tier).toBe("ultrafast");
    expect(fast.service_tier).toBe("priority");
    state = { enabled: false };
    expect(h.request(payload)).toBeUndefined();
    expect(payload).not.toHaveProperty("service_tier");
  });

  it("does not touch API-key/non-Codex requests or unrelated tier overrides", () => {
    const h = harness(() => ({ enabled: true }), false);
    expect(h.request({ input: [] })).toBeUndefined();
    const other = harness(() => ({ enabled: true }));
    other.ctx.model.provider = "other";
    expect(other.request({ input: [] })).toBeUndefined();
    const off = harness(() => ({ enabled: false }));
    expect(off.request({ service_tier: "external" })).toBeUndefined();
  });

  it.each(["task_agent", "team_create"])("blocks %s even if re-exposed by another extension", (toolName) => {
    const h = harness(() => ({ enabled: false }));
    const call = h.handlers.get("tool_call")!;
    expect(call({ toolName, input: { team_name: "x", name: "y" } })).toMatchObject({ block: true });
    expect(call({ toolName: "read", input: {} })).toBeUndefined();
    expect(h.handlers.has("session_start")).toBe(false);
  });

  it("honors a root Plan transition in already running workers without changing tool declarations", () => {
    const h = harness(() => ({ enabled: false }));
    const call = h.handlers.get("tool_call")!;
    expect(call({ toolName: "write", input: {} })).toBeUndefined();
    setAgentMutationPaused(true);
    expect(call({ toolName: "write", input: {} })).toMatchObject({ block: true });
    expect(call({ toolName: "bash", input: { command: "echo x > a.txt" } })).toMatchObject({ block: true });
    expect(call({ toolName: "mcp__server__mutate", input: {} })).toMatchObject({ block: true });
    expect(call({ toolName: "read", input: {} })).toBeUndefined();
    expect(call({ toolName: "bash", input: { command: "git status --short" } })).toBeUndefined();
    setAgentMutationPaused(false);
    expect(call({ toolName: "write", input: {} })).toBeUndefined();
  });

  it("worker identity is session-scoped, survives empty history, and releases idempotently", () => {
    const release = registerForkWorker("/tmp/worker-runtime-test");
    expect(isForkWorker("/tmp/worker-runtime-test")).toBe(true);
    expect(isForkWorker("/tmp/parent-runtime-test")).toBe(false);
    release(); release();
    expect(isForkWorker("/tmp/worker-runtime-test")).toBe(false);
  });
});
