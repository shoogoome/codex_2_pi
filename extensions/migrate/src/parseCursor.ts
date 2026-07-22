// Pure Cursor config parsing. Cursor's surface is thin: reliably only
// `mcp.json` (its `mcpServers` map, same Claude-compatible shape) and
// `rules/*.mdc` (memory-like, informational). Cursor has no subagents, hooks,
// or slash commands, so those categories stay empty.

import { join } from "node:path";
import { normalizeServerConfig } from "./mapMcp.js";
import type { DetectedSource, FsFacade, ParsedConfig } from "./types.js";

function emptyParsed(): ParsedConfig {
  return { mcpServers: [], agents: [], commands: [], hooks: [], memory: [], warnings: [] };
}

/** Parse one detected Cursor source into a ParsedConfig fragment. */
export function parseCursorSource(source: DetectedSource, fs: FsFacade): ParsedConfig {
  const out = emptyParsed();
  if (source.kind !== "cursor") return out;
  const f = source.files;

  if (f.mcpJson) {
    let text: string;
    try {
      text = fs.readFileSync(f.mcpJson);
    } catch (err) {
      out.warnings.push({ file: f.mcpJson, message: `unreadable: ${(err as Error).message}` });
      text = "";
    }
    const trimmed = text.trim();
    if (trimmed.length > 0) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch (err) {
        out.warnings.push({ file: f.mcpJson, message: `invalid JSON: ${(err as Error).message}` });
        parsed = undefined;
      }
      if (parsed !== null && typeof parsed === "object") {
        const raw = (parsed as Record<string, unknown>).mcpServers;
        if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
          for (const [name, entry] of Object.entries(raw as Record<string, unknown>)) {
            const config = normalizeServerConfig(entry);
            if (!config) {
              out.warnings.push({ file: f.mcpJson, message: `mcp server "${name}": missing command or url` });
              continue;
            }
            out.mcpServers.push({ name, config, origin: f.mcpJson });
          }
        }
      }
    }
  }

  // Cursor rules are memory-like — note them, never copy (agents-context loads
  // AGENTS.md/CLAUDE.md natively; Cursor .mdc has no pi equivalent to import).
  if (f.rulesDir) {
    out.memory.push({
      path: f.rulesDir,
      note: "Cursor rules/*.mdc — informational only, not migrated",
    });
  }

  return out;
}

/** Convenience for callers that know the rules dir path. */
export function cursorRulesPath(root: string): string {
  return join(root, "rules");
}
