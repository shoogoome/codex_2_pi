import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { installInputHistory } from "./index.js";
import { readRecent } from "./src/store.js";

type InputHandler = (
  event: { type: "input"; text: string; source: string },
  ctx: { cwd: string },
) => unknown;

interface FakePi {
  on: ReturnType<typeof vi.fn>;
  registerShortcut: ReturnType<typeof vi.fn>;
  registerFlag: ReturnType<typeof vi.fn>;
  getFlag: ReturnType<typeof vi.fn>;
  inputHandler?: InputHandler;
  shortcut?: { key: string; options: any };
  /** Seed a flag value as if provided on the CLI (overrides registerFlag default). */
  setFlag: (name: string, value: string) => void;
}

function createPi(): FakePi {
  const flags = new Map<string, string | boolean | undefined>();
  const pi: FakePi = {
    on: vi.fn((event: string, handler: InputHandler) => {
      if (event === "input") pi.inputHandler = handler;
    }),
    registerFlag: vi.fn((name: string, options: any) => {
      // Mirror pi's loader: default seeds the value only if not already set.
      if (options?.default !== undefined && !flags.has(name)) flags.set(name, options.default);
    }),
    getFlag: vi.fn((name: string) => flags.get(name)),
    registerShortcut: vi.fn((key: string, options: any) => {
      pi.shortcut = { key, options };
    }),
    setFlag: (name: string, value: string) => {
      flags.set(name, value);
    },
  };
  return pi;
}

function withTempPath<T>(fn: (path: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "input-history-index-"));
  try {
    return fn(join(dir, ".pi", "agent", "input-history.jsonl"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function fire(pi: FakePi, text: string, source = "interactive", cwd = "/work"): unknown {
  return pi.inputHandler?.({ type: "input", text, source }, { cwd });
}

describe("installInputHistory wiring", () => {
  it("registers an input handler and a reverse-search shortcut on the default (non-ctrl+r) key", () => {
    withTempPath((path) => {
      const pi = createPi();
      installInputHistory(pi as any, path);
      expect(pi.on).toHaveBeenCalledWith("input", expect.any(Function));
      // Default open key must NOT be ctrl+r (pi binds that to app.session.rename).
      expect(pi.shortcut?.key).not.toBe("ctrl+r");
      expect(pi.shortcut?.key).toBe("alt+r");
      expect(typeof pi.shortcut?.options.handler).toBe("function");
    });
  });

  it("registers the search-key flag (string, default alt+r)", () => {
    withTempPath((path) => {
      const pi = createPi();
      installInputHistory(pi as any, path);
      expect(pi.registerFlag).toHaveBeenCalledWith(
        "input-history-search-key",
        expect.objectContaining({ type: "string", default: "alt+r" }),
      );
    });
  });

  it("binds the configured key from the flag instead of the default", () => {
    withTempPath((path) => {
      const pi = createPi();
      // Simulate `--input-history-search-key ctrl+shift+r` on the CLI.
      pi.setFlag("input-history-search-key", "ctrl+shift+r");
      installInputHistory(pi as any, path);
      expect(pi.shortcut?.key).toBe("ctrl+shift+r");
    });
  });

  it("falls back to the default key when the flag is blank", () => {
    withTempPath((path) => {
      const pi = createPi();
      pi.setFlag("input-history-search-key", "   ");
      installInputHistory(pi as any, path);
      expect(pi.shortcut?.key).toBe("alt+r");
    });
  });

  it("always returns { action: 'continue' } so it never blocks input", () => {
    withTempPath((path) => {
      const pi = createPi();
      installInputHistory(pi as any, path);
      expect(fire(pi, "hello")).toEqual({ action: "continue" });
      expect(fire(pi, "")).toEqual({ action: "continue" });
      expect(fire(pi, "/help")).toEqual({ action: "continue" });
    });
  });

  it("captures ordinary interactive text (with cwd) to the file", () => {
    withTempPath((path) => {
      const pi = createPi();
      installInputHistory(pi as any, path);
      fire(pi, "build the app", "interactive", "/repo");
      const entries = readRecent(path);
      expect(entries).toHaveLength(1);
      expect(entries[0].text).toBe("build the app");
      expect(entries[0].cwd).toBe("/repo");
      expect(typeof entries[0].ts).toBe("number");
    });
  });

  it("does not store slash-commands or empty / whitespace-only input", () => {
    withTempPath((path) => {
      const pi = createPi();
      installInputHistory(pi as any, path);
      fire(pi, "/clear");
      fire(pi, "  /help");
      fire(pi, "");
      fire(pi, "   ");
      expect(readRecent(path)).toEqual([]);
    });
  });

  it("ignores non-interactive sources (rpc / extension)", () => {
    withTempPath((path) => {
      const pi = createPi();
      installInputHistory(pi as any, path);
      fire(pi, "from rpc", "rpc");
      fire(pi, "from extension", "extension");
      expect(readRecent(path)).toEqual([]);
    });
  });

  it("de-dupes consecutive identical prompts but keeps distinct ones", () => {
    withTempPath((path) => {
      const pi = createPi();
      installInputHistory(pi as any, path);
      fire(pi, "same");
      fire(pi, "  same  "); // trimmed-equal to previous → skipped
      fire(pi, "different");
      fire(pi, "same"); // not consecutive-equal now → stored again
      expect(readRecent(path).map((e) => e.text)).toEqual(["same", "different", "same"]);
    });
  });
});
