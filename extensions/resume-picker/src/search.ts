/**
 * Pure logic for /search: rg argument construction, rg --json output parsing,
 * snippet cleanup, hit→session joining, and an in-memory fallback. No I/O here —
 * index.ts runs pi.exec and feeds captured stdout into these functions.
 */

import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { projectLabel, relativeTime, toRows, type SessionRow } from "./sessions.js";

/** A single rg match line. */
export interface RgHit {
  file: string;
  lineNumber: number;
  /** Raw matched physical line (one jsonl entry). */
  text: string;
}

/** A session that matched, with a readable snippet from its first hit. */
export interface SearchResult {
  session: SessionRow;
  snippet: string;
  line: number;
  /** Number of matching lines within this session file. */
  count: number;
}

/**
 * Build rg args to search session .jsonl files for a fixed string.
 * `-F` (fixed-string) prevents regex injection from arbitrary keywords;
 * `--json` gives structured output; `-g '*.jsonl'` scopes to session files;
 * `--no-messages` suppresses fs errors. `--` terminates flags so a keyword that
 * starts with `-` is still treated as the pattern.
 */
export function buildRgArgs(query: string, root: string): string[] {
  return ["--json", "-F", "--no-messages", "-g", "*.jsonl", "--", query, root];
}

/** Parse rg --json stdout into hits, tolerating non-JSON / non-match lines. */
export function parseRgJson(stdout: string): RgHit[] {
  const hits: RgHit[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: any;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (obj?.type !== "match") continue;
    const data = obj.data;
    const file: unknown = data?.path?.text;
    if (typeof file !== "string") continue;
    const lineNumber = typeof data?.line_number === "number" ? data.line_number : 0;
    const text = typeof data?.lines?.text === "string" ? data.lines.text : "";
    hits.push({ file, lineNumber, text });
  }
  return hits;
}

/** Pull readable message text out of a parsed session entry, if present. */
function extractMessageText(entry: any): string | undefined {
  const msg = entry?.message;
  const content = msg?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content.map((c) => (typeof c === "string" ? c : (c?.text ?? "")));
    const joined = parts.filter((p: string) => p).join(" ");
    return joined || undefined;
  }
  return undefined;
}

/** Truncate to maxLen, centering the window on the first case-insensitive match. */
function centerOnQuery(text: string, query: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const idx = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1;
  if (idx < 0) return `${text.slice(0, Math.max(0, maxLen - 1))}…`;
  const half = Math.floor(Math.max(0, maxLen - query.length) / 2);
  let end = Math.min(text.length, idx + query.length + half);
  let start = Math.max(0, end - maxLen);
  end = Math.min(text.length, start + maxLen);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end)}${suffix}`;
}

/**
 * Turn a raw matched jsonl line into a readable snippet. Each rg match is a
 * single physical line, and jsonl stores one entry per line, so JSON.parse is
 * safe; on any parse failure we degrade gracefully to the raw text.
 */
export function cleanSnippet(rawLine: string, query: string, maxLen = 160): string {
  let text = rawLine ?? "";
  try {
    const entry = JSON.parse(text);
    const extracted = extractMessageText(entry);
    if (extracted) text = extracted;
  } catch {
    // keep raw line
  }
  text = text.replace(/\s+/g, " ").trim();
  return centerOnQuery(text, query, maxLen);
}

/** Group hits by file and join to sessions by path; newest session first. */
export function mapHitsToSessions(
  hits: RgHit[],
  infos: SessionInfo[],
  query: string,
): SearchResult[] {
  const byPath = new Map<string, SessionRow>();
  for (const row of toRows(infos)) byPath.set(row.path, row);

  const grouped = new Map<string, { row: SessionRow; firstHit: RgHit; count: number }>();
  for (const hit of hits) {
    const row = byPath.get(hit.file);
    if (!row) continue;
    const existing = grouped.get(hit.file);
    if (existing) existing.count += 1;
    else grouped.set(hit.file, { row, firstHit: hit, count: 1 });
  }

  return [...grouped.values()]
    .map((g) => ({
      session: g.row,
      snippet: cleanSnippet(g.firstHit.text, query),
      line: g.firstHit.lineNumber,
      count: g.count,
    }))
    .sort((a, b) => b.session.modified.getTime() - a.session.modified.getTime());
}

/**
 * Fallback when rg is unavailable/errored: substring-match over the already
 * loaded allMessagesText. Newest session first.
 */
export function inMemoryFallback(
  infos: SessionInfo[],
  query: string,
  maxLen = 160,
): SearchResult[] {
  const needle = (query ?? "").toLowerCase();
  if (!needle) return [];
  const results: SearchResult[] = [];
  for (const info of infos) {
    const hay = info.allMessagesText ?? "";
    if (!hay.toLowerCase().includes(needle)) continue;
    const [row] = toRows([info]);
    results.push({ session: row, snippet: cleanSnippet(hay, query, maxLen), line: 0, count: 1 });
  }
  return results.sort((a, b) => b.session.modified.getTime() - a.session.modified.getTime());
}

/**
 * One-line label for a search hit shown in the ctx.ui.select picker, e.g.
 * "3m ago · projX · 2 hits: …matched snippet…".
 */
export function formatSearchLabel(result: SearchResult, now?: Date): string {
  const when = relativeTime(result.session.modified, now);
  const proj = projectLabel(result.session.cwd);
  const hits = result.count === 1 ? "1 hit" : `${result.count} hits`;
  return `${when} · ${proj} · ${hits}: ${result.snippet}`;
}
