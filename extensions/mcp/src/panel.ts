// McpPanel — a Claude-Code-style capturing overlay for /mcp.
//
// Like plugin-loader's PluginPanel, this is a pure UI/state-machine module:
// every side effect (connect, disk writes, registry mutation) is injected via
// `McpPanelDeps`, so the whole view state machine, key routing, row formatting,
// filtering and add-form parsing are unit-testable without pi, fs, a live MCP
// transport, or a real terminal.
//
// Screens implemented (see ft_local/plugin_mcp_tui_alignment.md §2.4):
//   M1 server list (grouped by source) · M2 stdio/remote server detail card +
//   action menu · M3 tool list · M4 single-tool detail (inputSchema params) ·
//   M5 add-server form (type/scope toggles + env/headers) · M6 remove confirm.
//
// Wiring contract (index.ts): open with ctx.ui.custom(factory,{overlay:true}),
// set panel.requestRender = () => tui.requestRender(), and feed every key via
// tui.addInputListener(data => { panel.handleInput(data); return {consume:true} }).
// NEVER nonCapturing — the overlay must own the keyboard.

import { matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { mcpToolName, sanitizeMcpSegment } from "./naming.js";
import type { McpServerConfig, McpToolDef, ServerSource } from "./types.js";

/** Loosely-typed theme surface (a real pi Theme satisfies this). */
export interface PanelTheme {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
  bold(text: string): string;
  inverse(text: string): string;
}

export type Transport = "stdio" | "http" | "sse";
export type Scope = "project" | "global";

/** One server row projected from the live registry (index.ts builds these). */
export interface McpServerRow {
  id: string; // canonical registry id (used in mcp__<id>__<tool>)
  rawName: string; // display + config-file key
  transport: Transport;
  source: ServerSource; // project | global | runtime
  status: "connected" | "error" | "disconnected";
  error?: string;
  toolCount: number;
  // stdio config detail
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // remote config detail
  url?: string;
  headers?: Record<string, string>;
}

/** One extracted inputSchema parameter for the tool-detail view. */
export interface McpToolParam {
  name: string;
  type: string;
  required: boolean;
  description?: string;
}

export interface AddServerForm {
  transport: Transport;
  scope: Scope;
  name: string;
  command: string;
  args: string;
  env: string;
  url: string;
  headers: string;
}

/** Result of an add-server attempt (index.ts writes config + connects). */
export interface AddResult {
  status: "connected" | "error" | "disconnected";
  error?: string;
}

/** Result of a remove attempt (source decides whether a file was touched). */
export interface RemoveResult {
  removedFromFile: boolean;
  message: string;
}

/**
 * Everything the panel needs from the outside. All ops read/mutate the live
 * registry inside index.ts's closure; the panel never touches fs or transports
 * directly. Async ops (reconnect/add) drive the per-server spinner.
 */
export interface McpPanelDeps {
  listServers(): McpServerRow[];
  toolsFor(id: string): McpToolDef[];
  configPaths(): { projectPath: string; globalPath: string };
  reconnect(id: string): Promise<void>;
  addServer(input: { name: string; scope: Scope; config: McpServerConfig }): Promise<AddResult>;
  removeServer(id: string): RemoveResult;
}

export type McpView =
  | { kind: "list" }
  | { kind: "server"; id: string }
  | { kind: "tools"; id: string }
  | { kind: "tool"; id: string; tool: string }
  | { kind: "add" }
  | { kind: "confirm-remove"; id: string };

const MAX_VISIBLE = 10;
const SOURCE_RANK: Record<string, number> = { project: 0, global: 1, runtime: 2 };
const TRANSPORTS: Transport[] = ["stdio", "http", "sse"];

// ── pure helpers (exported for tests) ────────────────────────────────────────

function isPrintable(data: string): boolean {
  return data.length === 1 && data.charCodeAt(0) >= 32;
}

/** Case-insensitive substring match over a row's searchable fields. */
export function matchesFilter(fields: Array<string | undefined>, filter: string): boolean {
  const q = filter.trim().toLowerCase();
  if (!q) return true;
  return fields.some((f) => (f ?? "").toLowerCase().includes(q));
}

export function filterServers(rows: McpServerRow[], filter: string): McpServerRow[] {
  return rows.filter((r) => matchesFilter([r.rawName, r.transport, r.source, r.status], filter));
}

export function filterTools(tools: McpToolDef[], filter: string): McpToolDef[] {
  return tools.filter((t) => matchesFilter([t.name, t.description], filter));
}

/** Stable sort by source group (project → global → runtime) then name. */
export function sortServers(rows: McpServerRow[]): McpServerRow[] {
  return [...rows].sort(
    (a, b) => (SOURCE_RANK[a.source] ?? 9) - (SOURCE_RANK[b.source] ?? 9) || a.rawName.localeCompare(b.rawName),
  );
}

/** Icon + palette color for a server's connection state (§2.4). */
export function statusIcon(
  status: McpServerRow["status"],
  connecting = false,
): { icon: string; color: string; word: string } {
  if (connecting) return { icon: "…", color: "warning", word: "connecting" };
  switch (status) {
    case "connected":
      return { icon: "✔", color: "success", word: "connected" };
    case "error":
      return { icon: "✗", color: "error", word: "error" };
    default:
      return { icon: "○", color: "dim", word: "disconnected" };
  }
}

/** Mask secret values in an env/headers map for display: `KEY=***`. */
export function maskSecrets(map: Record<string, string> | undefined): string {
  const keys = Object.keys(map ?? {});
  if (keys.length === 0) return "—";
  return keys.map((k) => `${k}=***`).join(", ");
}

/** Full flattened tool name as registered: mcp__<id>__<tool>. */
export function fullToolName(serverId: string, tool: string): string {
  return mcpToolName(serverId, sanitizeMcpSegment(tool));
}

/** Extract `{ name, type, required, description }` rows from a JSON inputSchema. */
export function extractToolParams(inputSchema: unknown): McpToolParam[] {
  if (!inputSchema || typeof inputSchema !== "object") return [];
  const schema = inputSchema as Record<string, unknown>;
  const props = schema.properties;
  if (!props || typeof props !== "object") return [];
  const required = Array.isArray(schema.required)
    ? schema.required.filter((x): x is string => typeof x === "string")
    : [];
  return Object.entries(props as Record<string, unknown>).map(([name, def]) => {
    const d = def && typeof def === "object" ? (def as Record<string, unknown>) : {};
    let type = "any";
    if (typeof d.type === "string") type = d.type;
    else if (Array.isArray(d.type)) type = d.type.filter((t) => typeof t === "string").join("|") || "any";
    return {
      name,
      type,
      required: required.includes(name),
      description: typeof d.description === "string" ? d.description : undefined,
    };
  });
}

/** Optional tool annotation (§2.7): only rendered when the server supplies it. */
export function toolAnnotation(tool: McpToolDef): { label: string; color: string } | undefined {
  const annotations = (tool as { annotations?: unknown }).annotations;
  if (!annotations || typeof annotations !== "object") return undefined;
  const a = annotations as Record<string, unknown>;
  if (a.destructiveHint === true) return { label: "destructive", color: "error" };
  if (a.readOnlyHint === true) return { label: "read-only", color: "success" };
  if (a.openWorldHint === true) return { label: "open-world", color: "warning" };
  return undefined;
}

/** Parse "K=V, K2=V2" into a record (used for env / headers form fields). */
export function parseKvPairs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of raw.split(",")) {
    const p = part.trim();
    if (!p) continue;
    const eq = p.indexOf("=");
    if (eq < 1) continue;
    out[p.slice(0, eq).trim()] = p.slice(eq + 1).trim();
  }
  return out;
}

/** Split a raw space-separated args string into tokens. */
export function parseArgs(raw: string): string[] {
  const t = raw.trim();
  return t ? t.split(/\s+/).filter(Boolean) : [];
}

/**
 * Build an McpServerConfig from a filled add-form, or undefined when a required
 * field (command for stdio, url for remote) is missing. Name is validated by
 * the caller since it is a config-file key, not part of the value.
 */
export function buildServerConfig(form: AddServerForm): McpServerConfig | undefined {
  if (form.transport === "stdio") {
    const command = form.command.trim();
    if (!command) return undefined;
    const config: McpServerConfig = { command };
    const args = parseArgs(form.args);
    if (args.length) config.args = args;
    const env = parseKvPairs(form.env);
    if (Object.keys(env).length) config.env = env;
    return config;
  }
  const url = form.url.trim();
  if (!url) return undefined;
  const config: McpServerConfig = { type: form.transport, url };
  const headers = parseKvPairs(form.headers);
  if (Object.keys(headers).length) config.headers = headers;
  return config;
}

/** Sliding window so the cursor stays visible in long lists. */
export function windowSlice(
  total: number,
  cursor: number,
  maxVisible: number,
): { start: number; end: number; hasUp: boolean; hasDown: boolean } {
  if (total <= maxVisible) return { start: 0, end: total, hasUp: false, hasDown: false };
  let start = Math.max(0, cursor - Math.floor(maxVisible / 2));
  start = Math.min(start, total - maxVisible);
  const end = start + maxVisible;
  return { start, end, hasUp: start > 0, hasDown: end < total };
}

// ── BasePanel (per §3; kept local — no cross-extension coupling) ─────────────

export abstract class BasePanel implements Component {
  requestRender?: () => void;
  protected filter = "";
  protected filterMode = false;
  protected cursor = 0;

  constructor(protected readonly theme: PanelTheme) {}

  invalidate(): void {
    /* nothing cached across theme changes */
  }

  abstract render(width: number): string[];
  abstract handleInput(data: string): void;

  // ── border utilities (mirrors plugin-loader/src/panel.ts) ─────────────────
  protected titledTop(title: string, w: number): string {
    const label = ` ${title} `;
    const dashes = Math.max(0, w - 1 - visibleWidth(label));
    return this.theme.fg("border", `╭─${label}${"─".repeat(dashes)}╮`);
  }
  protected sep(w: number): string {
    return this.theme.fg("border", `├${"─".repeat(w)}┤`);
  }
  protected bottom(w: number): string {
    return this.theme.fg("border", `╰${"─".repeat(w)}╯`);
  }
  protected row(content: string, w: number): string {
    const t = truncateToWidth(content, w, "…", true);
    const pad = " ".repeat(Math.max(0, w - visibleWidth(t)));
    return this.theme.fg("border", "│") + t + pad + this.theme.fg("border", "│");
  }
  /** left + right-aligned trailing text within width w. */
  protected pad2(left: string, right: string, w: number): string {
    const gap = Math.max(1, w - visibleWidth(left) - visibleWidth(right));
    return left + " ".repeat(gap) + right;
  }

  /**
   * Shared list-view key handling. Returns true if the key was consumed.
   * In filterMode printable keys append to the filter; otherwise ↑↓ move and
   * Enter fires onEnter. `/` toggles into filterMode.
   */
  protected handleListKeys(data: string, len: number, onEnter: () => void): boolean {
    if (this.filterMode) {
      if (matchesKey(data, "escape") || matchesKey(data, "return")) {
        this.filterMode = false;
        this.requestRender?.();
        return true;
      }
      if (matchesKey(data, "backspace")) {
        this.filter = this.filter.slice(0, -1);
        this.cursor = 0;
        this.requestRender?.();
        return true;
      }
      if (isPrintable(data)) {
        this.filter += data;
        this.cursor = 0;
        this.requestRender?.();
        return true;
      }
      return true; // swallow everything else while filtering
    }
    if (matchesKey(data, "/")) {
      this.filterMode = true;
      this.requestRender?.();
      return true;
    }
    if (matchesKey(data, "up")) {
      this.cursor = Math.max(0, this.cursor - 1);
      this.requestRender?.();
      return true;
    }
    if (matchesKey(data, "down")) {
      this.cursor = Math.min(Math.max(0, len - 1), this.cursor + 1);
      this.requestRender?.();
      return true;
    }
    if (matchesKey(data, "return")) {
      onEnter();
      return true;
    }
    return false;
  }
}

interface MenuAction {
  label: string;
  run: () => void;
  danger?: boolean;
}

type AddFieldKey = "name" | "command" | "args" | "env" | "url" | "headers";

type AddRow =
  | { kind: "type" }
  | { kind: "scope" }
  | { kind: "field"; key: AddFieldKey; label: string }
  | { kind: "submit" };

// ── McpPanel ─────────────────────────────────────────────────────────────────

export class McpPanel extends BasePanel {
  private view: McpView = { kind: "list" };
  private status?: string;
  private servers: McpServerRow[] = [];
  private paths = { projectPath: "", globalPath: "" };
  private addForm?: AddServerForm;
  /** Guards against re-entrant reconnect while a connect is in-flight (§2.6). */
  private inFlight = new Set<string>();
  /** Tests await this to observe the result of the last async op. */
  lastOp?: Promise<void>;

  constructor(
    theme: PanelTheme,
    private readonly deps: McpPanelDeps,
    private readonly done: () => void,
  ) {
    super(theme);
    this.reload();
  }

  private reload(): void {
    try {
      this.servers = sortServers(this.deps.listServers());
    } catch {
      this.servers = [];
    }
    try {
      this.paths = this.deps.configPaths();
    } catch {
      this.paths = { projectPath: "", globalPath: "" };
    }
  }

  private rowFor(id: string): McpServerRow | undefined {
    return this.servers.find((s) => s.id === id);
  }

  private configPathFor(source: ServerSource): string {
    if (source === "project") return this.paths.projectPath;
    if (source === "global") return this.paths.globalPath;
    return "(from plugins)";
  }

  // ── test/introspection helpers ────────────────────────────────────────────
  snapshot(): {
    view: McpView;
    cursor: number;
    filter: string;
    filterMode: boolean;
    status?: string;
    addForm?: AddServerForm;
    inFlight: string[];
  } {
    return {
      view: this.view,
      cursor: this.cursor,
      filter: this.filter,
      filterMode: this.filterMode,
      status: this.status,
      addForm: this.addForm ? { ...this.addForm } : undefined,
      inFlight: [...this.inFlight],
    };
  }

  // ── data views ──────────────────────────────────────────────────────────
  private visibleServers(): McpServerRow[] {
    return filterServers(this.servers, this.filter);
  }
  private visibleTools(id: string): McpToolDef[] {
    let tools: McpToolDef[] = [];
    try {
      tools = this.deps.toolsFor(id);
    } catch {
      tools = [];
    }
    return filterTools(tools, this.filter);
  }

  private toList(): void {
    this.view = { kind: "list" };
    this.cursor = 0;
    this.filter = "";
    this.filterMode = false;
    this.requestRender?.();
  }

  // ── input routing ─────────────────────────────────────────────────────────
  handleInput(data: string): void {
    if (matchesKey(data, "ctrl+c")) {
      this.done();
      return;
    }
    switch (this.view.kind) {
      case "list":
        this.handleListView(data);
        return;
      case "server":
        this.handleMenuView(data, this.serverActions(), () => this.toList());
        return;
      case "tools":
        this.handleToolsView(data);
        return;
      case "tool":
        this.handleToolDetail(data);
        return;
      case "add":
        this.handleAddView(data);
        return;
      case "confirm-remove":
        this.handleMenuView(data, this.removeActions(), () => this.cancelRemove());
        return;
    }
  }

  private handleListView(data: string): void {
    if (!this.filterMode && matchesKey(data, "escape")) {
      this.done();
      return;
    }
    const rows = this.visibleServers();
    const current = rows[this.cursor];
    if (!this.filterMode) {
      if (matchesKey(data, "a")) {
        this.openAdd();
        return;
      }
      if (current && matchesKey(data, "r")) {
        this.reconnectServer(current.id);
        return;
      }
      if (current && matchesKey(data, "x")) {
        this.view = { kind: "confirm-remove", id: current.id };
        this.cursor = 0;
        this.requestRender?.();
        return;
      }
    }
    this.handleListKeys(data, rows.length, () => {
      if (current) {
        this.view = { kind: "server", id: current.id };
        this.cursor = 0;
        this.requestRender?.();
      }
    });
  }

  // ── generic vertical menu (server detail / remove confirm) ────────────────
  private handleMenuView(data: string, actions: MenuAction[], onEscape: () => void): void {
    if (matchesKey(data, "escape")) {
      onEscape();
      return;
    }
    if (matchesKey(data, "up")) {
      this.cursor = Math.max(0, this.cursor - 1);
      this.requestRender?.();
      return;
    }
    if (matchesKey(data, "down")) {
      this.cursor = Math.min(Math.max(0, actions.length - 1), this.cursor + 1);
      this.requestRender?.();
      return;
    }
    if (matchesKey(data, "return")) {
      actions[this.cursor]?.run();
    }
  }

  private serverActions(): MenuAction[] {
    if (this.view.kind !== "server") return [];
    const id = this.view.id;
    const row = this.rowFor(id);
    const n = row?.toolCount ?? 0;
    return [
      {
        label: `View tools (${n}) →`,
        run: () => {
          if (n > 0) {
            this.view = { kind: "tools", id };
            this.cursor = 0;
            this.filter = "";
            this.filterMode = false;
            this.requestRender?.();
          } else {
            this.status = this.theme.fg("dim", "No tools — reconnect first.");
            this.requestRender?.();
          }
        },
      },
      { label: "Reconnect", run: () => this.reconnectServer(id) },
      {
        label: "Remove server",
        danger: true,
        run: () => {
          this.view = { kind: "confirm-remove", id };
          this.cursor = 0;
          this.requestRender?.();
        },
      },
      { label: "Back to list", run: () => this.toList() },
    ];
  }

  private removeActions(): MenuAction[] {
    if (this.view.kind !== "confirm-remove") return [];
    const id = this.view.id;
    return [
      { label: "Remove", danger: true, run: () => this.removeServer(id) },
      { label: "Cancel", run: () => this.cancelRemove() },
    ];
  }

  private cancelRemove(): void {
    if (this.view.kind !== "confirm-remove") {
      this.toList();
      return;
    }
    const id = this.view.id;
    if (this.rowFor(id)) {
      this.view = { kind: "server", id };
      this.cursor = 0;
      this.requestRender?.();
    } else {
      this.toList();
    }
  }

  private removeServer(id: string): void {
    try {
      const res = this.deps.removeServer(id);
      this.status = this.theme.fg("dim", res.message);
    } catch (error) {
      this.status = this.theme.fg("error", error instanceof Error ? error.message : String(error));
    }
    this.view = { kind: "list" };
    this.cursor = 0;
    this.reload();
    this.requestRender?.();
  }

  private reconnectServer(id: string): void {
    if (this.inFlight.has(id)) return;
    const label = this.rowFor(id)?.rawName ?? id;
    this.inFlight.add(id);
    this.status = this.theme.fg("warning", `… reconnecting ${label}`);
    this.requestRender?.();
    this.lastOp = (async () => {
      try {
        await this.deps.reconnect(id);
        const after = this.deps.listServers().find((s) => s.id === id);
        if (after?.status === "connected") this.status = this.theme.fg("success", `✔ reconnected ${label}`);
        else if (after?.status === "error") this.status = this.theme.fg("error", `✗ ${label}: ${after.error ?? "failed"}`);
        else this.status = this.theme.fg("dim", `${label} disconnected`);
      } catch (error) {
        this.status = this.theme.fg("error", error instanceof Error ? error.message : String(error));
      } finally {
        this.inFlight.delete(id);
        this.reload();
        this.requestRender?.();
      }
    })();
  }

  // ── tool views ────────────────────────────────────────────────────────────
  private handleToolsView(data: string): void {
    if (this.view.kind !== "tools") return;
    const id = this.view.id;
    if (!this.filterMode && matchesKey(data, "escape")) {
      this.view = { kind: "server", id };
      this.cursor = 0;
      this.filter = "";
      this.requestRender?.();
      return;
    }
    const tools = this.visibleTools(id);
    const current = tools[this.cursor];
    this.handleListKeys(data, tools.length, () => {
      if (current) {
        this.view = { kind: "tool", id, tool: current.name };
        this.cursor = 0;
        this.requestRender?.();
      }
    });
  }

  private handleToolDetail(data: string): void {
    if (this.view.kind !== "tool") return;
    if (matchesKey(data, "escape")) {
      this.view = { kind: "tools", id: this.view.id };
      this.cursor = 0;
      this.filter = "";
      this.requestRender?.();
    }
  }

  // ── add-server form ─────────────────────────────────────────────────────────
  private openAdd(): void {
    this.addForm = {
      transport: "stdio",
      scope: "project",
      name: "",
      command: "",
      args: "",
      env: "",
      url: "",
      headers: "",
    };
    this.view = { kind: "add" };
    this.cursor = 2; // land on the Name field (rows 0/1 are toggles)
    this.requestRender?.();
  }

  private addFormRows(form: AddServerForm): AddRow[] {
    const rows: AddRow[] = [{ kind: "type" }, { kind: "scope" }, { kind: "field", key: "name", label: "Name" }];
    if (form.transport === "stdio") {
      rows.push({ kind: "field", key: "command", label: "Command" });
      rows.push({ kind: "field", key: "args", label: "Args" });
      rows.push({ kind: "field", key: "env", label: "Env" });
    } else {
      rows.push({ kind: "field", key: "url", label: "URL" });
      rows.push({ kind: "field", key: "headers", label: "Headers" });
    }
    rows.push({ kind: "submit" });
    return rows;
  }

  private handleAddView(data: string): void {
    const form = this.addForm;
    if (!form) {
      this.toList();
      return;
    }
    if (matchesKey(data, "escape")) {
      this.addForm = undefined;
      this.toList();
      return;
    }
    const rows = this.addFormRows(form);
    this.cursor = Math.min(this.cursor, rows.length - 1);
    const cur = rows[this.cursor]!;
    if (matchesKey(data, "up")) {
      this.cursor = Math.max(0, this.cursor - 1);
      this.requestRender?.();
      return;
    }
    if (matchesKey(data, "down")) {
      this.cursor = Math.min(rows.length - 1, this.cursor + 1);
      this.requestRender?.();
      return;
    }
    if (matchesKey(data, "left") || matchesKey(data, "right")) {
      const dir = matchesKey(data, "left") ? -1 : 1;
      if (cur.kind === "type") {
        const idx = TRANSPORTS.indexOf(form.transport);
        form.transport = TRANSPORTS[(idx + dir + TRANSPORTS.length) % TRANSPORTS.length]!;
        this.cursor = Math.min(this.cursor, this.addFormRows(form).length - 1);
      } else if (cur.kind === "scope") {
        form.scope = form.scope === "project" ? "global" : "project";
      }
      this.requestRender?.();
      return;
    }
    if (matchesKey(data, "return")) {
      if (cur.kind === "submit") {
        this.submitAdd();
        return;
      }
      this.cursor = Math.min(rows.length - 1, this.cursor + 1);
      this.requestRender?.();
      return;
    }
    if (cur.kind === "field") {
      if (matchesKey(data, "backspace")) {
        form[cur.key] = form[cur.key].slice(0, -1);
        this.requestRender?.();
        return;
      }
      if (isPrintable(data)) {
        form[cur.key] += data;
        this.requestRender?.();
      }
    }
  }

  private submitAdd(): void {
    const form = this.addForm;
    if (!form) return;
    const name = form.name.trim();
    const config = buildServerConfig(form);
    if (!name || !config) {
      this.status = this.theme.fg(
        "error",
        form.transport === "stdio" ? "Name and Command are required." : "Name and URL are required.",
      );
      this.requestRender?.();
      return;
    }
    const scope = form.scope;
    this.status = this.theme.fg("warning", `… adding ${name}`);
    this.requestRender?.();
    this.lastOp = (async () => {
      try {
        const res = await this.deps.addServer({ name, scope, config });
        if (res.status === "connected") this.status = this.theme.fg("success", `✔ added ${name}`);
        else this.status = this.theme.fg("warning", `added ${name} (${res.status}${res.error ? `: ${res.error}` : ""})`);
      } catch (error) {
        this.status = this.theme.fg("error", error instanceof Error ? error.message : String(error));
      } finally {
        this.addForm = undefined;
        this.view = { kind: "list" };
        this.cursor = 0;
        this.reload();
        this.requestRender?.();
      }
    })();
  }

  // ── rendering ────────────────────────────────────────────────────────────
  render(width: number): string[] {
    const w = Math.max(48, Math.floor(width) - 2);
    switch (this.view.kind) {
      case "list":
        return this.renderList(w);
      case "server":
        return this.renderServer(w);
      case "tools":
        return this.renderTools(w);
      case "tool":
        return this.renderToolDetail(w);
      case "add":
        return this.renderAdd(w);
      case "confirm-remove":
        return this.renderConfirmRemove(w);
    }
  }

  private statusOrHint(hint: string, w: number): string {
    if (this.status) return this.row(` ${this.status}`, w);
    return this.row(this.theme.fg("dim", ` ${hint}`), w);
  }

  private filterLine(w: number): string {
    const text = this.filterMode
      ? `${this.theme.fg("accent", " / filter: ")}${this.filter}▏`
      : this.filter
        ? `${this.theme.fg("dim", " / filter: ")}${this.filter}`
        : this.theme.fg("dim", " / to filter");
    return this.row(text, w);
  }

  private renderList(w: number): string[] {
    const rows = this.visibleServers();
    const connected = this.servers.filter((s) => s.status === "connected").length;
    const lines: string[] = [this.titledTop("MCP servers", w)];
    lines.push(this.row(this.theme.fg("dim", ` ${this.servers.length} servers · ${connected} connected`), w));
    lines.push(this.sep(w));
    lines.push(this.filterLine(w));
    if (rows.length === 0) {
      lines.push(this.row(this.theme.fg("dim", "  No MCP servers. Press a to add one."), w));
    } else {
      const { start, end, hasUp, hasDown } = windowSlice(rows.length, this.cursor, MAX_VISIBLE);
      if (hasUp) lines.push(this.row(this.theme.fg("dim", "  ↑ more"), w));
      let lastSource: string | undefined;
      for (let i = start; i < end; i++) {
        const row = rows[i]!;
        if (row.source !== lastSource) {
          const header = `${row.source}  (${this.configPathFor(row.source)})`;
          lines.push(this.row(this.theme.fg("dim", ` ${header}`), w));
          lastSource = row.source;
        }
        lines.push(this.row(this.serverRowText(row, i === this.cursor, w), w));
      }
      if (hasDown) lines.push(this.row(this.theme.fg("dim", "  ↓ more"), w));
    }
    lines.push(this.sep(w));
    lines.push(this.statusOrHint("↑↓ move · Enter detail · r reconnect · a add · x remove · / filter · Esc close", w));
    lines.push(this.bottom(w));
    return lines;
  }

  private serverRowText(row: McpServerRow, selected: boolean, w: number): string {
    const marker = selected ? this.theme.fg("accent", "❯") : " ";
    const connecting = this.inFlight.has(row.id);
    const s = statusIcon(row.status, connecting);
    const icon = this.theme.fg(s.color, s.icon);
    let stateText = `${icon} ${s.word}`;
    if (row.status === "error" && !connecting && row.error) stateText = `${icon} error: ${row.error}`;
    const detail =
      row.status === "connected" && row.toolCount > 0 ? this.theme.fg("dim", `${row.toolCount} tools`) : "";
    const left = `${marker} ${row.rawName.padEnd(14)} ${row.transport.padEnd(6)} ${stateText}`;
    return this.pad2(left, detail, w - 1);
  }

  private renderServer(w: number): string[] {
    if (this.view.kind !== "server") return [];
    const row = this.rowFor(this.view.id);
    if (!row) return this.renderList(w);
    const connecting = this.inFlight.has(row.id);
    const s = statusIcon(row.status, connecting);
    const lines: string[] = [this.titledTop(`MCP · ${row.rawName}`, w)];
    lines.push(
      this.row(
        this.pad2(` Status:  ${this.theme.fg(s.color, `${s.icon} ${s.word}`)}`, this.theme.fg("dim", `source: ${row.source}`), w - 1),
        w,
      ),
    );
    lines.push(this.row(` Type:    ${row.transport}`, w));
    if (row.transport === "stdio") {
      lines.push(this.row(` Command: ${row.command ?? ""}`, w));
      lines.push(this.row(` Args:    ${(row.args ?? []).join(" ")}`, w));
      lines.push(this.row(` Env:     ${maskSecrets(row.env)}`, w));
    } else {
      lines.push(this.row(` URL:     ${row.url ?? ""}`, w));
      lines.push(this.row(` Headers: ${maskSecrets(row.headers)}`, w));
      lines.push(this.row(this.theme.fg("dim", ` Auth:    — (not supported)`), w));
    }
    lines.push(this.row(` Config:  ${this.configPathFor(row.source)}`, w));
    lines.push(this.row(` Tools:   ${row.toolCount}`, w));
    if (row.status === "error" && row.error) {
      lines.push(this.row(this.theme.fg("error", ` Error: ${row.error}`), w));
      lines.push(this.row(this.theme.fg("dim", " Reconnect to retry."), w));
    }
    lines.push(this.sep(w));
    const actions = this.serverActions();
    actions.forEach((a, i) => lines.push(this.row(this.menuRow(a, i === this.cursor), w)));
    lines.push(this.sep(w));
    lines.push(this.statusOrHint("↑↓ move · Enter run · Esc back", w));
    lines.push(this.bottom(w));
    return lines;
  }

  private renderTools(w: number): string[] {
    if (this.view.kind !== "tools") return [];
    const id = this.view.id;
    const row = this.rowFor(id);
    const tools = this.visibleTools(id);
    const lines: string[] = [this.titledTop(`${row?.rawName ?? id} · tools`, w)];
    lines.push(this.row(this.theme.fg("dim", ` ${tools.length} tools`), w));
    lines.push(this.sep(w));
    lines.push(this.filterLine(w));
    if (tools.length === 0) {
      lines.push(this.row(this.theme.fg("dim", "  No tools."), w));
    } else {
      const { start, end, hasUp, hasDown } = windowSlice(tools.length, this.cursor, MAX_VISIBLE);
      if (hasUp) lines.push(this.row(this.theme.fg("dim", "  ↑ more"), w));
      for (let i = start; i < end; i++) {
        const tool = tools[i]!;
        const marker = i === this.cursor ? this.theme.fg("accent", "❯") : " ";
        const annotation = toolAnnotation(tool);
        const badge = annotation ? ` ${this.theme.fg(annotation.color, `[${annotation.label}]`)}` : "";
        const desc = tool.description ? this.theme.fg("dim", `  ${tool.description}`) : "";
        lines.push(this.row(`${marker} ${tool.name}${badge}${desc}`, w));
      }
      if (hasDown) lines.push(this.row(this.theme.fg("dim", "  ↓ more"), w));
    }
    lines.push(this.sep(w));
    lines.push(this.statusOrHint("↑↓ move · Enter detail · / filter · Esc back", w));
    lines.push(this.bottom(w));
    return lines;
  }

  private renderToolDetail(w: number): string[] {
    if (this.view.kind !== "tool") return [];
    const { id, tool } = this.view;
    const row = this.rowFor(id);
    const def = this.deps.toolsFor(id).find((t) => t.name === tool);
    const lines: string[] = [this.titledTop(`${row?.rawName ?? id} · ${tool}`, w)];
    lines.push(this.row(` Tool: ${tool}`, w));
    lines.push(this.row(this.theme.fg("dim", ` Full: ${fullToolName(id, tool)}`), w));
    const annotation = def ? toolAnnotation(def) : undefined;
    if (annotation) lines.push(this.row(` ${this.theme.fg(annotation.color, `[${annotation.label}]`)}`, w));
    lines.push(this.row("", w));
    if (def?.description) lines.push(this.row(` ${def.description}`, w));
    lines.push(this.row("", w));
    const params = extractToolParams(def?.inputSchema);
    lines.push(this.row(" Parameters:", w));
    if (params.length === 0) {
      lines.push(this.row(this.theme.fg("dim", "  (no parameters)"), w));
    } else {
      for (const p of params) {
        const req = p.required ? this.theme.fg("warning", " (required)") : "";
        const desc = p.description ? this.theme.fg("dim", `  — ${p.description}`) : "";
        lines.push(this.row(`  • ${p.name}${req}  ${p.type}${desc}`, w));
      }
    }
    lines.push(this.sep(w));
    lines.push(this.statusOrHint("Esc back", w));
    lines.push(this.bottom(w));
    return lines;
  }

  private renderAdd(w: number): string[] {
    const form = this.addForm;
    if (!form) return [this.titledTop("Add MCP server", w), this.bottom(w)];
    const rows = this.addFormRows(form);
    const lines: string[] = [this.titledTop("Add MCP server", w)];
    rows.forEach((r, i) => {
      const selected = i === this.cursor;
      const marker = selected ? this.theme.fg("accent", "❯") : " ";
      if (r.kind === "type") {
        const parts = TRANSPORTS.map((t) => (t === form.transport ? this.theme.inverse(` ${t} `) : `  ${t}  `)).join(" ");
        lines.push(this.row(`${marker} Type:   ${parts}   ${this.theme.fg("dim", "(←→ change)")}`, w));
      } else if (r.kind === "scope") {
        const parts = (["project", "global"] as Scope[])
          .map((sc) => (sc === form.scope ? this.theme.inverse(` ${sc} `) : `  ${sc}  `))
          .join(" ");
        lines.push(this.row(`${marker} Scope:  ${parts}   ${this.theme.fg("dim", "(←→ change)")}`, w));
        lines.push(this.sep(w));
      } else if (r.kind === "field") {
        const value = form[r.key];
        const shown = selected ? `${value}▏` : value;
        const hint = r.key === "env" || r.key === "headers" ? this.theme.fg("dim", "  (k=v, comma-separated)") : "";
        lines.push(this.row(`${marker} ${r.label.padEnd(8)} ${this.theme.fg("accent", "›")} ${shown}${hint}`, w));
      } else {
        lines.push(this.sep(w));
        lines.push(this.row(`${marker} ${selected ? this.theme.inverse(" Save & connect ") : "[ Save & connect ]"}`, w));
      }
    });
    lines.push(this.sep(w));
    lines.push(this.statusOrHint("↑↓ field · ←→ type/scope · Enter edit/submit · Esc cancel", w));
    lines.push(this.bottom(w));
    return lines;
  }

  private renderConfirmRemove(w: number): string[] {
    if (this.view.kind !== "confirm-remove") return [];
    const row = this.rowFor(this.view.id);
    const name = row?.rawName ?? this.view.id;
    const lines: string[] = [this.titledTop(`Remove MCP server "${name}"?`, w)];
    if (row?.source === "runtime") {
      lines.push(
        this.row(this.theme.fg("warning", " source: runtime (plugin) → removed from memory only; disable via /plugin"), w),
      );
    } else {
      const path = this.configPathFor(row?.source ?? "project");
      lines.push(this.row(this.theme.fg("dim", ` source: ${row?.source ?? "project"} → deletes from ${path}`), w));
    }
    lines.push(this.row(this.theme.fg("dim", " Transport closes now; its tools stay registered until restart"), w));
    lines.push(this.row(this.theme.fg("dim", " (pi cannot unregister tools)."), w));
    lines.push(this.sep(w));
    const actions = this.removeActions();
    actions.forEach((a, i) => lines.push(this.row(this.menuRow(a, i === this.cursor), w)));
    lines.push(this.sep(w));
    lines.push(this.statusOrHint("Enter confirm · Esc cancel", w));
    lines.push(this.bottom(w));
    return lines;
  }

  private menuRow(action: MenuAction, selected: boolean): string {
    const marker = selected ? this.theme.fg("accent", "❯") : " ";
    const label = action.danger ? this.theme.fg("error", action.label) : action.label;
    const suffix = action.danger ? this.theme.fg("dim", "  (danger)") : "";
    return `${marker} ${label}${suffix}`;
  }
}
