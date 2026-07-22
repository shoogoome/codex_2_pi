// Pure protocol layer: build the JSON that goes to a hook's stdin, and decode a
// hook's raw exit/stdout/stderr into a normalized HookDecision. No I/O here —
// index.ts owns spawning and the actual pi return values.

import type { HookDecision, HookEventName, HookExecResult } from "./types.js";

/** Fields shared by every hook input, mirroring Claude's BaseHookInput. */
export interface HookInputBase {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode?: string;
}

/**
 * Build the stdin JSON object for a hook invocation. `hook_event_name` plus the
 * event-specific payload fields are merged onto the base. The payload is passed
 * through verbatim (already snake_cased by the caller), so this stays a pure
 * shape-assembler.
 */
export function buildHookInput(
  eventName: HookEventName,
  base: HookInputBase,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...base,
    hook_event_name: eventName,
    ...payload,
  };
}

/** Serialize a hook input to the newline-terminated JSON written to stdin. */
export function serializeHookInput(input: Record<string, unknown>): string {
  return `${JSON.stringify(input)}\n`;
}

export interface ParsedOutput {
  /** When stdout was not JSON, its trimmed text (treated as additionalContext). */
  plainText?: string;
  /** When stdout parsed as a JSON object, the decoded object. */
  json?: Record<string, unknown>;
}

/**
 * Parse a hook's stdout. A body starting with `{` is parsed as JSON (invalid
 * JSON degrades to plainText); anything else is treated as plain text.
 */
export function parseHookOutput(stdout: string): ParsedOutput {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return {};
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { json: parsed as Record<string, unknown> };
      }
    } catch {
      // fall through to plain text
    }
  }
  return { plainText: trimmed };
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/**
 * Decode a raw hook result into a normalized HookDecision.
 *
 * Block precedence (any one blocks):
 *  - exit code 2 → block, reason = stderr (Claude's convention).
 *  - stdout JSON `continue: false` → block, reason = stopReason.
 *  - stdout JSON `decision: "block"` → block, reason = reason.
 *  - hookSpecificOutput.permissionDecision === "deny" → block.
 *
 * Additive fields (extracted regardless of block):
 *  - additionalContext (top-level reason on approve is NOT context; only the
 *    hookSpecificOutput.additionalContext or plain stdout is).
 *  - updatedInput (PreToolUse arg patch).
 *  - initialUserMessage (SessionStart seed).
 *  - systemMessage.
 */
export function decodeDecision(raw: HookExecResult): HookDecision {
  const decision: HookDecision = {};

  // Non-zero-but-not-2 exit codes are "non-blocking errors" in Claude: stderr
  // is shown to the user but does not block. We surface stderr as a system
  // message hint and otherwise treat as a no-op.
  if (raw.exitCode === 2) {
    decision.block = true;
    decision.reason = raw.stderr.trim() || "Hook blocked the operation (exit code 2).";
    return decision;
  }

  const parsed = parseHookOutput(raw.stdout);

  if (parsed.plainText !== undefined) {
    // Plain stdout on a successful hook becomes injected context.
    decision.additionalContext = parsed.plainText;
    return decision;
  }

  const json = parsed.json;
  if (!json) return decision;

  if (json.continue === false) {
    decision.block = true;
    decision.continue = false;
    decision.reason = asString(json.stopReason) ?? asString(json.reason) ?? "Hook requested stop.";
  }

  if (json.decision === "block") {
    decision.block = true;
    decision.reason = asString(json.reason) ?? decision.reason ?? "Hook blocked the operation.";
  }

  const sysMsg = asString(json.systemMessage);
  if (sysMsg !== undefined) decision.systemMessage = sysMsg;

  const hso = asRecord(json.hookSpecificOutput);
  if (hso) {
    const permission = asString(hso.permissionDecision);
    if (permission === "deny") {
      decision.block = true;
      decision.reason =
        asString(hso.permissionDecisionReason) ?? decision.reason ?? "Hook denied the operation.";
    }
    const ctx = asString(hso.additionalContext);
    if (ctx !== undefined) decision.additionalContext = ctx;
    const updated = asRecord(hso.updatedInput);
    if (updated !== undefined) decision.updatedInput = updated;
    const initial = asString(hso.initialUserMessage);
    if (initial !== undefined) decision.initialUserMessage = initial;
  }

  return decision;
}

/**
 * Merge multiple hook decisions in order. Any block wins (first block's reason
 * kept). additionalContext concatenates; updatedInput/initialUserMessage take
 * the last non-undefined value (later hooks refine earlier ones).
 */
export function mergeDecisions(decisions: HookDecision[]): HookDecision {
  const merged: HookDecision = {};
  const contexts: string[] = [];
  for (const d of decisions) {
    if (d.block && !merged.block) {
      merged.block = true;
      merged.reason = d.reason;
      if (d.continue === false) merged.continue = false;
    }
    if (d.additionalContext) contexts.push(d.additionalContext);
    if (d.updatedInput) merged.updatedInput = d.updatedInput;
    if (d.initialUserMessage !== undefined) merged.initialUserMessage = d.initialUserMessage;
    if (d.systemMessage !== undefined) merged.systemMessage = d.systemMessage;
  }
  if (contexts.length > 0) merged.additionalContext = contexts.join("\n\n");
  return merged;
}
