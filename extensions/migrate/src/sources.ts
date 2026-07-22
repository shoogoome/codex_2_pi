// Pure source detection: given home + cwd + an injected fs, enumerate the
// Claude/Cursor config roots that exist and which known files live under each.
// Missing dirs are simply absent — nothing here ever throws.

import { join } from "node:path";
import type { DetectedSource, FsFacade, SourceKind, SourceScope } from "./types.js";

interface RootSpec {
  kind: SourceKind;
  scope: SourceScope;
  root: string;
}

/** Candidate roots in a stable order: project before user, claude before cursor. */
export function candidateRoots(home: string, cwd: string): RootSpec[] {
  return [
    { kind: "claude", scope: "project", root: join(cwd, ".claude") },
    { kind: "cursor", scope: "project", root: join(cwd, ".cursor") },
    { kind: "claude", scope: "user", root: join(home, ".claude") },
    { kind: "cursor", scope: "user", root: join(home, ".cursor") },
  ];
}

function fileIf(fs: FsFacade, p: string): string | undefined {
  return fs.existsSync(p) && !fs.isDirectory(p) ? p : undefined;
}

function dirIf(fs: FsFacade, p: string): string | undefined {
  return fs.existsSync(p) && fs.isDirectory(p) ? p : undefined;
}

/** Build a DetectedSource for one root, listing the files/dirs that exist. */
function detectAt(spec: RootSpec, fs: FsFacade): DetectedSource | undefined {
  if (!fs.existsSync(spec.root) || !fs.isDirectory(spec.root)) return undefined;

  const files: DetectedSource["files"] = {};
  if (spec.kind === "claude") {
    files.settings = fileIf(fs, join(spec.root, "settings.json"));
    files.settingsLocal = fileIf(fs, join(spec.root, "settings.local.json"));
    files.mcpJson = fileIf(fs, join(spec.root, ".mcp.json"));
    files.agentsDir = dirIf(fs, join(spec.root, "agents"));
    files.commandsDir = dirIf(fs, join(spec.root, "commands"));
    // CLAUDE.md conventionally lives beside the project, not in .claude/, but
    // both locations are checked by the caller; here we only note .claude root.
  } else {
    files.mcpJson = fileIf(fs, join(spec.root, "mcp.json"));
    files.rulesDir = dirIf(fs, join(spec.root, "rules"));
  }

  // Drop undefined keys so callers can cheaply test presence.
  for (const k of Object.keys(files) as (keyof DetectedSource["files"])[]) {
    if (files[k] === undefined) delete files[k];
  }

  // A root with nothing interesting is still returned (empty files) so the
  // preview can note "found but empty"; callers filter as needed.
  return { kind: spec.kind, scope: spec.scope, root: spec.root, files };
}

/**
 * Detect all Claude/Cursor sources. Also probes for a top-level CLAUDE.md next
 * to cwd (and ~/.claude/CLAUDE.md) as a memory signal.
 */
export function detectSources(home: string, cwd: string, fs: FsFacade): DetectedSource[] {
  const out: DetectedSource[] = [];
  for (const spec of candidateRoots(home, cwd)) {
    const detected = detectAt(spec, fs);
    if (detected) out.push(detected);
  }
  return out;
}

/** Locate project + user CLAUDE.md memory files (informational only). */
export function detectMemoryFiles(home: string, cwd: string, fs: FsFacade): string[] {
  const out: string[] = [];
  const candidates = [
    join(cwd, "CLAUDE.md"),
    join(cwd, ".claude", "CLAUDE.md"),
    join(home, ".claude", "CLAUDE.md"),
  ];
  for (const c of candidates) {
    if (fileIf(fs, c)) out.push(c);
  }
  return out;
}
