import { describe, expect, it } from "vitest";
import {
  DEFAULT_REMEMBER_META,
  buildRememberPlan,
  entriesFromTopics,
  formatList,
  resolveShow,
} from "./commands.js";
import type { IndexEntry, ParsedTopic } from "./types.js";

const topic = (over: Partial<ParsedTopic>): ParsedTopic => ({
  path: over.path ?? "/m/t.md",
  name: over.name ?? "",
  description: over.description ?? "",
  type: over.type ?? "project",
  body: over.body ?? "",
});

const entry = (over: Partial<IndexEntry>): IndexEntry => ({
  name: over.name ?? "T",
  description: over.description ?? "",
  type: over.type ?? "project",
  path: over.path ?? "t.md",
});

describe("entriesFromTopics", () => {
  it("derives memory-dir-relative paths", () => {
    const entries = entriesFromTopics(
      [topic({ path: "/m/auth.md", name: "Auth", type: "user" })],
      "/m",
    );
    expect(entries).toEqual([
      { name: "Auth", description: "", type: "user", path: "auth.md" },
    ]);
  });
});

describe("formatList", () => {
  it("returns a hint when empty", () => {
    expect(formatList([])).toContain("No memory topics yet");
  });

  it("groups entries by type", () => {
    const out = formatList([
      entry({ name: "Prefs", type: "user", path: "prefs.md" }),
      entry({ name: "Arch", type: "project", path: "arch.md" }),
    ]);
    expect(out).toContain("user:");
    expect(out).toContain("Prefs");
    expect(out).toContain("project:");
    expect(out).toContain("Arch");
  });
});

describe("resolveShow", () => {
  const entries = [
    entry({ name: "Auth", path: "auth.md" }),
    entry({ name: "Build steps", path: "build.md" }),
  ];

  it("errors on empty arg", () => {
    const r = resolveShow("", entries);
    expect(r.ok).toBe(false);
  });

  it("matches by name (case-insensitive)", () => {
    const r = resolveShow("auth", entries);
    expect(r).toEqual({ ok: true, path: "auth.md", name: "Auth" });
  });

  it("matches by filename and partial name", () => {
    expect(resolveShow("build.md", entries)).toMatchObject({ ok: true, path: "build.md" });
    expect(resolveShow("build", entries)).toMatchObject({ ok: true, path: "build.md" });
    expect(resolveShow("steps", entries)).toMatchObject({ ok: true, name: "Build steps" });
  });

  it("errors on miss", () => {
    expect(resolveShow("nope", entries).ok).toBe(false);
  });
});

describe("buildRememberPlan", () => {
  const now = new Date("2026-07-22T10:00:00Z");

  it("creates a new default topic when none exists", () => {
    const plan = buildRememberPlan("prefers tabs", [], "/m", { now });
    expect(plan.isNew).toBe(true);
    expect(plan.path).toBe("/m/general-notes.md");
    expect(plan.entry.path).toBe("general-notes.md");
    expect(plan.entry.name).toBe(DEFAULT_REMEMBER_META.name);
    expect(plan.bullet).toBe("- 2026-07-22: prefers tabs");
    expect(plan.content).toContain("type: project");
    expect(plan.content).toContain("- 2026-07-22: prefers tabs");
  });

  it("appends to an existing target topic, preserving its meta", () => {
    const existing = topic({
      path: "/m/general-notes.md",
      name: "General notes",
      description: "misc",
      type: "reference",
      body: "- 2026-01-01: earlier fact",
    });
    const plan = buildRememberPlan("newer fact", [existing], "/m", { now });
    expect(plan.isNew).toBe(false);
    expect(plan.entry.type).toBe("reference");
    expect(plan.content).toContain("- 2026-01-01: earlier fact");
    expect(plan.content).toContain("- 2026-07-22: newer fact");
  });

  it("honors a custom target meta", () => {
    const plan = buildRememberPlan("x", [], "/m", {
      now,
      targetMeta: { name: "Coding Style", description: "d", type: "user" },
    });
    expect(plan.path).toBe("/m/coding-style.md");
    expect(plan.entry.type).toBe("user");
  });
});
