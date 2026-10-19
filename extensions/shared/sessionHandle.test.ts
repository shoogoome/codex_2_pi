import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { attachSessionHandle, getSessionHandle, type SessionHandleHost } from "./sessionHandle.js";

function directHost(): SessionHandleHost {
  return { events: {} };
}

/** Mirrors pi 0.84+ `createExtensionAPI`: per-extension facade over one EventBus. */
function sharedBusHosts(): { owner: SessionHandleHost; consumer: SessionHandleHost } {
  const emitter = new EventEmitter();
  const facade = (): SessionHandleHost => ({
    events: {
      emit(channel, data) {
        emitter.emit(channel, data);
      },
      on(channel, handler) {
        const safeHandler = async (data: unknown) => {
          await handler(data);
        };
        emitter.on(channel, safeHandler);
        return () => emitter.off(channel, safeHandler);
      },
    },
  });
  return { owner: facade(), consumer: facade() };
}

describe("sessionHandle", () => {
  it("round-trips on the same events object via the direct property", () => {
    const host = directHost();
    const handle = { id: 1 };
    attachSessionHandle(host, "k", handle);
    expect(getSessionHandle(host, "k")).toBe(handle);
  });

  it("returns undefined when nothing is attached", () => {
    expect(getSessionHandle(directHost(), "k")).toBeUndefined();
  });

  it("finds a handle across isolated pi.events facades that share one EventBus", () => {
    const { owner, consumer } = sharedBusHosts();
    const handle = { id: "shared" };
    attachSessionHandle(owner, "__pi_tasks_handle__", handle);
    expect((consumer.events as Record<string, unknown>).__pi_tasks_handle__).toBeUndefined();
    expect(getSessionHandle(consumer, "__pi_tasks_handle__")).toBe(handle);
  });

  it("last attach wins when the same key is republished on the shared bus", () => {
    const { owner, consumer } = sharedBusHosts();
    attachSessionHandle(owner, "k", { n: 1 });
    attachSessionHandle(owner, "k", { n: 2 });
    expect(getSessionHandle(consumer, "k")).toEqual({ n: 2 });
  });
});
