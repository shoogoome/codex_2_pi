// Pure bash command analysis. No node imports — deterministic and testable.
//
// Strategy: a lightweight quote-aware tokenizer splits a compound command on
// top-level && || | ; into segments; each segment's command prefix is
// normalized (argv0 plus a first non-flag subcommand for multiplexer tools
// like git/npm). Prefixes are classified against a read-only whitelist and a
// set of dangerous/catastrophic patterns. The command's verdict is the worst
// verdict across its segments.

import type { Effect } from "./types.js";

/** argv0s whose first non-flag subcommand is meaningful for prefixing. */
const SUBCOMMAND_TOOLS = new Set([
  "git",
  "npm",
  "yarn",
  "pnpm",
  "bun",
  "cargo",
  "docker",
  "kubectl",
  "go",
  "pip",
  "pip3",
  "brew",
  "apt",
  "apt-get",
  "systemctl",
]);

/**
 * Short flags (per multiplexer tool) that consume the following token as their
 * value, so it must not be mistaken for the subcommand. e.g. `git -C <path>`.
 */
const VALUE_FLAGS: Record<string, Set<string>> = {
  git: new Set(["-C", "-c"]),
  docker: new Set(["-H", "--host", "--context"]),
  kubectl: new Set(["-n", "--namespace", "--context", "--cluster"]),
};

/**
 * Read-only prefixes that are auto-allowed. Two-word entries (e.g. "git log")
 * require the normalized prefix to match exactly; one-word entries match argv0.
 */
const READONLY_PREFIXES = new Set([
  "ls",
  "cat",
  "pwd",
  "echo",
  "printf",
  "grep",
  "rg",
  "find",
  "head",
  "tail",
  "wc",
  "which",
  "whoami",
  "date",
  "sort",
  "uniq",
  "cut",
  "tr",
  "basename",
  "dirname",
  "realpath",
  "stat",
  "file",
  "du",
  "df",
  "uname",
  "id",
  "tree",
  "diff",
  "env",
  "sed",
  "awk",
  "column",
  "less",
  "more",
  "git status",
  "git diff",
  "git log",
  "git show",
  "git branch",
  "git remote",
  "git rev-parse",
  "git blame",
  "git ls-files",
  "git describe",
  "git tag",
]);

/** System path prefixes that a write redirect must never target. */
const SYSTEM_REDIRECT_PATHS = [
  "/etc",
  "/usr",
  "/bin",
  "/sbin",
  "/boot",
  "/sys",
  "/dev",
  "/lib",
  "/lib64",
  "/var",
  "/root",
];

export interface SegmentVerdict {
  effect: Effect;
  prefix: string;
  reason: string;
  /** Raw segment text (trimmed). */
  segment: string;
}

export interface CommandVerdict {
  effect: Effect;
  /** Normalized prefixes across all segments (dedup preserving order). */
  prefixes: string[];
  reason: string;
  /** Worst segment (source of the overall effect), for matcher suggestions. */
  worst: SegmentVerdict;
}

const EFFECT_RANK: Record<Effect, number> = { allow: 0, ask: 1, deny: 2 };

function worse(a: Effect, b: Effect): Effect {
  return EFFECT_RANK[a] >= EFFECT_RANK[b] ? a : b;
}

/**
 * Split a compound command into top-level segments on && || | ; — quote-aware
 * so operators inside single/double quotes are ignored. Redirection operators
 * (> >> <) are NOT split points; they stay inside their segment.
 */
export function tokenizeSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let i = 0;
  const n = command.length;
  while (i < n) {
    const ch = command[i]!;
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      i += 1;
      continue;
    }
    if (ch === "\\") {
      // Preserve escaped char verbatim (e.g. "\;").
      current += ch;
      if (i + 1 < n) current += command[i + 1];
      i += 2;
      continue;
    }
    const next = command[i + 1];
    if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
      segments.push(current);
      current = "";
      i += 2;
      continue;
    }
    if (ch === "|" || ch === ";" || ch === "\n") {
      segments.push(current);
      current = "";
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  segments.push(current);
  return segments.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Split a single segment into whitespace tokens (quote-aware, strips quotes). */
function tokenizeWords(segment: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      has = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
      continue;
    }
    if (ch === "\\") {
      if (i + 1 < segment.length) {
        current += segment[i + 1];
        i += 1;
        has = true;
      }
      continue;
    }
    if (/\s/.test(ch)) {
      if (has) {
        words.push(current);
        current = "";
        has = false;
      }
      continue;
    }
    current += ch;
    has = true;
  }
  if (has) words.push(current);
  return words;
}

/**
 * Normalize a segment to its command prefix: argv0, plus a first non-flag
 * subcommand for known multiplexer tools. Leading env assignments (FOO=bar)
 * and a leading `sudo`/`command`/`env` wrapper are skipped for prefix purposes
 * (but `sudo` is still flagged dangerous separately).
 */
export function normalizePrefix(segment: string): string {
  const words = tokenizeWords(segment);
  let idx = 0;
  // Skip leading VAR=value assignments.
  while (idx < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[idx]!)) {
    idx += 1;
  }
  if (idx >= words.length) return "";
  const argv0Full = words[idx]!;
  // Strip a leading path (e.g. /usr/bin/git -> git).
  const argv0 = argv0Full.includes("/") ? argv0Full.slice(argv0Full.lastIndexOf("/") + 1) : argv0Full;
  if (!SUBCOMMAND_TOOLS.has(argv0)) return argv0;
  // Find first non-flag token after argv0 as the subcommand. Skip flags, and
  // for value-taking flags (e.g. `git -C <path>`) also skip their argument.
  const valueFlags = VALUE_FLAGS[argv0];
  for (let j = idx + 1; j < words.length; j += 1) {
    const w = words[j]!;
    if (w.startsWith("-")) {
      // A value flag with a separate argument consumes the next token, unless
      // it uses the `--flag=value` attached form.
      if (valueFlags && valueFlags.has(w) && !w.includes("=")) j += 1;
      continue;
    }
    return `${argv0} ${w}`;
  }
  return argv0;
}

interface PatternRule {
  re: RegExp;
  effect: Effect;
  reason: string;
}

// Catastrophic → deny (unconditional, even in bypass mode).
const CATASTROPHIC: PatternRule[] = [
  { re: /\brm\s+(?:-[A-Za-z]*\s+)*-?[A-Za-z]*[rR][A-Za-z]*f?[A-Za-z]*\s+(?:-{2}\s+)?(?:\/|~)(?:\s|$)/, effect: "deny", reason: "rm -rf targeting / or ~" },
  { re: /\bmkfs(\.\w+)?\b/, effect: "deny", reason: "mkfs filesystem format" },
  { re: /\bdd\b[^|;&]*\bof=\/dev\//, effect: "deny", reason: "dd writing to a device" },
  { re: /:\s*\(\s*\)\s*\{.*:.*\|.*:.*\}/, effect: "deny", reason: "fork bomb" },
];

// Dangerous → ask (still prompts even in bypass mode).
const DANGEROUS: PatternRule[] = [
  { re: /\brm\s+(?:-[A-Za-z]*\s+)*-?[A-Za-z]*[rR]/, effect: "ask", reason: "recursive rm" },
  { re: /\brm\s+(?:-[A-Za-z]*\s+)*-?[A-Za-z]*f/, effect: "ask", reason: "forced rm" },
  { re: /\b(?:curl|wget)\b[^|]*\|\s*(?:sudo\s+)?(?:ba)?sh\b/, effect: "ask", reason: "pipe download to shell" },
  { re: /\bchmod\s+(?:-[A-Za-z]*\s+)*777\b/, effect: "ask", reason: "chmod 777" },
  { re: /\bchmod\s+(?:-[A-Za-z]*\s+)*-[A-Za-z]*R/, effect: "ask", reason: "recursive chmod" },
  { re: /(^|\s)sudo\b/, effect: "ask", reason: "sudo escalation" },
  { re: /\bdd\b[^|;&]*\bof=/, effect: "ask", reason: "dd raw write" },
  { re: /\bgit\s+push\b[^|;&]*(?:-f\b|--force\b)/, effect: "ask", reason: "git force push" },
];

/** Does a segment redirect (> or >>) into a system path? */
function redirectsToSystemPath(segment: string): boolean {
  const targets = extractRedirectTargets(segment);
  return targets.some((t) => SYSTEM_REDIRECT_PATHS.some((p) => t === p || t.startsWith(p + "/")));
}

/** Extract redirect (> >>) and `tee` targets from a single segment. */
function extractRedirectTargets(segment: string): string[] {
  const targets: string[] = [];
  const words = tokenizeWords(segment);
  // Redirect operator forms: ">file", ">>file", ">", ">>", "2>", "1>>", etc.
  const reOp = /^\d*>>?$/;
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i]!;
    const m = w.match(/^\d*>>?(.+)$/); // attached form ">file"
    if (m && m[1]) {
      targets.push(m[1]!);
      continue;
    }
    if (reOp.test(w) && i + 1 < words.length) {
      targets.push(words[i + 1]!);
    }
  }
  // `tee [-a] FILE...`
  const idx = words.indexOf("tee");
  if (idx >= 0) {
    for (let j = idx + 1; j < words.length; j += 1) {
      const w = words[j]!;
      if (w.startsWith("-")) continue;
      targets.push(w);
    }
  }
  return targets;
}

/**
 * Extract all write targets (redirect + tee) across a whole compound command.
 * Used by the protected-path stage.
 */
export function extractWriteTargets(command: string): string[] {
  const out: string[] = [];
  for (const seg of tokenizeSegments(command)) {
    for (const t of extractRedirectTargets(seg)) {
      if (!out.includes(t)) out.push(t);
    }
  }
  return out;
}

/** Classify a single segment. */
export function classifySegment(segment: string): SegmentVerdict {
  const prefix = normalizePrefix(segment);
  const trimmed = segment.trim();
  for (const rule of CATASTROPHIC) {
    if (rule.re.test(trimmed)) {
      return { effect: "deny", prefix, reason: rule.reason, segment: trimmed };
    }
  }
  for (const rule of DANGEROUS) {
    if (rule.re.test(trimmed)) {
      return { effect: "ask", prefix, reason: rule.reason, segment: trimmed };
    }
  }
  if (redirectsToSystemPath(trimmed)) {
    return { effect: "ask", prefix, reason: "redirect to system path", segment: trimmed };
  }
  // Read-only whitelist: match two-word prefix exactly, else argv0.
  const argv0 = prefix.split(" ")[0]!;
  if (READONLY_PREFIXES.has(prefix) || READONLY_PREFIXES.has(argv0)) {
    return { effect: "allow", prefix, reason: "read-only command", segment: trimmed };
  }
  // Unknown / unclassified command fails safe to ask.
  return { effect: "ask", prefix, reason: "command not in read-only whitelist", segment: trimmed };
}

/** Classify a whole compound command by worst-of segments. */
export function classifyCommand(command: string): CommandVerdict {
  const segments = tokenizeSegments(command);
  if (segments.length === 0) {
    const empty: SegmentVerdict = { effect: "ask", prefix: "", reason: "empty command", segment: "" };
    return { effect: "ask", prefixes: [], reason: empty.reason, worst: empty };
  }
  const verdicts = segments.map(classifySegment);
  const prefixes: string[] = [];
  for (const v of verdicts) {
    if (v.prefix && !prefixes.includes(v.prefix)) prefixes.push(v.prefix);
  }
  let worst = verdicts[0]!;
  for (const v of verdicts) {
    if (EFFECT_RANK[v.effect] > EFFECT_RANK[worst.effect]) worst = v;
  }
  const effect = verdicts.reduce<Effect>((acc, v) => worse(acc, v.effect), "allow");
  return { effect, prefixes, reason: worst.reason, worst };
}
