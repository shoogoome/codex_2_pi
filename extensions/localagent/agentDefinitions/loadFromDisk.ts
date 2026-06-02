import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentDefinition, AgentSource } from "../types.js";
import { parseAgentMarkdown } from "./frontmatter.js";

/**
 * Load all *.md files in `dir` as AgentDefinition. Missing dir → []. Parse
 * errors are silently skipped (file may not be an agent definition).
 */
export async function loadAgentsFromDir(
  dir: string,
  source: AgentSource,
): Promise<AgentDefinition[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (e) {
    if (typeof e === "object" && e && "code" in e && (e as { code: unknown }).code === "ENOENT") {
      return [];
    }
    throw e;
  }
  const out: AgentDefinition[] = [];
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    try {
      const content = await readFile(join(dir, name), "utf8");
      const r = parseAgentMarkdown(content, source, name);
      if (r.ok) out.push(r.def);
    } catch {/* skip unreadable file */}
  }
  return out;
}
