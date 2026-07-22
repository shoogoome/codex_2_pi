/**
 * Pure session-list logic for the resume-picker extension.
 *
 * SessionManager.list()/listAll() already return SessionInfo[] with everything
 * needed (name, firstMessage summary, modified date, messageCount, cwd), so no
 * file-head parsing is required here. This module owns the small, deterministic,
 * I/O-free transforms: arg parsing, summary/label derivation, filtering, sorting
 * and pagination. Everything is exported and unit-tested.
 */

import { basename } from "node:path";
import { homedir } from "node:os";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { truncateOneLine } from "../../shared/text.js";

/** A display-ready projection of SessionInfo used by the /resume-picker overlay. */
export interface SessionRow {
  id: string;
  /** Absolute path to the session .jsonl file — passed to ctx.switchSession. */
  path: string;
  /** Working directory the session was started in (may be empty for old sessions). */
  cwd: string;
  /** User-defined display name, if any. */
  name?: string;
  /** Human-readable one-line summary (name || firstMessage || fallback). */
  summary: string;
  modified: Date;
  messageCount: number;
}

/**
 * One-line summary for a session: prefer the user-defined name, then the first
 * user message, then a stable fallback. firstMessage is already the cleaned
 * first USER message text produced by SessionManager.
 */
export function summaryOf(info: Pick<SessionInfo, "name" | "firstMessage">): string {
  const name = info.name?.trim();
  if (name) return name;
  const first = info.firstMessage?.trim();
  if (first) return first;
  return "(no messages)";
}

/** Short project label for cross-project listings: basename of cwd, or "~" for home. */
export function projectLabel(cwd: string): string {
  if (!cwd) return "(unknown)";
  const home = homedir();
  if (cwd === home) return "~";
  const base = basename(cwd);
  return base || cwd;
}

/** Compact relative time like "3m ago" / "2d ago" for display. */
export function relativeTime(date: Date, now: Date = new Date()): string {
  const ms = now.getTime() - date.getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  const y = Math.floor(d / 365);
  return `${y}y ago`;
}

/**
 * Parse a raw command argument string into flags + free-text filter.
 * `--all` / `-a` selects the cross-project listing; everything else joins into
 * the title/keyword filter.
 */
export function parseResumeArgs(raw: string): { all: boolean; filter: string } {
  const tokens = (raw ?? "").trim().split(/\s+/).filter(Boolean);
  let all = false;
  const rest: string[] = [];
  for (const tok of tokens) {
    if (tok === "--all" || tok === "-a") all = true;
    else rest.push(tok);
  }
  return { all, filter: rest.join(" ") };
}

/** Project SessionInfo[] into display rows. */
export function toRows(infos: SessionInfo[]): SessionRow[] {
  return infos.map((info) => ({
    id: info.id,
    path: info.path,
    cwd: info.cwd,
    name: info.name,
    summary: summaryOf(info),
    modified: info.modified,
    messageCount: info.messageCount,
  }));
}

/** Case-insensitive substring filter over summary + name + project label. */
export function filterByTitle(rows: SessionRow[], q: string): SessionRow[] {
  const needle = (q ?? "").trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((r) => {
    const hay = `${r.summary} ${r.name ?? ""} ${projectLabel(r.cwd)}`.toLowerCase();
    return hay.includes(needle);
  });
}

/** Newest-first by modified time. list()/listAll() already sort, but keep it deterministic. */
export function sortByModified(rows: SessionRow[]): SessionRow[] {
  return [...rows].sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

/** Slice a page (0-based) of size pageSize. */
export function paginate<T>(items: T[], page: number, pageSize: number): T[] {
  if (pageSize <= 0) return [];
  const start = Math.max(0, Math.floor(page)) * pageSize;
  return items.slice(start, start + pageSize);
}

/**
 * One-line label for a session shown in the ctx.ui.select picker, e.g.
 * "3m ago · projX · Fix the login bug (12 msgs)". `showProject` adds the project
 * label (used by the cross-project /resume-picker --all listing).
 */
export function formatSessionLabel(
  row: SessionRow,
  opts: { showProject?: boolean; summaryWidth?: number } = {},
  now?: Date,
): string {
  const when = relativeTime(row.modified, now);
  const proj = opts.showProject ? `${projectLabel(row.cwd)} · ` : "";
  const msgs = row.messageCount === 1 ? "1 msg" : `${row.messageCount} msgs`;
  const summary = truncateOneLine(row.summary, opts.summaryWidth ?? 80);
  return `${when} · ${proj}${summary} (${msgs})`;
}
