// PluginPanel — a Claude-Code-style capturing overlay for /plugin.
//
// This is a pure UI/state-machine module: every side effect (manager calls,
// disk writes, toggle persistence) is injected via `PluginPanelDeps`, so the
// whole view state machine, key routing, row formatting and filtering are
// unit-testable without pi, fs, or a real terminal.
//
// Screens implemented (see ft_local/plugin_mcp_tui_alignment.md §1.4):
//   P1 Installed tab · P2 Available tab (multi-select) · P3 plugin details +
//   action menu · P4 install trust+scope · P5 Marketplaces tab · P5b market
//   details · P6 add-marketplace input · P7 uninstall confirm · P8 configure.
//
// Wiring contract (index.ts): open with ctx.ui.custom(factory,{overlay:true}),
// set panel.requestRender = () => tui.requestRender(), and feed every key via
// tui.addInputListener(data => { panel.handleInput(data); return {consume:true} }).
// NEVER nonCapturing — the overlay must own the keyboard.

import { matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { PluginScope } from "./manager.js";

/** Loosely-typed theme surface (a real pi Theme satisfies this). */
export interface PanelTheme {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
  bold(text: string): string;
  inverse(text: string): string;
}

export type ComponentCounts = Record<string, number | boolean>;

/** One installed / directory plugin row (from index.ts formatList(false)). */
export interface PluginRow {
  id: string;
  name: string;
  version: string;
  scope: string; // "user" | "project" | "local" | "directory"
  marketplace?: string;
  enabled: boolean;
  path?: string;
  source?: string;
}

/** One available (marketplace) plugin row (manager.listAvailable()). */
export interface AvailableRow {
  id: string;
  name: string;
  marketplace: string;
  version: string;
  description?: string;
  source: string;
  installed: boolean;
}

/** One marketplace row (manager.listMarketplaces() + availability counts). */
export interface MarketplaceRow {
  name: string;
  source: string;
  path: string;
  updatedAt: string;
  scope: string;
  available: number;
  installed: number;
}

/**
 * Everything the panel needs from the outside. All mutating ops may throw;
 * the panel catches and shows the message in its status line. `defer` lets the
 * blocking-install workaround flush a frame first (tests inject a sync defer).
 */
export interface PluginPanelDeps {
  listInstalled(): PluginRow[];
  listAvailable(): AvailableRow[];
  listMarketplaces(): MarketplaceRow[];
  componentsFor(id: string): ComponentCounts;
  manifestFor(id: string): Record<string, unknown> | undefined;
  setEnabled(id: string, on: boolean, scope?: PluginScope): void;
  install(id: string, scope: PluginScope, userConfig?: Record<string, unknown>): void;
  uninstall(id: string, scope: PluginScope, opts: { keepData?: boolean }): void;
  update(id: string, scope: PluginScope): void;
  configure(id: string, values: Record<string, unknown>, scope?: PluginScope): void;
  addMarketplace(source: string, scope: PluginScope): void;
  removeMarketplace(name: string, scope?: PluginScope): void;
  updateMarketplace(name: string): void;
  defer?(cb: () => void): void;
}

export type Tab = "installed" | "available" | "marketplaces";

export type View =
  | { kind: "list"; tab: Tab }
  | { kind: "plugin-details"; id: string; scope: string }
  | { kind: "install"; ids: string[] }
  | { kind: "mkt-details"; name: string }
  | { kind: "add-mkt" }
  | { kind: "confirm-uninstall"; id: string; scope: string }
  | { kind: "configure"; id: string; scope: string };

interface ConfigField {
  key: string;
  description?: string;
  required: boolean;
  secret: boolean;
  freeform?: boolean;
}

const MAX_VISIBLE = 10;
const SCOPE_RANK: Record<string, number> = { user: 0, project: 1, local: 2, directory: 3 };

// ── pure helpers (exported for tests) ────────────────────────────────────────

/** Case-insensitive substring match over a row's searchable fields. */
export function matchesFilter(fields: Array<string | undefined>, filter: string): boolean {
  const q = filter.trim().toLowerCase();
  if (!q) return true;
  // `@mkt` scopes the match to the marketplace field (used by Browse).
  if (q.startsWith("@")) {
    const want = q.slice(1);
    return (fields[1] ?? "").toLowerCase().includes(want);
  }
  return fields.some((f) => (f ?? "").toLowerCase().includes(q));
}

export function filterInstalled(rows: PluginRow[], filter: string): PluginRow[] {
  return rows.filter((r) => matchesFilter([r.name, r.marketplace, r.scope, r.version], filter));
}

export function filterAvailable(rows: AvailableRow[], filter: string): AvailableRow[] {
  return rows.filter((r) => matchesFilter([r.name, r.marketplace, r.description, r.version], filter));
}

/** Stable sort by scope group then name (Installed tab grouping). */
export function sortInstalled(rows: PluginRow[]): PluginRow[] {
  return [...rows].sort(
    (a, b) => (SCOPE_RANK[a.scope] ?? 9) - (SCOPE_RANK[b.scope] ?? 9) || a.name.localeCompare(b.name),
  );
}

export function sortAvailable(rows: AvailableRow[]): AvailableRow[] {
  return [...rows].sort(
    (a, b) => a.marketplace.localeCompare(b.marketplace) || a.name.localeCompare(b.name),
  );
}

/** Compact component badge for list rows, e.g. "cmds·2 skills·1 mcp". */
export function compactComponents(counts: ComponentCounts): string {
  const parts: string[] = [];
  const num = (k: string, label: string) => {
    const v = counts[k];
    if (typeof v === "number" && v > 0) parts.push(`${label}·${v}`);
  };
  num("commands", "cmds");
  num("skills", "skills");
  num("agents", "agents");
  num("outputStyles", "styles");
  if (counts.hooks === true) parts.push("hooks");
  if (counts.mcp === true) parts.push("mcp");
  if (counts.lsp === true) parts.push("lsp");
  return parts.join(" ");
}

/** Verbose component line for the details card. */
export function verboseComponents(counts: ComponentCounts): string {
  const n = (k: string) => (typeof counts[k] === "number" ? (counts[k] as number) : 0);
  const b = (k: string) => (counts[k] === true ? "✓" : "✗");
  return `commands ${n("commands")} · skills ${n("skills")} · agents ${n("agents")} · hooks ${b("hooks")} · mcp ${b("mcp")}`;
}

/** Sliding window over a list so the cursor stays visible. */
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

/** Derive configurable fields from a plugin manifest's `config` object. */
export function configFields(manifest: Record<string, unknown> | undefined): ConfigField[] {
  const cfg = manifest?.config;
  if (!cfg || typeof cfg !== "object") return [];
  return Object.entries(cfg as Record<string, unknown>).map(([key, def]) => {
    const d = def && typeof def === "object" ? (def as Record<string, unknown>) : {};
    return {
      key,
      description: typeof d.description === "string" ? d.description : undefined,
      required: d.required === true,
      secret: d.secret === true || /key|token|secret|password/i.test(key),
    };
  });
}

function isPrintable(data: string): boolean {
  return data.length === 1 && data.charCodeAt(0) >= 32;
}

// ── BasePanel ─────────────────────────────────────────────────────────────

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

  // ── border utilities (mirrors side-overlay.ts) ───────────────────────────
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

// ── PluginPanel ─────────────────────────────────────────────────────────────

export class PluginPanel extends BasePanel {
  private view: View = { kind: "list", tab: "installed" };
  private status?: string;
  /** Set true whenever a toggle/install/uninstall happens → reload hint on close. */
  dirty = false;

  // multi-select on the Available tab
  private selected = new Set<string>();

  // cached snapshots (reloaded after mutations)
  private installed: PluginRow[] = [];
  private available: AvailableRow[] = [];
  private marketplaces: MarketplaceRow[] = [];
  private componentsCache = new Map<string, ComponentCounts>();

  // configure form + add-marketplace input state
  private configForm?: { id: string; scope: string; fields: ConfigField[]; values: Record<string, string>; step: number };
  private inputValue = "";

  constructor(
    theme: PanelTheme,
    private readonly deps: PluginPanelDeps,
    private readonly done: () => void,
  ) {
    super(theme);
    this.reload();
  }

  private reload(): void {
    try {
      this.installed = sortInstalled(this.deps.listInstalled());
    } catch {
      this.installed = [];
    }
    try {
      this.available = sortAvailable(this.deps.listAvailable());
    } catch {
      this.available = [];
    }
    try {
      this.marketplaces = [...this.deps.listMarketplaces()].sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      this.marketplaces = [];
    }
    this.componentsCache.clear();
  }

  private components(id: string): ComponentCounts {
    const cached = this.componentsCache.get(id);
    if (cached) return cached;
    let counts: ComponentCounts = {};
    try {
      counts = this.deps.componentsFor(id);
    } catch {
      counts = {};
    }
    this.componentsCache.set(id, counts);
    return counts;
  }

  // ── test/introspection helpers ────────────────────────────────────────────
  /** Snapshot of internal state (tests assert against this). */
  snapshot(): {
    view: View;
    cursor: number;
    filter: string;
    filterMode: boolean;
    dirty: boolean;
    status?: string;
    selected: string[];
    inputValue: string;
  } {
    return {
      view: this.view,
      cursor: this.cursor,
      filter: this.filter,
      filterMode: this.filterMode,
      dirty: this.dirty,
      status: this.status,
      selected: [...this.selected],
      inputValue: this.inputValue,
    };
  }

  // ── operation helper (blocking-install workaround) ─────────────────────────
  /** Show a status frame, then run a possibly-blocking op deferred, then reload. */
  private perform(pending: string, run: () => void, ok: string): void {
    this.status = pending;
    this.requestRender?.();
    const defer = this.deps.defer ?? ((cb: () => void) => setTimeout(cb, 0));
    defer(() => {
      try {
        run();
        this.status = this.theme.fg("success", ok);
        this.dirty = true;
      } catch (error) {
        this.status = this.theme.fg("error", error instanceof Error ? error.message : String(error));
      }
      this.reload();
      this.requestRender?.();
    });
  }

  // ── data views for the current tab ────────────────────────────────────────
  private visibleInstalled(): PluginRow[] {
    return filterInstalled(this.installed, this.filter);
  }
  private visibleAvailable(): AvailableRow[] {
    return filterAvailable(this.available, this.filter);
  }

  // ── input routing ─────────────────────────────────────────────────────────
  handleInput(data: string): void {
    // Global close: ctrl+c always closes; escape closes only at the list root.
    if (matchesKey(data, "ctrl+c")) {
      this.done();
      return;
    }
    switch (this.view.kind) {
      case "list":
        this.handleListView(data);
        return;
      case "plugin-details":
        this.handleMenuView(data, this.pluginActions());
        return;
      case "install":
        this.handleMenuView(data, this.installActions());
        return;
      case "mkt-details":
        this.handleMenuView(data, this.mktActions());
        return;
      case "confirm-uninstall":
        this.handleMenuView(data, this.uninstallActions());
        return;
      case "add-mkt":
        this.handleAddMkt(data);
        return;
      case "configure":
        this.handleConfigure(data);
        return;
    }
  }

  private toList(tab: Tab): void {
    this.view = { kind: "list", tab };
    this.cursor = 0;
    this.requestRender?.();
  }

  private handleListView(data: string): void {
    if (this.view.kind !== "list") return;
    const tab = this.view.tab;

    // Esc at list root closes (unless filtering — handleListKeys eats it there).
    if (!this.filterMode && matchesKey(data, "escape")) {
      this.done();
      return;
    }
    // Tab / ←→ switch tabs (disabled while filtering).
    if (!this.filterMode && (matchesKey(data, "tab") || matchesKey(data, "right"))) {
      this.cycleTab(1);
      return;
    }
    if (!this.filterMode && matchesKey(data, "left")) {
      this.cycleTab(-1);
      return;
    }
    // `a` adds a marketplace from any tab.
    if (!this.filterMode && matchesKey(data, "a")) {
      this.inputValue = "";
      this.view = { kind: "add-mkt" };
      this.cursor = 0;
      this.requestRender?.();
      return;
    }

    if (tab === "installed") this.handleInstalledTab(data);
    else if (tab === "available") this.handleAvailableTab(data);
    else this.handleMarketplacesTab(data);
  }

  private cycleTab(dir: 1 | -1): void {
    const order: Tab[] = ["installed", "available", "marketplaces"];
    if (this.view.kind !== "list") return;
    const idx = order.indexOf(this.view.tab);
    const next = order[(idx + dir + order.length) % order.length]!;
    this.filter = "";
    this.toList(next);
  }

  private handleInstalledTab(data: string): void {
    const rows = this.visibleInstalled();
    const current = rows[this.cursor];
    if (!this.filterMode) {
      if (matchesKey(data, "space") && current) {
        this.toggle(current);
        return;
      }
      if (matchesKey(data, "u") && current && current.scope !== "directory") {
        this.perform(`Updating ${current.name}…`, () => this.deps.update(current.id, current.scope as PluginScope), `✓ updated ${current.name}`);
        return;
      }
      if ((matchesKey(data, "x") || matchesKey(data, "r")) && current && current.scope !== "directory") {
        this.view = { kind: "confirm-uninstall", id: current.id, scope: current.scope };
        this.cursor = 0;
        this.requestRender?.();
        return;
      }
    }
    this.handleListKeys(data, rows.length, () => {
      if (current) {
        this.view = { kind: "plugin-details", id: current.id, scope: current.scope };
        this.cursor = 0;
        this.requestRender?.();
      }
    });
  }

  private toggle(row: PluginRow): void {
    const on = !row.enabled;
    try {
      this.deps.setEnabled(row.id, on, row.scope === "directory" ? undefined : (row.scope as PluginScope));
      this.dirty = true;
      this.status = on ? this.theme.fg("success", `✓ enabled ${row.name}`) : this.theme.fg("dim", `○ disabled ${row.name}`);
    } catch (error) {
      this.status = this.theme.fg("error", error instanceof Error ? error.message : String(error));
    }
    this.reload();
    this.requestRender?.();
  }

  private handleAvailableTab(data: string): void {
    const rows = this.visibleAvailable();
    const current = rows[this.cursor];
    if (!this.filterMode) {
      if (matchesKey(data, "space") && current && !current.installed) {
        if (this.selected.has(current.id)) this.selected.delete(current.id);
        else this.selected.add(current.id);
        this.requestRender?.();
        return;
      }
      if (matchesKey(data, "i")) {
        const ids = this.selected.size > 0 ? [...this.selected] : current && !current.installed ? [current.id] : [];
        if (ids.length) {
          this.view = { kind: "install", ids };
          this.cursor = 0;
          this.requestRender?.();
        } else {
          this.status = this.theme.fg("dim", "Nothing to install (already installed).");
          this.requestRender?.();
        }
        return;
      }
    }
    this.handleListKeys(data, rows.length, () => {
      if (!current) return;
      if (current.installed) {
        // jump to the Installed tab (Claude parity: "already installed").
        this.filter = "";
        this.toList("installed");
        return;
      }
      this.view = { kind: "install", ids: [current.id] };
      this.cursor = 0;
      this.requestRender?.();
    });
  }

  private handleMarketplacesTab(data: string): void {
    // row 0 is the "+ Add marketplace…" sentinel.
    const total = this.marketplaces.length + 1;
    const mktIndex = this.cursor - 1;
    const current = mktIndex >= 0 ? this.marketplaces[mktIndex] : undefined;
    if (!this.filterMode) {
      if (matchesKey(data, "u") && current) {
        this.perform(`Updating marketplace ${current.name}…`, () => this.deps.updateMarketplace(current.name), `✓ updated ${current.name}`);
        return;
      }
      if ((matchesKey(data, "r") || matchesKey(data, "x")) && current) {
        this.view = { kind: "mkt-details", name: current.name };
        this.cursor = 2; // land on "Remove marketplace"
        this.requestRender?.();
        return;
      }
    }
    this.handleListKeys(data, total, () => {
      if (this.cursor === 0) {
        this.inputValue = "";
        this.view = { kind: "add-mkt" };
        this.cursor = 0;
        this.requestRender?.();
        return;
      }
      if (current) {
        this.view = { kind: "mkt-details", name: current.name };
        this.cursor = 0;
        this.requestRender?.();
      }
    });
  }

  // ── generic menu view (details / install / mkt-details / confirm) ──────────
  private handleMenuView(data: string, actions: Array<{ label: string; run: () => void; danger?: boolean }>): void {
    if (matchesKey(data, "escape")) {
      this.backFromMenu();
      return;
    }
    if (matchesKey(data, "up")) {
      this.cursor = Math.max(0, this.cursor - 1);
      this.requestRender?.();
      return;
    }
    if (matchesKey(data, "down")) {
      this.cursor = Math.min(actions.length - 1, this.cursor + 1);
      this.requestRender?.();
      return;
    }
    if (matchesKey(data, "return")) {
      actions[this.cursor]?.run();
    }
  }

  private backFromMenu(): void {
    switch (this.view.kind) {
      case "plugin-details":
        this.toList("installed");
        return;
      case "install":
        this.toList("available");
        return;
      case "mkt-details":
        this.toList("marketplaces");
        return;
      case "confirm-uninstall":
        // return to the plugin details of the same plugin
        this.view = { kind: "plugin-details", id: this.view.id, scope: this.view.scope };
        this.cursor = 0;
        this.requestRender?.();
        return;
      default:
        this.toList("installed");
    }
  }

  private pluginActions(): Array<{ label: string; run: () => void; danger?: boolean }> {
    if (this.view.kind !== "plugin-details") return [];
    const { id, scope } = this.view;
    const row = this.installed.find((r) => r.id === id);
    const enabled = row?.enabled ?? true;
    const isDirectory = scope === "directory";
    const actions: Array<{ label: string; run: () => void; danger?: boolean }> = [];
    actions.push({
      label: enabled ? "Disable plugin" : "Enable plugin",
      run: () => {
        if (row) this.toggle(row);
        this.toList("installed");
      },
    });
    actions.push({
      label: "Configure options…",
      run: () => this.openConfigure(id, scope),
    });
    if (!isDirectory) {
      actions.push({
        label: "Update now",
        run: () => this.perform(`Updating ${id}…`, () => this.deps.update(id, scope as PluginScope), `✓ updated ${id}`),
      });
      actions.push({
        label: "Uninstall",
        danger: true,
        run: () => {
          this.view = { kind: "confirm-uninstall", id, scope };
          this.cursor = 0;
          this.requestRender?.();
        },
      });
    }
    actions.push({ label: "Back to list", run: () => this.toList("installed") });
    return actions;
  }

  private installActions(): Array<{ label: string; run: () => void }> {
    if (this.view.kind !== "install") return [];
    const ids = this.view.ids;
    const run = (scope: PluginScope) => () =>
      this.perform(
        `Installing ${ids.length > 1 ? `${ids.length} plugins` : ids[0]}…`,
        () => {
          for (const id of ids) this.deps.install(id, scope);
        },
        `✓ installed ${ids.length > 1 ? `${ids.length} plugins` : ids[0]}`,
      );
    return [
      { label: "Install for me (user)", run: () => { this.selected.clear(); run("user")(); this.toList("available"); } },
      { label: "Install for this project (project)", run: () => { this.selected.clear(); run("project")(); this.toList("available"); } },
      { label: "Install in this repo only (local)", run: () => { this.selected.clear(); run("local")(); this.toList("available"); } },
      { label: "Cancel", run: () => this.toList("available") },
    ];
  }

  private mktActions(): Array<{ label: string; run: () => void; danger?: boolean }> {
    if (this.view.kind !== "mkt-details") return [];
    const name = this.view.name;
    const mkt = this.marketplaces.find((m) => m.name === name);
    return [
      {
        label: `Browse plugins (${mkt?.available ?? 0}) →`,
        run: () => {
          this.filter = `@${name}`;
          this.toList("available");
        },
      },
      {
        label: "Update marketplace",
        run: () => this.perform(`Updating marketplace ${name}…`, () => this.deps.updateMarketplace(name), `✓ updated ${name}`),
      },
      {
        label: "Remove marketplace",
        danger: true,
        run: () =>
          this.perform(
            `Removing marketplace ${name}…`,
            () => this.deps.removeMarketplace(name, mkt ? (mkt.scope as PluginScope) : undefined),
            `✓ removed ${name}`,
          ),
      },
      { label: "Back to list", run: () => this.toList("marketplaces") },
    ];
  }

  private uninstallActions(): Array<{ label: string; run: () => void }> {
    if (this.view.kind !== "confirm-uninstall") return [];
    const { id, scope } = this.view;
    const finish = (keepData: boolean) => () => {
      this.perform(`Uninstalling ${id}…`, () => this.deps.uninstall(id, scope as PluginScope, { keepData }), `✓ uninstalled ${id}`);
      this.toList("installed");
    };
    return [
      { label: "Uninstall (delete data)", run: finish(false) },
      { label: "Uninstall (keep data)", run: finish(true) },
      { label: "Cancel", run: () => this.backFromMenu() },
    ];
  }

  // ── add-marketplace input ──────────────────────────────────────────────────
  private handleAddMkt(data: string): void {
    if (matchesKey(data, "escape")) {
      this.toList("marketplaces");
      return;
    }
    if (matchesKey(data, "return")) {
      const source = this.inputValue.trim();
      if (!source) {
        this.toList("marketplaces");
        return;
      }
      this.inputValue = "";
      this.perform(`Adding marketplace ${source}…`, () => this.deps.addMarketplace(source, "user"), `✓ added ${source}`);
      this.toList("marketplaces");
      return;
    }
    if (matchesKey(data, "backspace")) {
      this.inputValue = this.inputValue.slice(0, -1);
      this.requestRender?.();
      return;
    }
    if (isPrintable(data)) {
      this.inputValue += data;
      this.requestRender?.();
    }
  }

  // ── configure form ──────────────────────────────────────────────────────────
  private openConfigure(id: string, scope: string): void {
    const manifest = (() => {
      try {
        return this.deps.manifestFor(id);
      } catch {
        return undefined;
      }
    })();
    let fields = configFields(manifest);
    if (fields.length === 0) {
      // No manifest schema → single free-form "key=value, …" field (§1.7 fallback).
      fields = [{ key: "pairs", description: "key=value pairs, comma-separated", required: false, secret: false, freeform: true }];
    }
    this.configForm = { id, scope, fields, values: {}, step: 0 };
    this.view = { kind: "configure", id, scope };
    this.cursor = 0;
    this.requestRender?.();
  }

  private handleConfigure(data: string): void {
    const form = this.configForm;
    if (!form) {
      this.toList("installed");
      return;
    }
    if (matchesKey(data, "escape")) {
      this.configForm = undefined;
      if (this.view.kind === "configure") this.view = { kind: "plugin-details", id: this.view.id, scope: this.view.scope };
      this.cursor = 0;
      this.requestRender?.();
      return;
    }
    const field = form.fields[form.step]!;
    if (matchesKey(data, "tab")) {
      form.step = (form.step + 1) % form.fields.length;
      this.requestRender?.();
      return;
    }
    if (matchesKey(data, "return")) {
      if (form.step < form.fields.length - 1) {
        form.step += 1;
        this.requestRender?.();
        return;
      }
      this.commitConfigure(form);
      return;
    }
    if (matchesKey(data, "backspace")) {
      form.values[field.key] = (form.values[field.key] ?? "").slice(0, -1);
      this.requestRender?.();
      return;
    }
    if (isPrintable(data)) {
      form.values[field.key] = (form.values[field.key] ?? "") + data;
      this.requestRender?.();
    }
  }

  private commitConfigure(form: NonNullable<PluginPanel["configForm"]>): void {
    const values: Record<string, unknown> = {};
    for (const field of form.fields) {
      const raw = form.values[field.key];
      if (raw === undefined || raw === "") continue;
      if (field.freeform) {
        for (const pair of raw.split(",")) {
          const eq = pair.indexOf("=");
          if (eq < 1) continue;
          values[pair.slice(0, eq).trim()] = coerce(pair.slice(eq + 1).trim());
        }
      } else {
        values[field.key] = coerce(raw);
      }
    }
    const { id, scope } = form;
    this.configForm = undefined;
    if (Object.keys(values).length === 0) {
      this.status = this.theme.fg("dim", "No configuration values entered.");
      this.view = { kind: "plugin-details", id, scope };
      this.cursor = 0;
      this.requestRender?.();
      return;
    }
    this.perform(
      `Configuring ${id}…`,
      () => this.deps.configure(id, values, scope === "directory" ? undefined : (scope as PluginScope)),
      `✓ configured ${id}`,
    );
    this.view = { kind: "plugin-details", id, scope };
    this.cursor = 0;
    this.requestRender?.();
  }

  // ── rendering ────────────────────────────────────────────────────────────
  render(width: number): string[] {
    const w = Math.max(48, Math.floor(width) - 2);
    switch (this.view.kind) {
      case "list":
        return this.renderList(w);
      case "plugin-details":
        return this.renderPluginDetails(w);
      case "install":
        return this.renderInstall(w);
      case "mkt-details":
        return this.renderMktDetails(w);
      case "add-mkt":
        return this.renderAddMkt(w);
      case "confirm-uninstall":
        return this.renderConfirmUninstall(w);
      case "configure":
        return this.renderConfigure(w);
    }
  }

  private tabBar(active: Tab, w: number): string {
    const labels: Array<[Tab, string]> = [
      ["installed", "Installed"],
      ["available", "Available"],
      ["marketplaces", "Marketplaces"],
    ];
    const left = labels
      .map(([t, label]) => (t === active ? this.theme.inverse(` ${label} `) : `  ${label}  `))
      .join(" ");
    const count =
      active === "installed"
        ? `${this.installed.length} plugins`
        : active === "available"
          ? `${this.available.length} available`
          : `${this.marketplaces.length} sources`;
    return ` ${this.pad2(left, this.theme.fg("dim", count), w - 2)}`;
  }

  private statusOrHint(hint: string, w: number): string {
    if (this.status) return this.row(` ${this.status}`, w);
    return this.row(this.theme.fg("dim", ` ${hint}`), w);
  }

  private renderList(w: number): string[] {
    if (this.view.kind !== "list") return [];
    const tab = this.view.tab;
    const lines: string[] = [this.titledTop("Plugins", w)];
    lines.push(this.row(this.tabBar(tab, w), w));
    lines.push(this.sep(w));
    const filterText = this.filterMode
      ? `${this.theme.fg("accent", " / filter: ")}${this.filter}▏`
      : this.filter
        ? `${this.theme.fg("dim", " / filter: ")}${this.filter}`
        : this.theme.fg("dim", " / to filter");
    lines.push(this.row(filterText, w));

    if (tab === "installed") lines.push(...this.renderInstalledBody(w));
    else if (tab === "available") lines.push(...this.renderAvailableBody(w));
    else lines.push(...this.renderMarketplacesBody(w));

    lines.push(this.sep(w));
    const hint =
      tab === "installed"
        ? "↑↓ move · Enter details · Space toggle · u update · x uninstall · / filter · Tab tab · a add · Esc close"
        : tab === "available"
          ? "↑↓ move · Space select · i install · Enter details · / filter · Tab tab · Esc close"
          : "↑↓ move · Enter open · u update · r remove · / filter · Tab tab · a add · Esc close";
    lines.push(this.statusOrHint(hint, w));
    if (this.dirty) lines.push(this.row(this.theme.fg("warning", " ⚠ run /reload to apply changes"), w));
    lines.push(this.bottom(w));
    return lines;
  }

  private renderInstalledBody(w: number): string[] {
    const rows = this.visibleInstalled();
    if (rows.length === 0) return [this.row(this.theme.fg("dim", "  No plugins installed."), w)];
    const { start, end, hasUp, hasDown } = windowSlice(rows.length, this.cursor, MAX_VISIBLE);
    const lines: string[] = [];
    if (hasUp) lines.push(this.row(this.theme.fg("dim", "  ↑ more"), w));
    let lastScope: string | undefined;
    for (let i = start; i < end; i++) {
      const row = rows[i]!;
      if (row.scope !== lastScope) {
        lines.push(this.row(this.theme.fg("dim", ` ${row.scope}`), w));
        lastScope = row.scope;
      }
      lines.push(this.row(this.installedRowText(row, i === this.cursor, w), w));
    }
    if (hasDown) lines.push(this.row(this.theme.fg("dim", "  ↓ more"), w));
    return lines;
  }

  private installedRowText(row: PluginRow, selected: boolean, w: number): string {
    const marker = selected ? this.theme.fg("accent", "❯") : " ";
    const badge = row.enabled ? this.theme.fg("success", "[on]") : this.theme.fg("dim", "[off]");
    const version = row.version ? `v${row.version}` : "—";
    const mkt = row.marketplace ?? (row.scope === "directory" ? "(local dir)" : "");
    const comps = compactComponents(this.components(row.id));
    const left = `${marker} ${row.name}`;
    const mid = `${version}  ${badge}  ${mkt}`;
    const line = `${left.padEnd(18)} ${mid}`;
    return this.pad2(line, this.theme.fg("dim", comps), w - 1);
  }

  private renderAvailableBody(w: number): string[] {
    const rows = this.visibleAvailable();
    if (rows.length === 0) return [this.row(this.theme.fg("dim", "  No plugins available. Press a to add a marketplace."), w)];
    const { start, end, hasUp, hasDown } = windowSlice(rows.length, this.cursor, MAX_VISIBLE);
    const lines: string[] = [];
    if (hasUp) lines.push(this.row(this.theme.fg("dim", "  ↑ more"), w));
    let lastMkt: string | undefined;
    for (let i = start; i < end; i++) {
      const row = rows[i]!;
      if (row.marketplace !== lastMkt) {
        lines.push(this.row(this.theme.fg("dim", ` ${row.marketplace}`), w));
        lastMkt = row.marketplace;
      }
      lines.push(this.row(this.availableRowText(row, i === this.cursor), w));
    }
    if (hasDown) lines.push(this.row(this.theme.fg("dim", "  ↓ more"), w));
    return lines;
  }

  private availableRowText(row: AvailableRow, selected: boolean): string {
    const marker = selected ? this.theme.fg("accent", "❯") : " ";
    const mark = row.installed
      ? this.theme.fg("success", "✓")
      : this.selected.has(row.id)
        ? this.theme.fg("accent", "◉")
        : this.theme.fg("dim", "◯");
    const version = row.version ? `v${row.version}` : "";
    const desc = row.installed ? this.theme.fg("success", "(installed)") : this.theme.fg("dim", row.description ?? "");
    return `${marker} ${mark} ${row.name.padEnd(16)} ${version.padEnd(6)} ${desc}`;
  }

  private renderMarketplacesBody(w: number): string[] {
    const lines: string[] = [];
    const addSel = this.cursor === 0;
    lines.push(this.row(`${addSel ? this.theme.fg("accent", "❯") : " "} ${this.theme.fg("accent", "+  Add marketplace…")}`, w));
    if (this.marketplaces.length === 0) {
      lines.push(this.row(this.theme.fg("dim", "  No marketplaces configured."), w));
      return lines;
    }
    this.marketplaces.forEach((m, i) => {
      const selected = this.cursor === i + 1;
      const marker = selected ? this.theme.fg("accent", "❯") : " ";
      lines.push(this.row(`${marker} ${this.pad2(m.name, this.theme.fg("dim", m.scope), w - 3)}`, w));
      lines.push(this.row(this.theme.fg("dim", `    ${m.source} · ${m.available} available · ${m.installed} installed`), w));
    });
    return lines;
  }

  private renderPluginDetails(w: number): string[] {
    if (this.view.kind !== "plugin-details") return [];
    const { id, scope } = this.view;
    const row = this.installed.find((r) => r.id === id);
    const counts = this.components(id);
    const lines: string[] = [this.titledTop(`Plugin · ${id}`, w)];
    lines.push(this.row(this.pad2(` ${row?.name ?? id}   ${row?.version ? `v${row.version}` : ""}`, this.theme.fg("dim", `Scope: ${scope}`), w - 1), w));
    lines.push(this.row(` Status: ${row?.enabled ?? true ? this.theme.fg("success", "● Enabled") : this.theme.fg("dim", "○ Disabled")}`, w));
    lines.push(this.row(this.theme.fg("dim", ` Components: ${verboseComponents(counts)}`), w));
    lines.push(this.sep(w));
    const actions = this.pluginActions();
    actions.forEach((a, i) => lines.push(this.row(this.menuRow(a, i === this.cursor), w)));
    lines.push(this.sep(w));
    lines.push(this.statusOrHint("↑↓ move · Enter run · Esc back", w));
    lines.push(this.bottom(w));
    return lines;
  }

  private renderInstall(w: number): string[] {
    if (this.view.kind !== "install") return [];
    const ids = this.view.ids;
    const title = ids.length > 1 ? `Install ${ids.length} plugins` : `Install ${ids[0]}`;
    const lines: string[] = [this.titledTop(title, w)];
    if (ids.length === 1) {
      const row = this.available.find((a) => a.id === ids[0]);
      lines.push(this.row(` ${row?.name ?? ids[0]}   ${row?.version ? `v${row.version}` : ""}   from ${row?.marketplace ?? ""}`, w));
      if (row?.description) lines.push(this.row(this.theme.fg("dim", ` ${row.description}`), w));
      const comps = compactComponents(this.components(ids[0]!));
      lines.push(this.row(this.theme.fg("dim", ` Will contribute: ${comps || "components discovered at install"}`), w));
    } else {
      for (const id of ids) lines.push(this.row(` • ${id}`, w));
    }
    lines.push(this.row("", w));
    lines.push(this.row(this.theme.fg("warning", " ⚠ Trust check"), w));
    lines.push(this.row(this.theme.fg("dim", " Plugins can run commands, hooks and MCP servers (third-party"), w));
    lines.push(this.row(this.theme.fg("dim", " code) on your machine. Only install plugins you trust."), w));
    lines.push(this.sep(w));
    const actions = this.installActions();
    actions.forEach((a, i) => lines.push(this.row(this.menuRow(a, i === this.cursor), w)));
    lines.push(this.sep(w));
    lines.push(this.statusOrHint("↑↓ move · Enter confirm · Esc cancel", w));
    lines.push(this.bottom(w));
    return lines;
  }

  private renderMktDetails(w: number): string[] {
    if (this.view.kind !== "mkt-details") return [];
    const name = this.view.name;
    const mkt = this.marketplaces.find((m) => m.name === name);
    const lines: string[] = [this.titledTop(`Marketplace · ${name}`, w)];
    lines.push(this.row(this.pad2(` ${mkt?.source ?? ""}`, this.theme.fg("dim", `scope: ${mkt?.scope ?? ""}`), w - 1), w));
    lines.push(this.row(this.theme.fg("dim", ` ${mkt?.available ?? 0} available · ${mkt?.installed ?? 0} installed`), w));
    lines.push(this.sep(w));
    const actions = this.mktActions();
    actions.forEach((a, i) => lines.push(this.row(this.menuRow(a, i === this.cursor), w)));
    lines.push(this.sep(w));
    lines.push(this.statusOrHint("↑↓ move · Enter run · Esc back", w));
    lines.push(this.bottom(w));
    return lines;
  }

  private renderAddMkt(w: number): string[] {
    const lines: string[] = [this.titledTop("Add marketplace", w)];
    lines.push(this.row(this.theme.fg("dim", " Source: local dir · GitHub owner/repo · git URL"), w));
    lines.push(this.row(this.theme.fg("dim", " Examples: acme/plugins · https://acme.dev/marketplace.json · ./path"), w));
    lines.push(this.row("", w));
    lines.push(this.row(`${this.theme.fg("accent", " › ")}${this.inputValue}▏`, w));
    lines.push(this.sep(w));
    lines.push(this.statusOrHint("Enter add · Esc cancel", w));
    lines.push(this.bottom(w));
    return lines;
  }

  private renderConfirmUninstall(w: number): string[] {
    if (this.view.kind !== "confirm-uninstall") return [];
    const lines: string[] = [this.titledTop(`Uninstall ${this.view.id}?`, w)];
    lines.push(this.row(this.theme.fg("dim", ` Removes the plugin from ${this.view.scope} scope.`), w));
    lines.push(this.row(this.theme.fg("dim", " Its data dir is deleted unless you keep it."), w));
    lines.push(this.sep(w));
    const actions = this.uninstallActions();
    actions.forEach((a, i) => lines.push(this.row(this.menuRow({ ...a, danger: i < 2 && a.label.startsWith("Uninstall") }, i === this.cursor), w)));
    lines.push(this.sep(w));
    lines.push(this.statusOrHint("Enter confirm · Esc cancel", w));
    lines.push(this.bottom(w));
    return lines;
  }

  private renderConfigure(w: number): string[] {
    const form = this.configForm;
    if (!form) return [this.titledTop("Configure", w), this.bottom(w)];
    const field = form.fields[form.step]!;
    const lines: string[] = [this.titledTop(`Configure ${form.id}`, w)];
    lines.push(this.row(this.theme.fg("dim", ` Field ${form.step + 1} / ${form.fields.length}`), w));
    lines.push(this.row(` ${field.key}${field.required ? this.theme.fg("warning", " *") : ""}`, w));
    if (field.description) lines.push(this.row(this.theme.fg("dim", ` ${field.description}`), w));
    const shown = field.secret ? "*".repeat((form.values[field.key] ?? "").length) : form.values[field.key] ?? "";
    lines.push(this.row(`${this.theme.fg("accent", " › ")}${shown}▏`, w));
    lines.push(this.sep(w));
    lines.push(this.statusOrHint("Tab next field · Enter save & next · Esc cancel", w));
    lines.push(this.bottom(w));
    return lines;
  }

  private menuRow(action: { label: string; danger?: boolean }, selected: boolean): string {
    const marker = selected ? this.theme.fg("accent", "❯") : " ";
    const label = action.danger ? this.theme.fg("error", action.label) : action.label;
    const suffix = action.danger ? this.theme.fg("dim", "  (danger)") : "";
    return `${marker} ${label}${suffix}`;
  }
}

/** Coerce a config string value to boolean/number/JSON where obvious. */
function coerce(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  if ((raw.startsWith("{") && raw.endsWith("}")) || (raw.startsWith("[") && raw.endsWith("]"))) {
    try {
      return JSON.parse(raw);
    } catch {
      /* keep string */
    }
  }
  return raw;
}
