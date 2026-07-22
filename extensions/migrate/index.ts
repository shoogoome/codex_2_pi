// migrate extension — one-shot importer of Claude Code / Cursor config into
// pi's own config surface, exposed as `/migrate`. This is the ONLY file that
// touches the pi API and the real filesystem; every decision lives in pure
// src/ functions over an injected FsFacade so tests never hit disk or network.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { applyHookToConfigText } from "./src/mapHooks.js";
import { applyServerToConfigText } from "./src/mapMcp.js";
import { parseClaudeSource } from "./src/parseClaude.js";
import { parseCursorSource } from "./src/parseCursor.js";
import {
  buildPlan,
  computeTargets,
  createCount,
  renderPlan,
} from "./src/plan.js";
import { detectMemoryFiles, detectSources } from "./src/sources.js";
import {
  MIGRATION_CATEGORIES,
  type FsFacade,
  type MigrationCategory,
  type MigrationItem,
  type MigrationPlan,
  type ParsedConfig,
} from "./src/types.js";

/** node:fs-backed facade handed to the pure core. */
function realFs(): FsFacade {
  return {
    existsSync: (p) => existsSync(p),
    readFileSync: (p) => readFileSync(p, "utf8"),
    readdirSync: (p) => readdirSync(p),
    isDirectory: (p) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    },
  };
}

function emptyParsed(): ParsedConfig {
  return { mcpServers: [], agents: [], commands: [], hooks: [], memory: [], warnings: [] };
}

/** Detect + parse every Claude/Cursor source into one merged ParsedConfig. */
function collectParsed(home: string, cwd: string, fs: FsFacade): ParsedConfig {
  const merged = emptyParsed();
  for (const source of detectSources(home, cwd, fs)) {
    const frag = source.kind === "claude" ? parseClaudeSource(source, fs) : parseCursorSource(source, fs);
    merged.mcpServers.push(...frag.mcpServers);
    merged.agents.push(...frag.agents);
    merged.commands.push(...frag.commands);
    merged.hooks.push(...frag.hooks);
    merged.memory.push(...frag.memory);
    merged.warnings.push(...frag.warnings);
  }
  // CLAUDE.md memory files: informational (agents-context loads them natively).
  for (const path of detectMemoryFiles(home, cwd, fs)) {
    merged.memory.push({ path, note: "CLAUDE.md — already loaded by agents-context" });
  }
  return merged;
}

/** Parse a category argument; returns undefined when none/invalid. */
function parseCategoryArg(args: string): MigrationCategory | undefined {
  const a = args.trim().toLowerCase();
  if (!a) return undefined;
  const token = a.split(/\s+/)[0];
  return (MIGRATION_CATEGORIES as readonly string[]).includes(token)
    ? (token as MigrationCategory)
    : undefined;
}

/** Per-category counts of create items in a plan. */
function createCountsByCategory(plan: MigrationPlan): Map<MigrationCategory, number> {
  const counts = new Map<MigrationCategory, number>();
  for (const item of plan.items) {
    if (item.action !== "create") continue;
    counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
  }
  return counts;
}

const CATEGORY_PROMPT: Record<MigrationCategory, string> = {
  mcp: "MCP servers",
  agents: "Subagents",
  commands: "Commands (slash → prompts)",
  hooks: "Hooks",
  memory: "Memory",
};

/** Interactive per-category confirm; returns the set the user approved. */
async function pickCategories(
  ctx: ExtensionCommandContext,
  counts: Map<MigrationCategory, number>,
): Promise<Set<MigrationCategory>> {
  const chosen = new Set<MigrationCategory>();
  for (const cat of MIGRATION_CATEGORIES) {
    const n = counts.get(cat) ?? 0;
    if (n === 0) continue;
    const ok = await ctx.ui.confirm(
      "Migrate category",
      `${CATEGORY_PROMPT[cat]}: ${n} new item(s) to import. Include?`,
    );
    if (ok) chosen.add(cat);
  }
  return chosen;
}

/** Ensure a directory exists (recursive). */
function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

interface ApplyResult {
  written: number;
  failures: string[];
}

/**
 * Apply the create items whose category is in `writeCats`. MCP + hooks are
 * merged into their single JSON file (read → merge each → write once);
 * agents/prompts are written as individual files. Every write is guarded so a
 * single failure never aborts the run.
 */
function applyPlan(plan: MigrationPlan, writeCats: Set<MigrationCategory>, cwd: string): ApplyResult {
  const targets = computeTargets(cwd);
  const failures: string[] = [];
  let written = 0;

  const creates = (cat: MigrationCategory): MigrationItem[] =>
    plan.items.filter((i) => i.category === cat && i.action === "create");

  // MCP: fold all new servers into mcp.json text, then write once.
  if (writeCats.has("mcp")) {
    const items = creates("mcp");
    if (items.length > 0) {
      try {
        ensureDir(join(cwd, ".pi"));
        let text = existsSync(targets.mcpPath) ? readFileSync(targets.mcpPath, "utf8") : "";
        for (const item of items) {
          if (item.payload.kind !== "mcp") continue;
          text = applyServerToConfigText(text, item.payload.serverName, item.payload.config);
        }
        writeFileSync(targets.mcpPath, text);
        written += items.length;
      } catch (err) {
        failures.push(`mcp.json: ${(err as Error).message}`);
      }
    }
  }

  // Hooks: fold all new triples into hooks.json text, then write once.
  if (writeCats.has("hooks")) {
    const items = creates("hooks");
    if (items.length > 0) {
      try {
        ensureDir(join(cwd, ".pi"));
        let text = existsSync(targets.hooksPath) ? readFileSync(targets.hooksPath, "utf8") : "";
        for (const item of items) {
          if (item.payload.kind !== "hook") continue;
          text = applyHookToConfigText(text, {
            event: item.payload.event,
            matcher: item.payload.matcher,
            hookType: item.payload.hookType,
            command: item.payload.command,
            origin: "",
          });
        }
        writeFileSync(targets.hooksPath, text);
        written += items.length;
      } catch (err) {
        failures.push(`hooks.json: ${(err as Error).message}`);
      }
    }
  }

  // Agents + prompts: one file per item.
  const fileGroups: { cat: MigrationCategory; dir: string }[] = [
    { cat: "agents", dir: targets.agentsDir },
    { cat: "commands", dir: targets.promptsDir },
  ];
  for (const { cat, dir } of fileGroups) {
    if (!writeCats.has(cat)) continue;
    for (const item of creates(cat)) {
      const content = item.payload.kind === "agent" || item.payload.kind === "prompt"
        ? item.payload.content
        : undefined;
      if (content === undefined) continue;
      try {
        ensureDir(dir);
        writeFileSync(item.targetPath, content);
        written += 1;
      } catch (err) {
        failures.push(`${item.targetPath}: ${(err as Error).message}`);
      }
    }
  }

  return { written, failures };
}

export default function migrateExtension(pi: ExtensionAPI): void {
  pi.registerFlag("dry-run", {
    description: "Preview the migration plan without writing any files",
    type: "boolean",
    default: false,
  });

  pi.registerCommand("migrate", {
    description: "Import Claude Code / Cursor config (MCP, agents, commands, hooks) into pi's .pi/",
    getArgumentCompletions: (prefix: string) => {
      const p = prefix.trimStart().toLowerCase();
      return MIGRATION_CATEGORIES.filter((c) => c.startsWith(p)).map((c) => ({
        value: c,
        label: c,
        description: `Only migrate ${CATEGORY_PROMPT[c]}`,
      }));
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const fs = realFs();
      const home = homedir();
      const cwd = ctx.cwd;

      const parsed = collectParsed(home, cwd, fs);
      const fullPlan = buildPlan(parsed, fs, cwd);
      const dryRunFlag = pi.getFlag("dry-run") === true;
      const argCat = parseCategoryArg(args);

      const total = createCount(fullPlan);
      if (fullPlan.items.length === 0 && parsed.warnings.length === 0) {
        ctx.ui.notify("No Claude/Cursor config found to migrate.", "info");
        return;
      }

      // Always show the preview first.
      ctx.ui.notify(renderPlan(fullPlan), "info");

      // Sources exist but pi already has everything importable → nothing new.
      if (total === 0) {
        ctx.ui.notify("Everything is already present in .pi/ — nothing new to migrate.", "info");
        return;
      }

      // Decide which categories to write.
      let writeCats: Set<MigrationCategory>;
      if (argCat) {
        writeCats = new Set([argCat]);
      } else if (ctx.hasUI) {
        writeCats = await pickCategories(ctx, createCountsByCategory(fullPlan));
      } else {
        writeCats = new Set(); // non-interactive, no arg → dry-run only
      }

      // Dry-run short-circuits before any write.
      const forceDryRun = dryRunFlag || (!ctx.hasUI && !argCat);
      if (forceDryRun) {
        ctx.ui.notify("Dry run — no files written. Re-run without --dry-run to apply.", "info");
        return;
      }
      if (writeCats.size === 0) {
        ctx.ui.notify("No categories selected — nothing written.", "info");
        return;
      }

      // Count what the selected categories would actually create.
      const selectedCreate = fullPlan.items.filter(
        (i) => i.action === "create" && writeCats.has(i.category),
      ).length;
      if (selectedCreate === 0) {
        ctx.ui.notify("Selected categories have nothing new to import.", "info");
        return;
      }

      // Final confirm in interactive mode.
      if (ctx.hasUI) {
        const ok = await ctx.ui.confirm(
          "Apply migration",
          `Write ${selectedCreate} new item(s) into ${cwd}/.pi/ ?`,
        );
        if (!ok) {
          ctx.ui.notify("Migration cancelled — nothing written.", "info");
          return;
        }
      }

      const result = applyPlan(fullPlan, writeCats, cwd);
      if (result.failures.length > 0) {
        ctx.ui.notify(
          `Migrated ${result.written} item(s); ${result.failures.length} failed: ${result.failures.join("; ")}`,
          "warning",
        );
      } else {
        ctx.ui.notify(`Migrated ${result.written} item(s) into ${cwd}/.pi/.`, "info");
      }
    },
  });
}
