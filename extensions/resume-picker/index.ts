/**
 * resume-picker — session resume + full-text search commands for pi.
 *
 *   /resume-picker [--all] [filter]  Browse past sessions (this project, or all
 *                              projects with --all), optionally title-filtered,
 *                              and switch to the chosen one. Named `resume-picker`
 *                              (not `resume`) to avoid clashing with pi's built-in
 *                              `/resume`, which would otherwise shadow this command.
 *   /search <keyword>          Full-text search session .jsonl files (via rg,
 *                              with an in-memory fallback) and resume a hit.
 *
 * Deliberately uses the built-in `ctx.ui.select(title, string[])` picker rather
 * than a self-drawn overlay: select owns its own key handling, so there is zero
 * capture/focus-deadlock risk. All list parsing / summarising / rg-output
 * parsing lives in the pure, unit-tested modules under ./src.
 */

import { join } from "node:path";
import {
  getAgentDir,
  SessionManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import {
  filterByTitle,
  formatSessionLabel,
  parseResumeArgs,
  sortByModified,
  toRows,
} from "./src/sessions.js";
import {
  buildRgArgs,
  formatSearchLabel,
  inMemoryFallback,
  mapHitsToSessions,
  parseRgJson,
  type SearchResult,
} from "./src/search.js";

/** Cap how many rows we hand to the picker so a huge history stays responsive. */
const MAX_OPTIONS = 200;
/** rg wall-clock budget. */
const RG_TIMEOUT_MS = 15_000;

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Build index-prefixed picker options (so labels are unique even when two
 * sessions share a summary) plus a resolver that maps the selected label back
 * to its item. ctx.ui.select returns the chosen string, so the "1." prefix +
 * indexOf round-trip is the robust way to recover the item.
 */
export function labeledOptions<T>(
  items: T[],
  label: (item: T) => string,
): { options: string[]; pick: (selected: string | undefined) => T | undefined } {
  const options = items.map((item, i) => `${i + 1}. ${label(item)}`);
  return {
    options,
    pick: (selected) => {
      if (!selected) return undefined;
      const idx = options.indexOf(selected);
      return idx >= 0 ? items[idx] : undefined;
    },
  };
}

async function switchTo(ctx: ExtensionCommandContext, path: string): Promise<void> {
  try {
    const { cancelled } = await ctx.switchSession(path);
    if (cancelled) ctx.ui.notify("Session switch cancelled.", "info");
  } catch (err) {
    ctx.ui.notify(`Could not switch session: ${errMsg(err)}`, "error");
  }
}

async function runResume(args: string, ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("/resume-picker needs an interactive terminal.", "warning");
    return;
  }

  const { all, filter } = parseResumeArgs(args);

  let infos: SessionInfo[];
  try {
    infos = all ? await SessionManager.listAll() : await SessionManager.list(ctx.cwd);
  } catch (err) {
    ctx.ui.notify(`Could not list sessions: ${errMsg(err)}`, "error");
    return;
  }

  let rows = filterByTitle(sortByModified(toRows(infos)), filter);
  if (rows.length === 0) {
    ctx.ui.notify(
      all ? "No sessions found." : "No sessions for this project. Try /resume-picker --all.",
      "info",
    );
    return;
  }

  const capped = rows.length > MAX_OPTIONS;
  if (capped) rows = rows.slice(0, MAX_OPTIONS);

  const { options, pick } = labeledOptions(rows, (row) =>
    formatSessionLabel(row, { showProject: all }),
  );
  const scope = all ? "Resume a session — all projects" : "Resume a session";
  const title =
    `${scope}${filter ? ` · "${filter}"` : ""}` + (capped ? ` (newest ${MAX_OPTIONS})` : "");

  let selected: string | undefined;
  try {
    selected = await ctx.ui.select(title, options);
  } catch (err) {
    ctx.ui.notify(`Selection failed: ${errMsg(err)}`, "error");
    return;
  }

  const row = pick(selected);
  if (!row) return; // user cancelled
  await switchTo(ctx, row.path);
}

/**
 * Run rg over the session store, degrading to an in-memory substring search when
 * rg is missing (spawn throws) or errored (exit code >= 2). rg exit 1 = "ran
 * fine, no matches", which we honour as an empty result rather than falling back.
 */
async function searchSessions(
  pi: ExtensionAPI,
  query: string,
  root: string,
  infos: SessionInfo[],
  ctx: ExtensionCommandContext,
): Promise<SearchResult[]> {
  try {
    const res = await pi.exec("rg", buildRgArgs(query, root), {
      cwd: ctx.cwd,
      timeout: RG_TIMEOUT_MS,
      signal: ctx.signal,
    });
    if (res.code > 1) return inMemoryFallback(infos, query);
    return mapHitsToSessions(parseRgJson(res.stdout), infos, query);
  } catch {
    return inMemoryFallback(infos, query);
  }
}

async function runSearch(
  pi: ExtensionAPI,
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("/search needs an interactive terminal.", "warning");
    return;
  }

  const query = args.trim();
  if (!query) {
    ctx.ui.notify("Usage: /search <keyword>", "warning");
    return;
  }

  let infos: SessionInfo[];
  try {
    infos = await SessionManager.listAll();
  } catch (err) {
    ctx.ui.notify(`Could not list sessions: ${errMsg(err)}`, "error");
    return;
  }

  const root = join(getAgentDir(), "sessions");
  let results: SearchResult[];
  try {
    results = await searchSessions(pi, query, root, infos, ctx);
  } catch (err) {
    ctx.ui.notify(`Search failed: ${errMsg(err)}`, "error");
    return;
  }

  if (results.length === 0) {
    ctx.ui.notify(`No sessions matched "${query}".`, "info");
    return;
  }

  const capped = results.length > MAX_OPTIONS;
  if (capped) results = results.slice(0, MAX_OPTIONS);

  const { options, pick } = labeledOptions(results, (result) => formatSearchLabel(result));
  const count = `${results.length} session${results.length === 1 ? "" : "s"}`;
  const title = `Search "${query}" — ${count}` + (capped ? ` (newest ${MAX_OPTIONS})` : "");

  let selected: string | undefined;
  try {
    selected = await ctx.ui.select(title, options);
  } catch (err) {
    ctx.ui.notify(`Selection failed: ${errMsg(err)}`, "error");
    return;
  }

  const hit = pick(selected);
  if (!hit) return; // user cancelled
  await switchTo(ctx, hit.session.path);
}

export default function resumePickerExtension(pi: ExtensionAPI): void {
  pi.registerCommand("resume-picker", {
    description: "Browse and resume a past session: /resume-picker [--all] [filter]",
    getArgumentCompletions: (prefix) => {
      const p = prefix.trim().toLowerCase();
      if (!p.startsWith("-")) return null;
      return [{ value: "--all", label: "--all  (search every project)" }].filter((c) =>
        c.value.startsWith(p),
      );
    },
    handler: (args, ctx) => runResume(args, ctx),
  });

  pi.registerCommand("search", {
    description: "Full-text search past sessions and resume one: /search <keyword>",
    handler: (args, ctx) => runSearch(pi, args, ctx),
  });
}
