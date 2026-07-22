/**
 * Profiles extension — pure data model, validation, merge and serialization.
 *
 * No pi runtime dependency: this module is fully unit-testable in isolation.
 * The index.ts entry orchestrates the pi API using these helpers.
 */

/** Thinking levels supported by pi (mirrors @earendil-works/pi-agent-core ThinkingLevel). */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export function isThinkingLevel(x: unknown): x is ThinkingLevel {
  return typeof x === "string" && (THINKING_LEVELS as readonly string[]).includes(x);
}

/**
 * Codex-style approval modes. Stored as a loose string (pi has no built-in
 * approvals API); this list is only a hint for validation/UI.
 */
export const APPROVALS_MODES = ["untrusted", "on-request", "on-failure", "never"] as const;

export type ApprovalsMode = (typeof APPROVALS_MODES)[number];

export function isApprovalsMode(x: unknown): x is ApprovalsMode {
  return typeof x === "string" && (APPROVALS_MODES as readonly string[]).includes(x);
}

/** Serializable reference to a model. */
export interface ModelRef {
  provider: string;
  id: string;
}

/** A named snapshot of orthogonal runtime settings. */
export interface Profile {
  name: string;
  model?: ModelRef;
  tools?: string[];
  thinkingLevel?: ThinkingLevel;
  approvalsMode?: string;
  extra?: Record<string, unknown>;
}

/** The persisted collection of profiles. */
export interface ProfileSet {
  profiles: Profile[];
}

/** Completion item shape — matches pi-tui AutocompleteItem ({value,label,description?}). */
export interface CompletionItem {
  value: string;
  label: string;
  description?: string;
}

const SUBCOMMANDS = ["save", "apply", "delete"] as const;
export type SubCommand = (typeof SUBCOMMANDS)[number];

export function emptyProfileSet(): ProfileSet {
  return { profiles: [] };
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/**
 * Validate a profile name. Returns an error string, or null when valid.
 */
export function validateProfileName(name: unknown): string | null {
  if (typeof name !== "string") return "Profile name must be a string";
  const trimmed = name.trim();
  if (trimmed.length === 0) return "Profile name must not be empty";
  return null;
}

function normalizeModelRef(raw: unknown): ModelRef | undefined {
  if (!isRecord(raw)) return undefined;
  const { provider, id } = raw;
  if (typeof provider !== "string" || provider.trim().length === 0) return undefined;
  if (typeof id !== "string" || id.trim().length === 0) return undefined;
  return { provider, id };
}

function normalizeTools(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const tools = raw.filter((t): t is string => typeof t === "string" && t.length > 0);
  return tools;
}

/**
 * Coerce an arbitrary parsed value into a Profile. Throws when the name is
 * missing/invalid; otherwise drops any malformed optional fields (tolerant).
 */
export function normalizeProfile(raw: unknown): Profile {
  if (!isRecord(raw)) {
    throw new Error("Profile must be an object");
  }
  const nameError = validateProfileName(raw.name);
  if (nameError) {
    throw new Error(nameError);
  }
  const name = (raw.name as string).trim();

  const profile: Profile = { name };

  const model = normalizeModelRef(raw.model);
  if (model) profile.model = model;

  const tools = normalizeTools(raw.tools);
  if (tools) profile.tools = tools;

  if (isThinkingLevel(raw.thinkingLevel)) {
    profile.thinkingLevel = raw.thinkingLevel;
  }

  if (typeof raw.approvalsMode === "string" && raw.approvalsMode.trim().length > 0) {
    profile.approvalsMode = raw.approvalsMode;
  }

  if (isRecord(raw.extra)) {
    profile.extra = { ...raw.extra };
  }

  return profile;
}

/** Case-insensitive lookup of a profile by name. */
export function findProfile(set: ProfileSet, name: string): Profile | undefined {
  const lower = name.trim().toLowerCase();
  return set.profiles.find((p) => p.name.toLowerCase() === lower);
}

/** Insert or replace a profile (case-insensitive match on name). */
export function upsertProfile(set: ProfileSet, profile: Profile): ProfileSet {
  const lower = profile.name.toLowerCase();
  const profiles = set.profiles.filter((p) => p.name.toLowerCase() !== lower);
  profiles.push(profile);
  return { profiles };
}

/** Remove a profile by name (case-insensitive). Returns a new set. */
export function removeProfile(set: ProfileSet, name: string): ProfileSet {
  const lower = name.trim().toLowerCase();
  return { profiles: set.profiles.filter((p) => p.name.toLowerCase() !== lower) };
}

/** Parse persisted data back into a ProfileSet, skipping malformed entries. */
export function parseProfileSet(data: unknown): ProfileSet {
  if (!isRecord(data) || !Array.isArray(data.profiles)) {
    return emptyProfileSet();
  }
  const profiles: Profile[] = [];
  for (const raw of data.profiles) {
    try {
      profiles.push(normalizeProfile(raw));
    } catch {
      // Skip bad entries to stay resilient across schema/version drift.
    }
  }
  return { profiles };
}

/** Produce a plain JSON-serializable snapshot of a ProfileSet. */
export function serializeProfileSet(set: ProfileSet): ProfileSet {
  return {
    profiles: set.profiles.map((p) => {
      const out: Profile = { name: p.name };
      if (p.model) out.model = { provider: p.model.provider, id: p.model.id };
      if (p.tools) out.tools = [...p.tools];
      if (p.thinkingLevel) out.thinkingLevel = p.thinkingLevel;
      if (p.approvalsMode) out.approvalsMode = p.approvalsMode;
      if (p.extra) out.extra = { ...p.extra };
      return out;
    }),
  };
}

export interface CaptureInput {
  activeTools?: string[];
  thinkingLevel?: unknown;
  model?: ModelRef | undefined;
  approvalsMode?: string;
}

/**
 * Build a Profile from the current runtime state. `model` should be
 * {provider,id} or undefined (e.g. no model selected yet).
 */
export function captureProfile(name: string, input: CaptureInput): Profile {
  const nameError = validateProfileName(name);
  if (nameError) {
    throw new Error(nameError);
  }
  const profile: Profile = { name: name.trim() };

  const model = normalizeModelRef(input.model);
  if (model) profile.model = model;

  if (Array.isArray(input.activeTools)) {
    profile.tools = input.activeTools.filter((t) => typeof t === "string" && t.length > 0);
  }

  if (isThinkingLevel(input.thinkingLevel)) {
    profile.thinkingLevel = input.thinkingLevel;
  }

  if (typeof input.approvalsMode === "string" && input.approvalsMode.trim().length > 0) {
    profile.approvalsMode = input.approvalsMode;
  }

  return profile;
}

/**
 * Resolve a stored ModelRef (or free-form pattern) against the available
 * models. Exact provider+id wins; otherwise fall back to an id substring /
 * "provider/id" pattern match.
 */
export function matchModel(models: ModelRef[], ref: ModelRef | string): ModelRef | undefined {
  if (typeof ref !== "string") {
    const exact = models.find((m) => m.provider === ref.provider && m.id === ref.id);
    if (exact) return exact;
    const byId = models.find((m) => m.id === ref.id);
    if (byId) return byId;
    const lowerId = ref.id.toLowerCase();
    return models.find((m) => m.id.toLowerCase().includes(lowerId));
  }

  const pattern = ref.trim().toLowerCase();
  if (pattern.length === 0) return undefined;
  const exact = models.find((m) => m.id.toLowerCase() === pattern || `${m.provider}/${m.id}`.toLowerCase() === pattern);
  if (exact) return exact;
  return models.find(
    (m) => m.id.toLowerCase().includes(pattern) || `${m.provider}/${m.id}`.toLowerCase().includes(pattern),
  );
}

export interface ToolSplit {
  validTools: string[];
  invalidTools: string[];
}

/**
 * Split a profile's requested tools into those that exist in the runtime and
 * those that don't. Pure — the caller applies the valid set and reports the
 * invalid ones.
 */
export function applyProfileToRuntime(profile: Profile, allToolNames: string[]): ToolSplit {
  const requested = profile.tools ?? [];
  const known = new Set(allToolNames);
  const validTools = requested.filter((t) => known.has(t));
  const invalidTools = requested.filter((t) => !known.has(t));
  return { validTools, invalidTools };
}

/** Human-readable one-line summary of a profile. */
export function buildProfileDescription(profile: Profile): string {
  const parts: string[] = [];
  if (profile.model) {
    parts.push(`${profile.model.provider}/${profile.model.id}`);
  }
  if (profile.thinkingLevel) {
    parts.push(`thinking:${profile.thinkingLevel}`);
  }
  if (profile.tools && profile.tools.length > 0) {
    parts.push(`tools:${profile.tools.join(",")}`);
  }
  if (profile.approvalsMode) {
    parts.push(`approvals:${profile.approvalsMode}`);
  }
  return parts.join(" | ");
}

/** Parse the raw argument string of `/profile` into a sub-command + name. */
export function parseCommand(args: string): { sub?: SubCommand; name?: string } {
  const trimmed = (args ?? "").trim();
  if (trimmed.length === 0) return {};
  const parts = trimmed.split(/\s+/);
  const first = parts[0].toLowerCase();
  if ((SUBCOMMANDS as readonly string[]).includes(first)) {
    const name = parts.slice(1).join(" ").trim();
    return { sub: first as SubCommand, name: name.length > 0 ? name : undefined };
  }
  // Bare name → treated as an apply-by-name shortcut by the handler.
  return { name: trimmed };
}

function profileNameCompletions(set: ProfileSet, prefix: string): CompletionItem[] {
  const lower = prefix.trim().toLowerCase();
  return set.profiles
    .filter((p) => p.name.toLowerCase().startsWith(lower))
    .map((p) => ({
      value: p.name,
      label: p.name,
      description: buildProfileDescription(p) || undefined,
    }));
}

/**
 * Autocomplete provider for `/profile`: complete sub-commands and stored
 * profile names, filtered by the current argument prefix.
 */
export function completeArgs(set: ProfileSet, prefix: string): CompletionItem[] {
  const raw = prefix ?? "";
  const spaceIdx = raw.indexOf(" ");

  if (spaceIdx >= 0) {
    // Completing the name argument of a sub-command.
    const sub = raw.slice(0, spaceIdx).trim().toLowerCase();
    const nameToken = raw.slice(spaceIdx + 1).trimStart();
    if (sub === "apply" || sub === "delete") {
      return profileNameCompletions(set, nameToken);
    }
    return [];
  }

  const lower = raw.trim().toLowerCase();
  const subs: CompletionItem[] = (SUBCOMMANDS as readonly string[])
    .filter((s) => s.startsWith(lower))
    .map((s) => ({ value: s, label: s, description: `${s} a profile` }));
  const names = profileNameCompletions(set, raw);
  return [...subs, ...names];
}
