// Pure config helpers: compute paths, parse a hooks.json string into a
// HooksConfig, and merge global + project configs. All filesystem I/O lives in
// index.ts; these functions operate on strings and plain objects so they are
// trivially unit-testable and never throw.

import path from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  HOOK_EVENT_NAMES,
  type AgentHook,
  type Hook,
  type HookEventName,
  type HookMatcher,
  type HooksConfig,
  type PromptHook,
} from "./types.js";

export interface ConfigPaths {
  globalPath: string;
  projectPath: string;
}

/** Pure path construction: ~/.pi/agent/hooks.json (global) + <cwd>/.pi/hooks.json. */
export function computeConfigPaths(home: string, cwd: string): ConfigPaths {
  return {
    globalPath: path.join(home, ".pi", "agent", "hooks.json"),
    projectPath: path.join(cwd, ".pi", "hooks.json"),
  };
}

// ---- typebox schemas (fast-path validation; coercion is the fallback) ----

const CommandHookSchema = Type.Object({
  type: Type.Literal("command"),
  command: Type.String(),
  if: Type.Optional(Type.String()),
  timeout: Type.Optional(Type.Number()),
  shell: Type.Optional(Type.String()),
  statusMessage: Type.Optional(Type.String()),
});

const PromptHookSchema = Type.Object({
  type: Type.Literal("prompt"),
  prompt: Type.String(),
  if: Type.Optional(Type.String()),
  timeout: Type.Optional(Type.Number()),
  model: Type.Optional(Type.String()),
});

const AgentHookSchema = Type.Object({
  type: Type.Literal("agent"),
  prompt: Type.String(),
  if: Type.Optional(Type.String()),
  timeout: Type.Optional(Type.Number()),
  model: Type.Optional(Type.String()),
});

const HttpHookSchema = Type.Object({
  type: Type.Literal("http"),
  url: Type.String(),
  if: Type.Optional(Type.String()),
  timeout: Type.Optional(Type.Number()),
  headers: Type.Optional(Type.Record(Type.String(), Type.String())),
});

export const HookSchema = Type.Union([
  CommandHookSchema,
  PromptHookSchema,
  AgentHookSchema,
  HttpHookSchema,
]);

const HOOK_TYPES = new Set(["command", "prompt", "agent", "http"]);

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function optStr(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function optNum(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Validate/normalize a single hook. We build a normalized object manually
 * (dropping unknown fields so a config with spurious extra keys is tolerated
 * rather than rejected), then run it through the typebox schema as the final
 * authoritative validity gate. Returns null when the entry cannot be
 * classified or fails the schema.
 */
export function coerceHook(raw: unknown): Hook | null {
  if (!isObject(raw)) return null;
  const type = raw.type;
  if (typeof type !== "string" || !HOOK_TYPES.has(type)) return null;

  let hook: Hook | null = null;

  if (type === "command") {
    if (typeof raw.command !== "string") return null;
    const h: Hook = { type: "command", command: raw.command };
    const ifc = optStr(raw.if);
    if (ifc !== undefined) h.if = ifc;
    const to = optNum(raw.timeout);
    if (to !== undefined) h.timeout = to;
    const shell = optStr(raw.shell);
    if (shell !== undefined) h.shell = shell;
    const sm = optStr(raw.statusMessage);
    if (sm !== undefined) h.statusMessage = sm;
    hook = h;
  } else if (type === "prompt" || type === "agent") {
    if (typeof raw.prompt !== "string") return null;
    const h: PromptHook | AgentHook =
      type === "prompt"
        ? { type: "prompt", prompt: raw.prompt }
        : { type: "agent", prompt: raw.prompt };
    const ifc = optStr(raw.if);
    if (ifc !== undefined) h.if = ifc;
    const to = optNum(raw.timeout);
    if (to !== undefined) h.timeout = to;
    const model = optStr(raw.model);
    if (model !== undefined) h.model = model;
    hook = h;
  } else {
    // http
    if (typeof raw.url !== "string") return null;
    const h: Hook = { type: "http", url: raw.url };
    const ifc = optStr(raw.if);
    if (ifc !== undefined) h.if = ifc;
    const to = optNum(raw.timeout);
    if (to !== undefined) h.timeout = to;
    if (isObject(raw.headers)) {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw.headers)) {
        if (typeof v === "string") headers[k] = v;
      }
      h.headers = headers;
    }
    hook = h;
  }

  // Final gate: the normalized object must satisfy the typebox schema.
  try {
    return Value.Check(HookSchema, hook) ? hook : null;
  } catch {
    return hook;
  }
}

/** Coerce a matcher block, dropping any hooks that cannot be understood. */
export function coerceMatcher(raw: unknown, warnings: string[], event: string): HookMatcher | null {
  if (!isObject(raw)) {
    warnings.push(`${event}: matcher entry is not an object`);
    return null;
  }
  const rawHooks = raw.hooks;
  if (!Array.isArray(rawHooks)) {
    warnings.push(`${event}: matcher missing "hooks" array`);
    return null;
  }
  const hooks: Hook[] = [];
  for (const rh of rawHooks) {
    const hook = coerceHook(rh);
    if (hook) hooks.push(hook);
    else warnings.push(`${event}: skipped an invalid hook entry`);
  }
  if (hooks.length === 0) return null;
  const matcher: HookMatcher = { hooks };
  const m = optStr(raw.matcher);
  if (m !== undefined) matcher.matcher = m;
  const ifc = optStr(raw.if);
  if (ifc !== undefined) matcher.if = ifc;
  return matcher;
}

export interface ParseResult {
  config: HooksConfig;
  warnings: string[];
}

const EVENT_SET = new Set<string>(HOOK_EVENT_NAMES);

/**
 * Parse the text of a hooks.json file. Never throws: malformed JSON, a missing
 * `hooks` section, unknown event names, or bad matcher entries all degrade to a
 * partial config plus collected warnings.
 */
export function parseHooksConfig(text: string): ParseResult {
  const config: HooksConfig = {};
  const warnings: string[] = [];

  const trimmed = text.trim();
  if (trimmed.length === 0) return { config, warnings };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    warnings.push(`invalid JSON: ${(err as Error).message}`);
    return { config, warnings };
  }

  if (!isObject(parsed)) {
    warnings.push("config root is not an object");
    return { config, warnings };
  }

  // Accept both { hooks: {...} } (Claude settings shape) and a bare {...} map.
  const rawHooks = isObject(parsed.hooks) ? parsed.hooks : parsed;

  for (const [event, rawMatchers] of Object.entries(rawHooks)) {
    if (!EVENT_SET.has(event)) {
      // Silently skip Claude events we don't bridge, but warn on obvious typos
      // (i.e. anything that isn't a known Claude event either would be noise;
      // we keep it simple and just note unbridged events).
      warnings.push(`unbridged or unknown hook event "${event}" — skipped`);
      continue;
    }
    if (!Array.isArray(rawMatchers)) {
      warnings.push(`event "${event}": expected an array of matchers`);
      continue;
    }
    const matchers: HookMatcher[] = [];
    for (const rm of rawMatchers) {
      const m = coerceMatcher(rm, warnings, event);
      if (m) matchers.push(m);
    }
    if (matchers.length > 0) config[event as HookEventName] = matchers;
  }

  return { config, warnings };
}

/**
 * Merge global and project configs. For each event the matcher lists are
 * concatenated with project entries appended after global ones (project wins on
 * ordering / can add more hooks; nothing is removed).
 */
export function mergeHooksConfigs(global: HooksConfig, project: HooksConfig): HooksConfig {
  const merged: HooksConfig = {};
  for (const event of HOOK_EVENT_NAMES) {
    const g = global[event] ?? [];
    const p = project[event] ?? [];
    const combined = [...g, ...p];
    if (combined.length > 0) merged[event] = combined;
  }
  return merged;
}
