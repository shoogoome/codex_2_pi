import { describe, expect, it } from "vitest";
import {
  extractKeywords,
  scoreTopic,
  selectTopics,
  truncateBody,
} from "./recall.js";
import type { ParsedTopic } from "./types.js";

function topic(over: Partial<ParsedTopic>): ParsedTopic {
  return {
    path: over.path ?? "/m/t.md",
    name: over.name ?? "",
    description: over.description ?? "",
    type: over.type ?? "project",
    body: over.body ?? "",
  };
}

describe("extractKeywords", () => {
  it("lowercases, drops stopwords + short tokens, dedups", () => {
    expect(extractKeywords("Please FIX the Auth auth bug in login")).toEqual([
      "fix",
      "auth",
      "bug",
      "login",
    ]);
  });

  it("returns [] for empty prompt", () => {
    expect(extractKeywords("")).toEqual([]);
  });
});

describe("scoreTopic", () => {
  it("weighs name > description > body", () => {
    const t = topic({ name: "auth", description: "login flow", body: "token" });
    expect(scoreTopic(t, ["auth"])).toBe(3);
    expect(scoreTopic(t, ["login"])).toBe(2);
    expect(scoreTopic(t, ["token"])).toBe(1);
    expect(scoreTopic(t, ["auth", "login", "token"])).toBe(6);
  });

  it("is 0 with no keywords or no match", () => {
    expect(scoreTopic(topic({ name: "auth" }), [])).toBe(0);
    expect(scoreTopic(topic({ name: "auth" }), ["xyz"])).toBe(0);
  });
});

describe("truncateBody", () => {
  it("keeps short bodies intact", () => {
    expect(truncateBody("short", 1000)).toEqual({
      content: "short",
      truncated: false,
    });
    const r = truncateBody("short", 1000);
    expect(r.truncated).toBe(false);
    expect(r.content).toBe("short");
  });

  it("truncates at a line boundary with a marker", () => {
    const body = "line1\nline2\nline3\n".repeat(200);
    const r = truncateBody(body, 128);
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.content, "utf8")).toBeLessThanOrEqual(128);
    expect(r.content).toContain("[truncated:");
  });
});

describe("selectTopics", () => {
  const topics = [
    topic({ path: "a.md", name: "auth", body: "auth details" }),
    topic({ path: "b.md", name: "build", body: "build steps" }),
    topic({ path: "c.md", name: "cache", body: "auth cache" }),
  ];

  it("ranks by score, excludes zero-score, respects per-turn cap", () => {
    const { selected } = selectTopics(topics, ["auth"], { maxPerTurn: 5 });
    // a.md (name+body=4) then c.md (body=1); b.md excluded (0).
    expect(selected.map((s) => s.path)).toEqual(["a.md", "c.md"]);

    const capped = selectTopics(topics, ["auth"], { maxPerTurn: 1 });
    expect(capped.selected.map((s) => s.path)).toEqual(["a.md"]);
  });

  it("skips already-recalled topics and honors the session cap", () => {
    const skip = selectTopics(topics, ["auth"], {
      alreadyRecalled: new Set(["a.md"]),
    });
    expect(skip.selected.map((s) => s.path)).toEqual(["c.md"]);

    const capReached = selectTopics(topics, ["auth"], {
      sessionCap: 1,
      alreadyRecalled: new Set(["a.md"]),
    });
    expect(capReached.selected).toHaveLength(0);
  });
});

it("keeps tiny byte budgets and Unicode boundaries safe", () => {
  for (let max = 0; max < 200; max++) {
    const { content } = truncateBody("😀中文".repeat(100), max);
    expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(max);
    expect(content).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
  }
});
