import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";

import resumePickerExtension, { labeledOptions } from "./index.js";
import {
  filterByTitle,
  formatSessionLabel,
  paginate,
  parseResumeArgs,
  projectLabel,
  relativeTime,
  sortByModified,
  summaryOf,
  toRows,
  type SessionRow,
} from "./src/sessions.js";
import {
  buildRgArgs,
  cleanSnippet,
  formatSearchLabel,
  inMemoryFallback,
  mapHitsToSessions,
  parseRgJson,
} from "./src/search.js";

// --------------------------------------------------------------------------
// fixtures
// --------------------------------------------------------------------------

function makeInfo(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    path: "/store/x.jsonl",
    id: "x",
    cwd: "/home/me/projX",
    name: undefined,
    created: new Date("2026-07-20T10:00:00.000Z"),
    modified: new Date("2026-07-20T10:00:00.000Z"),
    messageCount: 1,
    firstMessage: "hello world",
    allMessagesText: "hello world",
    ...overrides,
  };
}

function makeRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "x",
    path: "/store/x.jsonl",
    cwd: "/home/me/projX",
    name: undefined,
    summary: "hello world",
    modified: new Date("2026-07-20T10:00:00.000Z"),
    messageCount: 1,
    ...overrides,
  };
}

// --------------------------------------------------------------------------
// sessions.ts — pure logic
// --------------------------------------------------------------------------

describe("sessions — summaryOf", () => {
  it("prefers name, then firstMessage, then fallback", () => {
    expect(summaryOf({ name: "  Deploy work ", firstMessage: "first" })).toBe("Deploy work");
    expect(summaryOf({ name: undefined, firstMessage: "  fix login " })).toBe("fix login");
    expect(summaryOf({ name: "", firstMessage: "" })).toBe("(no messages)");
  });
});

describe("sessions — projectLabel", () => {
  it("labels home as ~, empty as unknown, else basename", () => {
    expect(projectLabel("")).toBe("(unknown)");
    expect(projectLabel("/home/me/work/api")).toBe("api");
  });
});

describe("sessions — relativeTime", () => {
  const now = new Date("2026-07-20T12:00:00.000Z");
  it("renders escalating units and guards future/invalid", () => {
    expect(relativeTime(new Date(now.getTime() - 5_000), now)).toBe("just now");
    expect(relativeTime(new Date(now.getTime() - 3 * 60_000), now)).toBe("3m ago");
    expect(relativeTime(new Date(now.getTime() - 5 * 3_600_000), now)).toBe("5h ago");
    expect(relativeTime(new Date(now.getTime() - 2 * 86_400_000), now)).toBe("2d ago");
    expect(relativeTime(new Date(now.getTime() + 10_000), now)).toBe("just now");
  });
});

describe("sessions — parseResumeArgs", () => {
  it("extracts --all/-a flag and joins the rest into a filter", () => {
    expect(parseResumeArgs("")).toEqual({ all: false, filter: "" });
    expect(parseResumeArgs("--all")).toEqual({ all: true, filter: "" });
    expect(parseResumeArgs("-a login bug")).toEqual({ all: true, filter: "login bug" });
    expect(parseResumeArgs("  refactor  parser ")).toEqual({ all: false, filter: "refactor parser" });
  });
});

describe("sessions — toRows / filter / sort / paginate", () => {
  it("projects SessionInfo into rows with derived summary", () => {
    const [row] = toRows([makeInfo({ name: "Named", firstMessage: "ignored" })]);
    expect(row.summary).toBe("Named");
    expect(row.path).toBe("/store/x.jsonl");
  });

  it("filterByTitle matches summary, name and project label (case-insensitive)", () => {
    const rows = [
      makeRow({ id: "a", summary: "Fix login" }),
      makeRow({ id: "b", summary: "Add search", cwd: "/home/me/webapp" }),
    ];
    expect(filterByTitle(rows, "LOGIN").map((r) => r.id)).toEqual(["a"]);
    expect(filterByTitle(rows, "webapp").map((r) => r.id)).toEqual(["b"]);
    expect(filterByTitle(rows, "").length).toBe(2);
  });

  it("sortByModified is newest-first and non-mutating", () => {
    const older = makeRow({ id: "old", modified: new Date("2026-07-01T00:00:00Z") });
    const newer = makeRow({ id: "new", modified: new Date("2026-07-19T00:00:00Z") });
    const input = [older, newer];
    expect(sortByModified(input).map((r) => r.id)).toEqual(["new", "old"]);
    expect(input.map((r) => r.id)).toEqual(["old", "new"]); // untouched
  });

  it("paginate slices 0-based pages", () => {
    const items = [1, 2, 3, 4, 5];
    expect(paginate(items, 0, 2)).toEqual([1, 2]);
    expect(paginate(items, 1, 2)).toEqual([3, 4]);
    expect(paginate(items, 2, 2)).toEqual([5]);
    expect(paginate(items, 0, 0)).toEqual([]);
  });
});

describe("sessions — formatSessionLabel", () => {
  const now = new Date("2026-07-20T12:00:00.000Z");
  it("omits project by default, includes it when showProject", () => {
    const row = makeRow({
      summary: "Fix login",
      messageCount: 12,
      modified: new Date(now.getTime() - 3 * 60_000),
    });
    expect(formatSessionLabel(row, {}, now)).toBe("3m ago · Fix login (12 msgs)");
    expect(formatSessionLabel(row, { showProject: true }, now)).toBe(
      "3m ago · projX · Fix login (12 msgs)",
    );
  });

  it("singularises message count and collapses multi-line summaries", () => {
    const row = makeRow({ summary: "line one\n  line two", messageCount: 1 });
    const label = formatSessionLabel(row, {}, now);
    expect(label).toContain("line one line two");
    expect(label).toContain("(1 msg)");
  });
});

// --------------------------------------------------------------------------
// search.ts — pure logic
// --------------------------------------------------------------------------

describe("search — buildRgArgs", () => {
  it("uses fixed-string, json, jsonl glob and terminates flags", () => {
    const args = buildRgArgs("-weird--kw", "/root/sessions");
    expect(args).toEqual([
      "--json",
      "-F",
      "--no-messages",
      "-g",
      "*.jsonl",
      "--",
      "-weird--kw",
      "/root/sessions",
    ]);
  });
});

describe("search — parseRgJson", () => {
  it("keeps only match rows and tolerates non-JSON / other event types", () => {
    const stdout = [
      JSON.stringify({ type: "begin", data: { path: { text: "/a.jsonl" } } }),
      "not json",
      JSON.stringify({
        type: "match",
        data: { path: { text: "/a.jsonl" }, line_number: 4, lines: { text: "matched line" } },
      }),
      JSON.stringify({ type: "end" }),
    ].join("\n");
    const hits = parseRgJson(stdout);
    expect(hits).toEqual([{ file: "/a.jsonl", lineNumber: 4, text: "matched line" }]);
  });
});

describe("search — cleanSnippet", () => {
  it("extracts message text from a jsonl line and centres on the query", () => {
    const line = JSON.stringify({
      type: "message",
      message: { role: "user", content: "please deploy the pipeline now" },
    });
    expect(cleanSnippet(line, "deploy")).toBe("please deploy the pipeline now");
  });

  it("degrades to raw text on non-json lines", () => {
    expect(cleanSnippet("raw    text  here", "text")).toBe("raw text here");
  });
});

describe("search — mapHitsToSessions", () => {
  it("groups hits per file, counts them, and joins to sessions newest-first", () => {
    const infos = [
      makeInfo({ id: "a", path: "/store/a.jsonl", modified: new Date("2026-07-10T00:00:00Z") }),
      makeInfo({ id: "b", path: "/store/b.jsonl", modified: new Date("2026-07-19T00:00:00Z") }),
    ];
    const hits = [
      { file: "/store/a.jsonl", lineNumber: 1, text: "alpha deploy" },
      { file: "/store/a.jsonl", lineNumber: 2, text: "beta deploy" },
      { file: "/store/b.jsonl", lineNumber: 5, text: "gamma deploy" },
      { file: "/store/missing.jsonl", lineNumber: 9, text: "ignored" },
    ];
    const results = mapHitsToSessions(hits, infos, "deploy");
    expect(results.map((r) => r.session.id)).toEqual(["b", "a"]); // newest first
    const a = results.find((r) => r.session.id === "a")!;
    expect(a.count).toBe(2);
    expect(a.line).toBe(1); // first hit wins
  });
});

describe("search — inMemoryFallback", () => {
  it("substring-matches allMessagesText, newest-first, empty query => none", () => {
    const infos = [
      makeInfo({ id: "a", allMessagesText: "nothing here", modified: new Date("2026-07-10T00:00:00Z") }),
      makeInfo({ id: "b", allMessagesText: "please DEPLOY it", modified: new Date("2026-07-19T00:00:00Z") }),
    ];
    expect(inMemoryFallback(infos, "deploy").map((r) => r.session.id)).toEqual(["b"]);
    expect(inMemoryFallback(infos, "")).toEqual([]);
  });
});

describe("search — formatSearchLabel", () => {
  const now = new Date("2026-07-20T12:00:00.000Z");
  it("renders time, project, hit count and snippet", () => {
    const result = {
      session: makeRow({ cwd: "/home/me/projX", modified: new Date(now.getTime() - 3_600_000) }),
      snippet: "matched here",
      line: 2,
      count: 3,
    };
    expect(formatSearchLabel(result, now)).toBe("1h ago · projX · 3 hits: matched here");
    expect(formatSearchLabel({ ...result, count: 1 }, now)).toBe(
      "1h ago · projX · 1 hit: matched here",
    );
  });
});

// --------------------------------------------------------------------------
// index.ts helpers
// --------------------------------------------------------------------------

describe("index — labeledOptions", () => {
  it("index-prefixes options (unique even on duplicate labels) and resolves back", () => {
    const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const { options, pick } = labeledOptions(items, () => "same");
    expect(options).toEqual(["1. same", "2. same", "3. same"]);
    expect(pick("2. same")).toBe(items[1]);
    expect(pick(undefined)).toBeUndefined();
    expect(pick("nope")).toBeUndefined();
  });
});

// --------------------------------------------------------------------------
// SessionManager.list integration — real parsing over temp fixtures
// --------------------------------------------------------------------------

describe("SessionManager.list over temp fixtures feeds toRows/summaryOf", () => {
  it("parses header + messages + session_info and our transforms label them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "resume-picker-"));
    try {
      const older = [
        JSON.stringify({ type: "session", id: "s-old", cwd: "/home/me/projX", timestamp: "2026-07-10T00:00:00.000Z" }),
        JSON.stringify({ type: "message", message: { role: "user", content: "fix the login bug", timestamp: 1_700_000_000_000 } }),
      ].join("\n");
      const newer = [
        JSON.stringify({ type: "session", id: "s-new", cwd: "/home/me/webapp", timestamp: "2026-07-19T00:00:00.000Z" }),
        JSON.stringify({ type: "session_info", name: "Search feature" }),
        JSON.stringify({ type: "message", message: { role: "user", content: "add fulltext search", timestamp: 1_800_000_000_000 } }),
        JSON.stringify({ type: "message", message: { role: "assistant", content: "on it", timestamp: 1_800_000_100_000 } }),
      ].join("\n");
      writeFileSync(join(dir, "old.jsonl"), older);
      writeFileSync(join(dir, "new.jsonl"), newer);

      const infos = await SessionManager.list("/home/me/projX", dir);
      const rows = sortByModified(toRows(infos));

      // newest (larger message timestamp) first
      expect(rows.map((r) => r.id)).toEqual(["s-new", "s-old"]);

      const named = rows.find((r) => r.id === "s-new")!;
      expect(named.summary).toBe("Search feature"); // session_info name wins
      expect(named.messageCount).toBe(2);

      const plain = rows.find((r) => r.id === "s-old")!;
      expect(plain.summary).toBe("fix the login bug"); // first user message

      // filter works against real data
      expect(filterByTitle(rows, "search").map((r) => r.id)).toEqual(["s-new"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --------------------------------------------------------------------------
// command wiring — fake ctx / fake pi
// --------------------------------------------------------------------------

afterEach(() => {
  vi.restoreAllMocks();
});

interface FakePi {
  commands: Map<string, any>;
  registerCommand: ReturnType<typeof vi.fn>;
  exec: ReturnType<typeof vi.fn>;
}

function makePi(): FakePi {
  const commands = new Map<string, any>();
  return {
    commands,
    registerCommand: vi.fn((name: string, opts: any) => commands.set(name, opts)),
    exec: vi.fn(),
  };
}

function makeCtx(opts: {
  hasUI?: boolean;
  select?: (title: string, options: string[]) => Promise<string | undefined>;
  switchCancelled?: boolean;
} = {}) {
  const notify = vi.fn();
  const select = vi.fn(opts.select ?? (async () => undefined));
  const switchSession = vi.fn(async () => ({ cancelled: opts.switchCancelled ?? false }));
  return {
    ctx: {
      hasUI: opts.hasUI ?? true,
      cwd: "/home/me/projX",
      signal: undefined,
      switchSession,
      ui: { select, notify },
    } as any,
    notify,
    select,
    switchSession,
  };
}

function register(pi: FakePi) {
  resumePickerExtension(pi as any);
  return {
    resume: pi.commands.get("resume-picker"),
    search: pi.commands.get("search"),
  };
}

describe("index — registration", () => {
  it("registers /resume-picker and /search", () => {
    const pi = makePi();
    const { resume, search } = register(pi);
    expect(typeof resume.handler).toBe("function");
    expect(typeof search.handler).toBe("function");
    expect(typeof resume.getArgumentCompletions).toBe("function");
  });

  it("does not register a bare /resume (avoids pi's built-in)", () => {
    const pi = makePi();
    register(pi);
    expect(pi.commands.has("resume")).toBe(false);
    expect(pi.commands.has("resume-picker")).toBe(true);
  });

  it("/resume-picker completions only fire for a dash prefix", () => {
    const pi = makePi();
    const { resume } = register(pi);
    expect(resume.getArgumentCompletions("login")).toBeNull();
    expect(resume.getArgumentCompletions("--").map((c: any) => c.value)).toEqual(["--all"]);
  });
});

describe("index — /resume-picker", () => {
  it("selecting a session switches to its path", async () => {
    const pi = makePi();
    const { resume } = register(pi);
    vi.spyOn(SessionManager, "list").mockResolvedValue([
      makeInfo({ id: "a", path: "/store/a.jsonl", firstMessage: "alpha", modified: new Date("2026-07-19T00:00:00Z") }),
      makeInfo({ id: "b", path: "/store/b.jsonl", firstMessage: "beta", modified: new Date("2026-07-10T00:00:00Z") }),
    ]);
    // pick the second option -> row "b"
    const { ctx, switchSession } = makeCtx({ select: async (_t, options) => options[1] });
    await resume.handler("", ctx);
    expect(switchSession).toHaveBeenCalledWith("/store/b.jsonl");
  });

  it("--all lists across projects via listAll", async () => {
    const pi = makePi();
    const { resume } = register(pi);
    const listAll = vi.spyOn(SessionManager, "listAll").mockResolvedValue([
      makeInfo({ id: "a", path: "/store/a.jsonl" }),
    ]);
    const { ctx, switchSession } = makeCtx({ select: async (_t, options) => options[0] });
    await resume.handler("--all", ctx);
    expect(listAll).toHaveBeenCalled();
    expect(switchSession).toHaveBeenCalledWith("/store/a.jsonl");
  });

  it("cancelling the picker does not switch", async () => {
    const pi = makePi();
    const { resume } = register(pi);
    vi.spyOn(SessionManager, "list").mockResolvedValue([makeInfo({ path: "/store/a.jsonl" })]);
    const { ctx, switchSession } = makeCtx({ select: async () => undefined });
    await resume.handler("", ctx);
    expect(switchSession).not.toHaveBeenCalled();
  });

  it("no sessions => notifies and never opens the picker", async () => {
    const pi = makePi();
    const { resume } = register(pi);
    vi.spyOn(SessionManager, "list").mockResolvedValue([]);
    const { ctx, select, notify } = makeCtx();
    await resume.handler("", ctx);
    expect(select).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("No sessions"), "info");
  });

  it("non-UI mode warns and does not list", async () => {
    const pi = makePi();
    const { resume } = register(pi);
    const list = vi.spyOn(SessionManager, "list").mockResolvedValue([]);
    const { ctx, notify } = makeCtx({ hasUI: false });
    await resume.handler("", ctx);
    expect(list).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("interactive"), "warning");
  });

  it("reports a cancelled switch", async () => {
    const pi = makePi();
    const { resume } = register(pi);
    vi.spyOn(SessionManager, "list").mockResolvedValue([makeInfo({ path: "/store/a.jsonl" })]);
    const { ctx, notify } = makeCtx({
      select: async (_t, options) => options[0],
      switchCancelled: true,
    });
    await resume.handler("", ctx);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("cancelled"), "info");
  });
});

describe("index — /search", () => {
  it("empty keyword warns with usage", async () => {
    const pi = makePi();
    const { search } = register(pi);
    const { ctx, notify } = makeCtx();
    await search.handler("   ", ctx);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Usage"), "warning");
  });

  it("rg hits map to sessions and selection resumes the hit", async () => {
    const pi = makePi();
    const { search } = register(pi);
    vi.spyOn(SessionManager, "listAll").mockResolvedValue([
      makeInfo({ id: "a", path: "/store/a.jsonl", modified: new Date("2026-07-19T00:00:00Z") }),
    ]);
    const rgLine = JSON.stringify({
      type: "match",
      data: {
        path: { text: "/store/a.jsonl" },
        line_number: 3,
        lines: {
          text: JSON.stringify({ type: "message", message: { role: "user", content: "deploy the pipeline" } }),
        },
      },
    });
    pi.exec.mockResolvedValue({ stdout: rgLine, stderr: "", code: 0, killed: false });

    const { ctx, switchSession } = makeCtx({ select: async (_t, options) => options[0] });
    await search.handler("deploy", ctx);

    expect(pi.exec).toHaveBeenCalledWith("rg", expect.arrayContaining(["--json", "deploy"]), expect.any(Object));
    expect(switchSession).toHaveBeenCalledWith("/store/a.jsonl");
  });

  it("falls back to in-memory search when rg is unavailable (exec throws)", async () => {
    const pi = makePi();
    const { search } = register(pi);
    vi.spyOn(SessionManager, "listAll").mockResolvedValue([
      makeInfo({ id: "a", path: "/store/a.jsonl", allMessagesText: "we should deploy soon" }),
    ]);
    pi.exec.mockRejectedValue(new Error("spawn rg ENOENT"));

    const { ctx, switchSession } = makeCtx({ select: async (_t, options) => options[0] });
    await search.handler("deploy", ctx);
    expect(switchSession).toHaveBeenCalledWith("/store/a.jsonl");
  });

  it("no matches (rg exit 1) notifies without falling back", async () => {
    const pi = makePi();
    const { search } = register(pi);
    vi.spyOn(SessionManager, "listAll").mockResolvedValue([
      makeInfo({ id: "a", path: "/store/a.jsonl", allMessagesText: "would have matched in fallback" }),
    ]);
    pi.exec.mockResolvedValue({ stdout: "", stderr: "", code: 1, killed: false });

    const { ctx, notify, switchSession } = makeCtx({ select: async (_t, options) => options[0] });
    await search.handler("deploy", ctx);
    expect(switchSession).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("No sessions matched"), "info");
  });
});
