import { describe, expect, it } from "vitest";
import {
  applyProfileToRuntime,
  buildProfileDescription,
  captureProfile,
  completeArgs,
  emptyProfileSet,
  findProfile,
  isApprovalsMode,
  isThinkingLevel,
  matchModel,
  type ModelRef,
  normalizeProfile,
  parseCommand,
  parseProfileSet,
  type Profile,
  type ProfileSet,
  removeProfile,
  serializeProfileSet,
  upsertProfile,
  validateProfileName,
} from "./profile.js";

describe("validateProfileName", () => {
  it("rejects empty and whitespace-only names", () => {
    expect(validateProfileName("")).not.toBeNull();
    expect(validateProfileName("   ")).not.toBeNull();
    expect(validateProfileName(123)).not.toBeNull();
  });
  it("accepts valid names", () => {
    expect(validateProfileName("plan")).toBeNull();
    expect(validateProfileName("  plan  ")).toBeNull();
  });
});

describe("isThinkingLevel / isApprovalsMode", () => {
  it("recognizes valid thinking levels", () => {
    expect(isThinkingLevel("high")).toBe(true);
    expect(isThinkingLevel("off")).toBe(true);
    expect(isThinkingLevel("ultra")).toBe(false);
    expect(isThinkingLevel(5)).toBe(false);
  });
  it("recognizes approvals modes loosely", () => {
    expect(isApprovalsMode("never")).toBe(true);
    expect(isApprovalsMode("on-request")).toBe(true);
    expect(isApprovalsMode("whatever")).toBe(false);
  });
});

describe("normalizeProfile", () => {
  it("throws on missing/invalid name", () => {
    expect(() => normalizeProfile({})).toThrow();
    expect(() => normalizeProfile({ name: "  " })).toThrow();
    expect(() => normalizeProfile("nope")).toThrow();
  });
  it("trims the name", () => {
    expect(normalizeProfile({ name: "  plan " }).name).toBe("plan");
  });
  it("drops an invalid thinking level", () => {
    const p = normalizeProfile({ name: "a", thinkingLevel: "bogus" });
    expect(p.thinkingLevel).toBeUndefined();
  });
  it("keeps a valid thinking level", () => {
    const p = normalizeProfile({ name: "a", thinkingLevel: "medium" });
    expect(p.thinkingLevel).toBe("medium");
  });
  it("coerces tools to a string array, dropping non-strings", () => {
    const p = normalizeProfile({ name: "a", tools: ["read", 1, "", "bash", null] });
    expect(p.tools).toEqual(["read", "bash"]);
  });
  it("drops tools when not an array", () => {
    expect(normalizeProfile({ name: "a", tools: "read" }).tools).toBeUndefined();
  });
  it("drops a malformed model", () => {
    expect(normalizeProfile({ name: "a", model: { provider: "x" } }).model).toBeUndefined();
    expect(normalizeProfile({ name: "a", model: "gpt" }).model).toBeUndefined();
  });
  it("keeps a well-formed model", () => {
    const p = normalizeProfile({ name: "a", model: { provider: "openai", id: "gpt-5" } });
    expect(p.model).toEqual({ provider: "openai", id: "gpt-5" });
  });
  it("keeps approvalsMode string and extra record", () => {
    const p = normalizeProfile({ name: "a", approvalsMode: "never", extra: { k: 1 } });
    expect(p.approvalsMode).toBe("never");
    expect(p.extra).toEqual({ k: 1 });
  });
});

describe("upsert / remove / find (case-insensitive)", () => {
  const base: ProfileSet = { profiles: [{ name: "Plan" }, { name: "Impl" }] };

  it("finds regardless of case", () => {
    expect(findProfile(base, "plan")?.name).toBe("Plan");
    expect(findProfile(base, "IMPL")?.name).toBe("Impl");
    expect(findProfile(base, "missing")).toBeUndefined();
  });

  it("upsert replaces existing by case-insensitive name", () => {
    const next = upsertProfile(base, { name: "plan", thinkingLevel: "high" });
    expect(next.profiles).toHaveLength(2);
    const found = findProfile(next, "Plan");
    expect(found?.thinkingLevel).toBe("high");
    expect(found?.name).toBe("plan");
  });

  it("upsert appends a new profile", () => {
    const next = upsertProfile(base, { name: "Review" });
    expect(next.profiles).toHaveLength(3);
    expect(findProfile(next, "review")).toBeDefined();
  });

  it("remove deletes by case-insensitive name", () => {
    const next = removeProfile(base, "PLAN");
    expect(next.profiles).toHaveLength(1);
    expect(findProfile(next, "plan")).toBeUndefined();
  });

  it("does not mutate the input set", () => {
    upsertProfile(base, { name: "x" });
    removeProfile(base, "Plan");
    expect(base.profiles).toHaveLength(2);
  });
});

describe("serialize / parse round-trip", () => {
  it("round-trips a rich profile set", () => {
    const set: ProfileSet = {
      profiles: [
        {
          name: "plan",
          model: { provider: "openai", id: "gpt-5" },
          tools: ["read", "grep"],
          thinkingLevel: "high",
          approvalsMode: "never",
          extra: { note: "planning" },
        },
        { name: "bare" },
      ],
    };
    const restored = parseProfileSet(serializeProfileSet(set));
    expect(restored).toEqual(set);
  });

  it("returns an empty set for malformed data", () => {
    expect(parseProfileSet(null)).toEqual(emptyProfileSet());
    expect(parseProfileSet({ profiles: "nope" })).toEqual(emptyProfileSet());
  });

  it("skips bad entries during parse", () => {
    const set = parseProfileSet({ profiles: [{ name: "ok" }, { noName: true }, { name: "" }] });
    expect(set.profiles).toHaveLength(1);
    expect(set.profiles[0].name).toBe("ok");
  });
});

describe("captureProfile", () => {
  it("captures full runtime state", () => {
    const p = captureProfile("snap", {
      activeTools: ["read", "bash"],
      thinkingLevel: "low",
      model: { provider: "anthropic", id: "claude" },
      approvalsMode: "on-request",
    });
    expect(p).toEqual({
      name: "snap",
      tools: ["read", "bash"],
      thinkingLevel: "low",
      model: { provider: "anthropic", id: "claude" },
      approvalsMode: "on-request",
    });
  });

  it("omits model when undefined", () => {
    const p = captureProfile("snap", { activeTools: ["read"], thinkingLevel: "low", model: undefined });
    expect(p.model).toBeUndefined();
    expect(p.tools).toEqual(["read"]);
  });

  it("drops an invalid thinking level", () => {
    const p = captureProfile("snap", { thinkingLevel: "bogus" });
    expect(p.thinkingLevel).toBeUndefined();
  });

  it("throws on an invalid name", () => {
    expect(() => captureProfile("  ", {})).toThrow();
  });
});

describe("matchModel", () => {
  const models: ModelRef[] = [
    { provider: "openai", id: "gpt-5" },
    { provider: "anthropic", id: "claude-sonnet-4-5" },
    { provider: "openai-codex", id: "gpt-5.2-codex" },
  ];

  it("prefers an exact provider+id match", () => {
    expect(matchModel(models, { provider: "openai", id: "gpt-5" })).toEqual({ provider: "openai", id: "gpt-5" });
  });

  it("falls back to id match across providers", () => {
    expect(matchModel(models, { provider: "wrong", id: "claude-sonnet-4-5" })).toEqual({
      provider: "anthropic",
      id: "claude-sonnet-4-5",
    });
  });

  it("falls back to a substring match on id", () => {
    expect(matchModel(models, { provider: "wrong", id: "codex" })).toEqual({
      provider: "openai-codex",
      id: "gpt-5.2-codex",
    });
  });

  it("matches a free-form pattern by substring", () => {
    expect(matchModel(models, "sonnet")).toEqual({ provider: "anthropic", id: "claude-sonnet-4-5" });
    expect(matchModel(models, "openai/gpt-5")).toEqual({ provider: "openai", id: "gpt-5" });
  });

  it("returns undefined when nothing matches", () => {
    expect(matchModel(models, { provider: "x", id: "zzz" })).toBeUndefined();
    expect(matchModel(models, "")).toBeUndefined();
    expect(matchModel([], "gpt")).toBeUndefined();
  });
});

describe("applyProfileToRuntime", () => {
  it("splits requested tools into valid and invalid", () => {
    const profile: Profile = { name: "p", tools: ["read", "nope", "bash"] };
    const split = applyProfileToRuntime(profile, ["read", "bash", "edit"]);
    expect(split.validTools).toEqual(["read", "bash"]);
    expect(split.invalidTools).toEqual(["nope"]);
  });

  it("handles a profile with no tools", () => {
    const split = applyProfileToRuntime({ name: "p" }, ["read"]);
    expect(split.validTools).toEqual([]);
    expect(split.invalidTools).toEqual([]);
  });
});

describe("buildProfileDescription", () => {
  it("joins present fields with a pipe", () => {
    const desc = buildProfileDescription({
      name: "p",
      model: { provider: "openai", id: "gpt-5" },
      thinkingLevel: "high",
      tools: ["read", "bash"],
      approvalsMode: "never",
    });
    expect(desc).toBe("openai/gpt-5 | thinking:high | tools:read,bash | approvals:never");
  });

  it("returns an empty string for a bare profile", () => {
    expect(buildProfileDescription({ name: "p" })).toBe("");
  });
});

describe("parseCommand", () => {
  it("returns empty for no args", () => {
    expect(parseCommand("")).toEqual({});
    expect(parseCommand("   ")).toEqual({});
  });
  it("parses save/apply/delete with a name", () => {
    expect(parseCommand("save plan")).toEqual({ sub: "save", name: "plan" });
    expect(parseCommand("apply  plan")).toEqual({ sub: "apply", name: "plan" });
    expect(parseCommand("delete plan")).toEqual({ sub: "delete", name: "plan" });
  });
  it("lowercases the sub-command and keeps the name case", () => {
    expect(parseCommand("SAVE Plan")).toEqual({ sub: "save", name: "Plan" });
  });
  it("returns a sub-command with no name when only the verb is given", () => {
    expect(parseCommand("save")).toEqual({ sub: "save", name: undefined });
  });
  it("treats a bare token as a name", () => {
    expect(parseCommand("plan")).toEqual({ name: "plan" });
  });
});

describe("completeArgs", () => {
  const set: ProfileSet = {
    profiles: [{ name: "plan" }, { name: "planB" }, { name: "impl" }],
  };

  it("returns items shaped as {value,label,description}", () => {
    const items = completeArgs(set, "");
    expect(items.every((i) => typeof i.value === "string" && typeof i.label === "string")).toBe(true);
  });

  it("filters sub-commands and names by prefix", () => {
    const values = completeArgs(set, "pl").map((i) => i.value);
    expect(values).toContain("plan");
    expect(values).toContain("planB");
    expect(values).not.toContain("impl");
    expect(values).not.toContain("save");
  });

  it("offers sub-commands on an empty prefix", () => {
    const values = completeArgs(set, "").map((i) => i.value);
    expect(values).toContain("save");
    expect(values).toContain("apply");
    expect(values).toContain("delete");
  });

  it("completes profile names after apply/delete", () => {
    const values = completeArgs(set, "apply pl").map((i) => i.value);
    expect(values).toEqual(["plan", "planB"]);
  });

  it("offers no completions for save <name>", () => {
    expect(completeArgs(set, "save foo")).toEqual([]);
  });
});
