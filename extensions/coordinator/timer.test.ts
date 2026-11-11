import { createDiagnosticTimer } from "./timer.js";

const stale = () => new Error("This extension ctx is stale after session replacement or reload.");

describe("coordinator diagnostic timer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.clearAllTimers(); vi.restoreAllMocks(); vi.useRealTimers(); });

  function harness() {
    let enabled = false;
    let alive = true;
    const run = vi.fn();
    const reportError = vi.fn();
    const timer = createDiagnosticTimer({ enabled: () => enabled, ownerActive: () => alive, run, reportError });
    return { timer, run, reportError, enable(value: boolean) { enabled = value; }, close() { alive = false; } };
  }

  it("creates no interval while off and keeps exactly one across on/off cycles", () => {
    const h = harness();
    h.timer.sync();
    expect(vi.getTimerCount()).toBe(0);
    h.enable(true);
    h.timer.sync(); h.timer.sync();
    expect(vi.getTimerCount()).toBe(1);
    h.enable(false);
    h.timer.sync();
    expect(vi.getTimerCount()).toBe(0);
    h.enable(true);
    h.timer.sync();
    vi.advanceTimersByTime(10000);
    expect(h.run).toHaveBeenCalledTimes(1);
  });

  it("stops a closed owner before any run/API call without a shutdown event", () => {
    const h = harness();
    h.enable(true); h.timer.sync(); h.close();
    vi.advanceTimersByTime(10000);
    expect(h.run).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(h.reportError).not.toHaveBeenCalled();
  });

  it("catches stale API failures when direct SDK invalidation did not close the owner guard", () => {
    const h = harness();
    h.run.mockImplementation(() => { throw stale(); });
    h.enable(true); h.timer.sync();
    expect(() => vi.advanceTimersByTime(10000)).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
    expect(h.reportError).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60000);
    expect(h.run).toHaveBeenCalledTimes(1);
  });

  it("reports genuine errors and stops even if the reporter also throws", () => {
    const h = harness();
    const error = new Error("diagnostic failed");
    h.run.mockImplementation(() => { throw error; });
    h.reportError.mockImplementation(() => { throw new Error("reporter unavailable"); });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    h.enable(true); h.timer.sync();
    expect(() => vi.advanceTimersByTime(10000)).not.toThrow();
    expect(h.reportError).toHaveBeenCalledWith(error);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("error reporter failed"));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("contains gate errors inside the same boundary", () => {
    const reportError = vi.fn();
    let failGate = false;
    const timer = createDiagnosticTimer({
      enabled: () => true,
      ownerActive: () => { if (failGate) throw new Error("owner guard failed"); return true; },
      run: vi.fn(), reportError,
    });
    timer.sync(); failGate = true;
    expect(() => vi.advanceTimersByTime(10000)).not.toThrow();
    expect(reportError).toHaveBeenCalledWith(expect.objectContaining({ message: "owner guard failed" }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores already queued callbacks from a stopped generation", () => {
    const callbacks: Array<() => void> = [];
    const original = globalThis.setInterval;
    vi.spyOn(globalThis, "setInterval").mockImplementation((callback, delay, ...args) => {
      callbacks.push(() => callback(...args));
      return original(callback, delay, ...args);
    });
    const h = harness();
    h.enable(true); h.timer.sync();
    h.timer.stop(); h.timer.sync();
    h.close();
    callbacks[0](); // It must not stop the new timer, even though the owner closed.
    expect(vi.getTimerCount()).toBe(1);
    expect(h.run).not.toHaveBeenCalled();
    callbacks[1]();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not stop a replacement if a reentrant run replaces the timer before failing", () => {
    const h = harness();
    h.run.mockImplementationOnce(() => {
      h.timer.stop(); h.timer.sync();
      throw stale();
    });
    h.enable(true); h.timer.sync();
    vi.advanceTimersByTime(10000);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(10000);
    expect(h.run).toHaveBeenCalledTimes(2);
  });
});
