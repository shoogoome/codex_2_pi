/**
 * Compose the injected memory block. On an armed turn (first turn of a session,
 * and the first turn after each compaction) the block carries the rules section
 * that teaches the model how memory works plus the full MEMORY.md index. On
 * every turn it may also carry the topic bodies recalled for the current prompt.
 *
 * Pure string assembly — no fs, no pi API.
 */
import type { RecalledTopic } from "./recall.js";

export interface BuildInjectionOptions {
  /** Absolute path of the memory directory, shown to the model in the rules. */
  memoryDir: string;
  /** Absolute path of the MEMORY.md index file. */
  indexPath: string;
  /** Raw MEMORY.md contents (index). Included only when includeRulesAndIndex. */
  index: string | null;
  /** Topics recalled this turn (already body-truncated). */
  recalled: RecalledTopic[];
  /** When true, emit the rules + full index (armed turn); else recall-only. */
  includeRulesAndIndex: boolean;
}

function rulesSection(memoryDir: string, indexPath: string): string {
  return [
    "# Long-term memory",
    "",
    "You have a persistent memory directory scoped to this project:",
    "",
    `  ${memoryDir}`,
    "",
    "It contains an index file (`MEMORY.md`) and one markdown file per topic.",
    "Each topic file starts with frontmatter:",
    "",
    "```",
    "---",
    "name: <short title>",
    "description: <one line, used for recall>",
    "type: user | feedback | project | reference",
    "---",
    "<markdown body — durable facts, one bullet per fact>",
    "```",
    "",
    "Type meanings: `user` = the user's stable preferences/identity; `feedback` = " +
      "corrections they gave you; `project` = durable facts about this codebase; " +
      "`reference` = external knowledge worth keeping.",
    "",
    "How to maintain memory (do this with ordinary read/write/edit tools):",
    "- When you learn something durable and reusable, write or update a topic file.",
    `- Keep the index (\`${indexPath}\`) in sync — one line per topic:`,
    "  `` - `topic-file.md` — **Name** (type): description ``",
    "- Prefer editing an existing topic over creating near-duplicates.",
    "- Store durable facts only — not transient task state or secrets.",
    "",
    "The index below is injected automatically; recalled topic bodies for the " +
      "current request may follow it.",
  ].join("\n");
}

/**
 * Build the block, or return null when there is nothing to inject (not armed and
 * no recall).
 */
export function buildInjection(opts: BuildInjectionOptions): string | null {
  const parts: string[] = [];

  if (opts.includeRulesAndIndex) {
    parts.push(rulesSection(opts.memoryDir, opts.indexPath));
    const index = (opts.index ?? "").trim();
    parts.push(
      "## Memory index\n\n" + (index.length > 0 ? index : "_(empty)_"),
    );
  }

  if (opts.recalled.length > 0) {
    const topicBlocks = opts.recalled.map((t) => {
      const header = `### ${t.name} (${t.type}) — \`${t.path}\``;
      return `${header}\n\n${t.body.trim()}`;
    });
    parts.push(
      "## Recalled memory (relevant to this request)\n\n" +
        topicBlocks.join("\n\n"),
    );
  }

  if (parts.length === 0) return null;
  return parts.join("\n\n");
}
