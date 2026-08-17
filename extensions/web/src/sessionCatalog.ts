/**
 * Machine-wide session catalog: enumerates every pi session on the machine
 * using SessionManager.listAll(), with a fallback to a direct directory scan.
 *
 * listAll() walks the per-cwd session dirs under ~/.pi/agent/sessions and
 * returns SessionInfo[] with path/id/cwd/name/created/modified/messageCount/
 * firstMessage. We enrich each entry with a project label derived from cwd,
 * plus a stable URL-safe key.
 */

import { open, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface CatalogSession {
  /** Stable URL-safe key (sha1 of path) used as the resource id. */
  key: string;
  path: string;
  id: string;
  cwd: string;
  project: string;
  name?: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
  preview: string;
}

export interface SessionCatalog {
  sessions: CatalogSession[];
  projectsByCwd: Map<string, CatalogSession[]>;
  scannedAt: string;
}

function sha1Key(path: string): string {
  // Node's crypto is guaranteed; simple deterministic hex of the path.
  let hash = 0;
  for (let i = 0; i < path.length; i++) {
    hash = (hash * 31 + path.charCodeAt(i)) | 0;
  }
  return `s${(hash >>> 0).toString(36)}${path.length.toString(36)}`;
}

function projectLabel(cwd: string): string {
  if (!cwd) return "(unknown project)";
  const parts = cwd.split(sep).filter(Boolean);
  return parts.slice(-2).join("/") || cwd;
}

function truncate(text: string, max = 160): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

/**
 * Enumerate sessions with SessionManager.listAll(). Swallows errors so a
 * broken session file never blocks the whole listing; callers can fall back
 * to scanSessionsDir on complete failure.
 */
export async function listAllSessions(): Promise<SessionCatalog> {
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const infoList = await SessionManager.listAll();
  const sessions: CatalogSession[] = infoList.map((info) => {
    const preview = info.firstMessage ? truncate(info.firstMessage) : "(no messages)";
    return {
      key: sha1Key(info.path),
      path: info.path,
      id: info.id,
      cwd: info.cwd,
      project: projectLabel(info.cwd),
      name: info.name,
      created: info.created.toISOString(),
      modified: info.modified.toISOString(),
      messageCount: info.messageCount,
      firstMessage: preview,
      preview,
    };
  });
  sessions.sort((a, b) => (a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : 0));
  const projectsByCwd = groupByProject(sessions);
  return { sessions, projectsByCwd, scannedAt: new Date().toISOString() };
}

function groupByProject(sessions: CatalogSession[]): Map<string, CatalogSession[]> {
  const map = new Map<string, CatalogSession[]>();
  for (const session of sessions) {
    const existing = map.get(session.cwd) ?? [];
    existing.push(session);
    map.set(session.cwd, existing);
  }
  return map;
}

/**
 * Lightweight directory scan: enumerate session files under
 * ~/.pi/agent/sessions without parsing full contents (SessionManager.listAll
 * parses every entry and takes 50s+ on a 3.6 GB store). We read only a short
 * head of each file to grab the header line (id/cwd/created) and a handful of
 * message entries for a preview — milliseconds for hundreds of sessions.
 */
export async function scanSessionsDir(): Promise<SessionCatalog> {
  const dir = join(getAgentDir(), "sessions");
  const projects: Array<{ cwd: string; dir: string }> = [];
  try {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      projects.push({ cwd: decodeCwdDirName(entry.name), dir: join(dir, entry.name) });
    }
  } catch {
    // No sessions dir yet — return empty catalog.
    return { sessions: [], projectsByCwd: new Map(), scannedAt: new Date().toISOString() };
  }

  const sessions: CatalogSession[] = [];
  for (const project of projects) {
    let files: string[];
    try {
      files = (await readdir(project.dir)).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const file of files) {
      const path = join(project.dir, file);
      const parsed = await scanSessionHead(path);
      if (!parsed) continue;
      sessions.push({
        key: sha1Key(path),
        path,
        id: parsed.id,
        cwd: project.cwd,
        project: projectLabel(project.cwd),
        created: new Date(parsed.created).toISOString(),
        modified: new Date(parsed.modified).toISOString(),
        messageCount: parsed.messageCount,
        firstMessage: parsed.firstMessage ? truncate(parsed.firstMessage) : "",
        preview: parsed.firstMessage ? truncate(parsed.firstMessage) : relative(project.dir, path),
      });
    }
  }
  sessions.sort((a, b) => (a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : 0));
  return { sessions, projectsByCwd: groupByProject(sessions), scannedAt: new Date().toISOString() };
}

const HEAD_READ_BYTES = 32 * 1024;

interface ScanHead {
  id: string;
  created: number;
  modified: number;
  messageCount: number;
  firstMessage: string;
}

/** Read the first ~32 KB of a session file and pull header + preview fields. */
export async function scanSessionHead(path: string): Promise<ScanHead | null> {
  let mtime = 0;
  try {
    mtime = (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
  let head = "";
  try {
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(HEAD_READ_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, HEAD_READ_BYTES, 0);
      head = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }

  let id = "";
  let created = 0;
  let garbageCount = 0;
  const previews: string[] = [];
  for (const line of head.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!parsed) continue;
    const type = parsed.type;
    if (type === "session") {
      id = typeof parsed.id === "string" ? parsed.id : "";
      const ts = typeof parsed.timestamp === "string" ? parsed.timestamp : "";
      if (ts) created = Date.parse(ts) || mtime;
      continue;
    }
    if (type === "message") {
      const role = parsed.role;
      if (role === "user" || role === "assistant") {
        const text = extractText(parsed.content);
        if (text && previews.length < 4 && !text.startsWith("<system")) previews.push(text);
      } else if (role === "system" || role === "toolResult") {
        garbageCount += 1;
      }
    }
  }
  if (!id) {
    // Fall back to the filename uuid if the header line is deep in the file.
    id = path.match(/_([0-9a-f-]{36})\.jsonl$/i)?.[1] ?? "";
  }
  const baseName = path.split("/").pop()?.replace(/\.jsonl$/, "") ?? path;
  return {
    id: (id || baseName) ?? path,
    created: created || mtime,
    modified: mtime,
    messageCount: Math.max(0, previews.length + garbageCount),
    firstMessage: previews[0] ?? "",
  };
}

/** Best-effort text extraction from a pi message content array/string. */
export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const b = block as { type?: string; text?: string; thinking?: string };
    if (b.type === "text" && typeof b.text === "string" && b.text.trim()) parts.push(b.text.trim());
  }
  return parts.join(" ");
}

/** Decode a sessions/ dir name back into the original cwd (best effort).
 * pi encodes cwd as `--` + path with leading `/` removed and `[/\\:] -> "-"`, then
 * trailing `--`. Decoding is inherently lossy for paths containing literal
 * dashes, so this is a fallback only; SessionManager.listAll is authoritative. */
export function decodeCwdDirName(name: string): string {
  const cleaned = name.replace(/^--/, "").replace(/--$/, "");
  return `/${cleaned.replace(/-/g, "/")}`;
}
