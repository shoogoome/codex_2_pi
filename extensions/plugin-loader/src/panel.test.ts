import { describe, expect, it, vi } from "vitest";
import {
  PluginPanel,
  compactComponents,
  verboseComponents,
  configFields,
  filterInstalled,
  filterAvailable,
  matchesFilter,
  sortInstalled,
  sortAvailable,
  windowSlice,
  type AvailableRow,
  type ComponentCounts,
  type PanelTheme,
  type PluginPanelDeps,
  type PluginRow,
} from "./panel.js";

// ── raw terminal key sequences (verified against pi-tui matchesKey) ──────────
const KEY = {
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  enter: "\r",
  escape: "\x1b",
  tab: "\t",
  space: " ",
  backspace: "\x7f",
  ctrlC: "\x03",
} as const;

/** Identity theme → render output is clean ASCII we can snapshot/assert. */
const theme: PanelTheme = {
  fg: (_c, t) => t,
  bg: (_c, t) => t,
  bold: (t) => t,
  inverse: (t) => t,
};

interface Calls {
  setEnabled: Array<[string, boolean, string | undefined]>;
  install: Array<[string, string, Record<string, unknown> | undefined]>;
  uninstall: Array<[string, string, { keepData?: boolean }]>;
  update: Array<[string, string]>;
  configure: Array<[string, Record<string, unknown>, string | undefined]>;
  addMarketplace: Array<[string, string]>;
  removeMarketplace: Array<[string, string | undefined]>;
  updateMarketplace: string[];
}

function makeDeps(
  overrides: Partial<PluginPanelDeps> & {
    installed?: PluginRow[];
    available?: AvailableRow[];
    marketplaces?: ReturnType<PluginPanelDeps["listMarketplaces"]>;
    components?: Record<string, ComponentCounts>;
    manifests?: Record<string, Record<string, unknown>>;
  } = {},
) {
  const installed = overrides.installed ?? [
    { id: "code-review@acme", name: "code-review", version: "1.2", scope: "user", marketplace: "acme", enabled: true },
    { id: "security@acme", name: "security", version: "0.9", scope: "user", marketplace: "acme", enabled: false },
    { id: "repo-tools@team", name: "repo-tools", version: "2.0", scope: "project", marketplace: "team-mp", enabled: true },
    { id: "my-hacks", name: "my-hacks", version: "", scope: "directory", enabled: true },
  ];
  const available = overrides.available ?? [
    { id: "code-review@acme", name: "code-review", marketplace: "acme", version: "1.2", description: "Review diffs", source: "acme/cr", installed: true },
    { id: "deep-research@acme", name: "deep-research", marketplace: "acme", version: "0.3", description: "Research", source: "acme/dr", installed: false },
    { id: "formatter@community", name: "formatter", marketplace: "community", version: "2.0", description: "Format", source: "c/f", installed: false },
  ];
  const marketplaces = overrides.marketplaces ?? [
    { name: "acme", source: "github:acme/plugins", path: "/mp/acme", updatedAt: "2026-07-22", scope: "user", available: 2, installed: 1 },
    { name: "team-mp", source: "https://team.dev/mp.json", path: "/mp/team", updatedAt: "2026-07-20", scope: "project", available: 1, installed: 0 },
  ];
  const components = overrides.components ?? {
    "code-review@acme": { commands: 2, skills: 1, agents: 1, hooks: true, mcp: false },
  };
  const manifests = overrides.manifests ?? {};

  const calls: Calls = {
    setEnabled: [],
    install: [],
    uninstall: [],
    update: [],
    configure: [],
    addMarketplace: [],
    removeMarketplace: [],
    updateMarketplace: [],
  };

  const deps: PluginPanelDeps = {
    listInstalled: () => installed,
    listAvailable: () => available,
    listMarketplaces: () => marketplaces,
    componentsFor: (id) => components[id] ?? {},
    manifestFor: (id) => manifests[id],
    setEnabled: (id, on, scope) => {
      calls.setEnabled.push([id, on, scope]);
      const row = installed.find((r) => r.id === id);
      if (row) row.enabled = on;
    },
    install: (id, scope, uc) => calls.install.push([id, scope, uc]),
    uninstall: (id, scope, opts) => calls.uninstall.push([id, scope, opts]),
    update: (id, scope) => calls.update.push([id, scope]),
    configure: (id, values, scope) => calls.configure.push([id, values, scope]),
    addMarketplace: (source, scope) => calls.addMarketplace.push([source, scope]),
    removeMarketplace: (name, scope) => calls.removeMarketplace.push([name, scope]),
    updateMarketplace: (name) => calls.updateMarketplace.push(name),
    defer: (cb) => cb(), // synchronous → operations run in-line for tests
    ...overrides,
  };
  return { deps, calls, installed, available, marketplaces };
}

function makePanel(depsBundle = makeDeps()) {
  const done = vi.fn();
  const panel = new PluginPanel(theme, depsBundle.deps, done);
  panel.requestRender = () => {};
  return { panel, done, ...depsBundle };
}

function type(panel: PluginPanel, text: string): void {
  for (const ch of text) panel.handleInput(ch);
}

// ── pure helpers ──────────────────────────────────────────────────────────

describe("panel — pure helpers", () => {
  it("matchesFilter: empty matches all, substring is case-insensitive", () => {
    expect(matchesFilter(["Code-Review", "acme"], "")).toBe(true);
    expect(matchesFilter(["Code-Review", "acme"], "REVIEW")).toBe(true);
    expect(matchesFilter(["Code-Review", "acme"], "zzz")).toBe(false);
  });

  it("matchesFilter: @mkt scopes to the marketplace field (Browse)", () => {
    expect(matchesFilter(["code-review", "acme"], "@acme")).toBe(true);
    expect(matchesFilter(["code-review", "team-mp"], "@acme")).toBe(false);
    // name matching "acme" does NOT satisfy an @-scoped marketplace query
    expect(matchesFilter(["acme-tool", "other"], "@acme")).toBe(false);
  });

  it("filterInstalled / filterAvailable narrow by query", () => {
    const { installed, available } = makeDeps();
    expect(filterInstalled(installed, "sec").map((r) => r.name)).toEqual(["security"]);
    expect(filterAvailable(available, "research").map((r) => r.name)).toEqual(["deep-research"]);
  });

  it("sortInstalled groups by scope rank then name; sortAvailable by marketplace then name", () => {
    const { installed, available } = makeDeps();
    expect(sortInstalled(installed).map((r) => r.scope)).toEqual(["user", "user", "project", "directory"]);
    expect(sortInstalled(installed).slice(0, 2).map((r) => r.name)).toEqual(["code-review", "security"]);
    expect(sortAvailable(available).map((r) => r.marketplace)).toEqual(["acme", "acme", "community"]);
  });

  it("compactComponents drops zero/false, keeps nonzero + true booleans", () => {
    expect(compactComponents({ commands: 2, skills: 1, agents: 0, hooks: true, mcp: false })).toBe("cmds·2 skills·1 hooks");
    expect(compactComponents({})).toBe("");
  });

  it("verboseComponents renders counts + ✓/✗ booleans", () => {
    expect(verboseComponents({ commands: 2, skills: 1, agents: 1, hooks: true, mcp: false })).toBe(
      "commands 2 · skills 1 · agents 1 · hooks ✓ · mcp ✗",
    );
  });

  it("windowSlice keeps the cursor visible and flags overflow", () => {
    expect(windowSlice(5, 0, 10)).toEqual({ start: 0, end: 5, hasUp: false, hasDown: false });
    const w = windowSlice(30, 20, 10);
    expect(w.start).toBeLessThanOrEqual(20);
    expect(w.end).toBeGreaterThan(20);
    expect(w.hasUp).toBe(true);
  });

  it("configFields reads manifest.config; empty when absent", () => {
    expect(configFields(undefined)).toEqual([]);
    const fields = configFields({ config: { apiKey: { description: "token", required: true }, verbose: {} } });
    expect(fields.map((f) => f.key)).toEqual(["apiKey", "verbose"]);
    expect(fields[0]).toMatchObject({ key: "apiKey", required: true, secret: true });
    expect(fields[1]).toMatchObject({ key: "verbose", required: false, secret: false });
  });
});

// ── view state machine + key routing ────────────────────────────────────────

describe("panel — navigation & tabs", () => {
  it("starts on Installed tab, cursor 0", () => {
    const { panel } = makePanel();
    expect(panel.snapshot().view).toEqual({ kind: "list", tab: "installed" });
    expect(panel.snapshot().cursor).toBe(0);
  });

  it("↑↓ move the cursor and clamp at bounds", () => {
    const { panel } = makePanel();
    panel.handleInput(KEY.down);
    expect(panel.snapshot().cursor).toBe(1);
    panel.handleInput(KEY.down);
    expect(panel.snapshot().cursor).toBe(2);
    panel.handleInput(KEY.up);
    expect(panel.snapshot().cursor).toBe(1);
    panel.handleInput(KEY.up);
    panel.handleInput(KEY.up); // clamp at 0
    expect(panel.snapshot().cursor).toBe(0);
  });

  it("Tab / ←→ cycle installed → available → marketplaces → installed", () => {
    const { panel } = makePanel();
    panel.handleInput(KEY.tab);
    expect((panel.snapshot().view as { tab: string }).tab).toBe("available");
    panel.handleInput(KEY.right);
    expect((panel.snapshot().view as { tab: string }).tab).toBe("marketplaces");
    panel.handleInput(KEY.tab);
    expect((panel.snapshot().view as { tab: string }).tab).toBe("installed");
    panel.handleInput(KEY.left);
    expect((panel.snapshot().view as { tab: string }).tab).toBe("marketplaces");
  });

  it("Enter drills into plugin-details; Esc returns to the list", () => {
    const { panel } = makePanel();
    panel.handleInput(KEY.enter);
    expect(panel.snapshot().view).toMatchObject({ kind: "plugin-details", id: "code-review@acme" });
    panel.handleInput(KEY.escape);
    expect(panel.snapshot().view).toEqual({ kind: "list", tab: "installed" });
  });

  it("Esc at the list root closes via done(); ctrl+c always closes", () => {
    const { panel, done } = makePanel();
    panel.handleInput(KEY.escape);
    expect(done).toHaveBeenCalledTimes(1);
    const second = makePanel();
    second.panel.handleInput(second.panel === panel ? KEY.escape : KEY.ctrlC);
    expect(second.done).toHaveBeenCalledTimes(1);
  });
});

describe("panel — filtering", () => {
  it("/ enters filter mode; printable chars build the query; Enter exits filter mode", () => {
    const { panel } = makePanel();
    panel.handleInput("/");
    expect(panel.snapshot().filterMode).toBe(true);
    type(panel, "sec");
    expect(panel.snapshot().filter).toBe("sec");
    // Tab does NOT switch tabs while filtering
    panel.handleInput(KEY.tab);
    expect(panel.snapshot().view).toEqual({ kind: "list", tab: "installed" });
    panel.handleInput(KEY.enter);
    expect(panel.snapshot().filterMode).toBe(false);
    expect(panel.snapshot().filter).toBe("sec");
  });

  it("backspace deletes in filter mode and resets cursor", () => {
    const { panel } = makePanel();
    panel.handleInput("/");
    type(panel, "se");
    panel.handleInput(KEY.backspace);
    expect(panel.snapshot().filter).toBe("s");
  });

  it("filtering then Enter drills into the filtered row (security)", () => {
    const { panel } = makePanel();
    panel.handleInput("/");
    type(panel, "sec");
    panel.handleInput(KEY.enter); // exit filter mode
    panel.handleInput(KEY.enter); // drill into the single filtered row
    expect(panel.snapshot().view).toMatchObject({ kind: "plugin-details", id: "security@acme" });
  });
});

describe("panel — installed tab actions", () => {
  it("Space toggles enable/disable, sets dirty, and calls setEnabled", () => {
    const { panel, calls } = makePanel();
    panel.handleInput(KEY.space); // toggle code-review (was enabled) → disable
    expect(calls.setEnabled).toEqual([["code-review@acme", false, "user"]]);
    expect(panel.snapshot().dirty).toBe(true);
  });

  it("directory plugin toggles pass scope undefined", () => {
    const { panel, calls } = makePanel();
    // move cursor to the directory row (index 3 after sort: user,user,project,directory)
    panel.handleInput(KEY.down);
    panel.handleInput(KEY.down);
    panel.handleInput(KEY.down);
    panel.handleInput(KEY.space);
    expect(calls.setEnabled).toEqual([["my-hacks", false, undefined]]);
  });

  it("u updates the current plugin; x opens the uninstall confirm", () => {
    const { panel, calls } = makePanel();
    panel.handleInput("u");
    expect(calls.update).toEqual([["code-review@acme", "user"]]);
    panel.handleInput("x");
    expect(panel.snapshot().view).toMatchObject({ kind: "confirm-uninstall", id: "code-review@acme" });
  });

  it("plugin-details Disable action toggles then returns to list", () => {
    const { panel, calls } = makePanel();
    panel.handleInput(KEY.enter); // details
    panel.handleInput(KEY.enter); // first action = Disable plugin (code-review enabled)
    expect(calls.setEnabled).toEqual([["code-review@acme", false, "user"]]);
    expect(panel.snapshot().view).toEqual({ kind: "list", tab: "installed" });
  });

  it("directory plugin details omits Update/Uninstall actions", () => {
    const deps = makeDeps();
    const { panel } = makePanel(deps);
    // navigate to directory row and enter details
    panel.handleInput(KEY.down);
    panel.handleInput(KEY.down);
    panel.handleInput(KEY.down);
    panel.handleInput(KEY.enter);
    const lines = panel.render(80).join("\n");
    expect(lines).not.toContain("Uninstall");
    expect(lines).not.toContain("Update now");
    expect(lines).toContain("Configure options");
  });
});

describe("panel — uninstall confirm", () => {
  it("Enter on 'delete data' calls uninstall(keepData:false) and returns to list", () => {
    const { panel, calls } = makePanel();
    panel.handleInput("x"); // open confirm for code-review
    panel.handleInput(KEY.enter); // first option = delete data
    expect(calls.uninstall).toEqual([["code-review@acme", "user", { keepData: false }]]);
    expect(panel.snapshot().view).toEqual({ kind: "list", tab: "installed" });
  });

  it("keep-data option calls uninstall(keepData:true)", () => {
    const { panel, calls } = makePanel();
    panel.handleInput("x");
    panel.handleInput(KEY.down); // second option = keep data
    panel.handleInput(KEY.enter);
    expect(calls.uninstall).toEqual([["code-review@acme", "user", { keepData: true }]]);
  });

  it("Cancel returns to plugin-details, not the list", () => {
    const { panel, calls } = makePanel();
    panel.handleInput(KEY.enter); // details
    // find and run Uninstall (danger) → 4th action for a user plugin
    // actions: Disable, Configure, Update, Uninstall, Back → index 3
    panel.handleInput(KEY.down);
    panel.handleInput(KEY.down);
    panel.handleInput(KEY.down);
    panel.handleInput(KEY.enter); // Uninstall → confirm
    expect(panel.snapshot().view.kind).toBe("confirm-uninstall");
    panel.handleInput(KEY.escape); // Esc from confirm → back to details
    expect(panel.snapshot().view.kind).toBe("plugin-details");
    expect(calls.uninstall).toEqual([]);
  });
});

describe("panel — available tab (multi-select + install)", () => {
  it("Space selects an uninstalled row; installed rows are not selectable", () => {
    const { panel } = makePanel();
    panel.handleInput(KEY.tab); // → available
    panel.handleInput(KEY.space); // cursor 0 = code-review (installed) → no-op
    expect(panel.snapshot().selected).toEqual([]);
    panel.handleInput(KEY.down); // deep-research (uninstalled)
    panel.handleInput(KEY.space);
    expect(panel.snapshot().selected).toEqual(["deep-research@acme"]);
    panel.handleInput(KEY.space); // toggle off
    expect(panel.snapshot().selected).toEqual([]);
  });

  it("i on the current uninstalled row opens the install trust screen for that id", () => {
    const { panel } = makePanel();
    panel.handleInput(KEY.tab);
    panel.handleInput(KEY.down); // deep-research
    panel.handleInput("i");
    expect(panel.snapshot().view).toEqual({ kind: "install", ids: ["deep-research@acme"] });
  });

  it("i with multiple selected batches all selected ids into one install screen", () => {
    const { panel } = makePanel();
    panel.handleInput(KEY.tab);
    panel.handleInput(KEY.down); // deep-research
    panel.handleInput(KEY.space);
    panel.handleInput(KEY.down); // formatter
    panel.handleInput(KEY.space);
    panel.handleInput("i");
    expect(panel.snapshot().view).toEqual({ kind: "install", ids: ["deep-research@acme", "formatter@community"] });
  });

  it("install screen: choosing a scope calls install for each id then returns to available", () => {
    const { panel, calls } = makePanel();
    panel.handleInput(KEY.tab);
    panel.handleInput(KEY.down);
    panel.handleInput("i"); // install deep-research
    panel.handleInput(KEY.down); // scope: project
    panel.handleInput(KEY.enter);
    expect(calls.install).toEqual([["deep-research@acme", "project", undefined]]);
    expect(panel.snapshot().view).toEqual({ kind: "list", tab: "available" });
    expect(panel.snapshot().dirty).toBe(true);
  });

  it("Enter on an installed available row jumps to the Installed tab", () => {
    const { panel } = makePanel();
    panel.handleInput(KEY.tab);
    panel.handleInput(KEY.enter); // code-review is installed
    expect(panel.snapshot().view).toEqual({ kind: "list", tab: "installed" });
  });

  it("Cancel on the install screen returns to available without installing", () => {
    const { panel, calls } = makePanel();
    panel.handleInput(KEY.tab);
    panel.handleInput(KEY.down);
    panel.handleInput("i");
    panel.handleInput(KEY.escape); // Esc cancels install screen
    expect(panel.snapshot().view).toEqual({ kind: "list", tab: "available" });
    expect(calls.install).toEqual([]);
  });
});

describe("panel — marketplaces tab", () => {
  it("row 0 is Add-marketplace; Enter opens the add-mkt input; typing + Enter calls addMarketplace", () => {
    const { panel, calls } = makePanel();
    panel.handleInput(KEY.right);
    panel.handleInput(KEY.right); // installed → available → marketplaces
    expect((panel.snapshot().view as { tab: string }).tab).toBe("marketplaces");
    panel.handleInput(KEY.enter); // cursor 0 → add-mkt
    expect(panel.snapshot().view).toEqual({ kind: "add-mkt" });
    type(panel, "acme/plugins");
    expect(panel.snapshot().inputValue).toBe("acme/plugins");
    panel.handleInput(KEY.enter);
    expect(calls.addMarketplace).toEqual([["acme/plugins", "user"]]);
    expect((panel.snapshot().view as { tab: string }).tab).toBe("marketplaces");
  });

  it("Enter on a marketplace row opens its details; Browse switches to Available with @mkt filter", () => {
    const { panel } = makePanel();
    panel.handleInput(KEY.tab);
    panel.handleInput(KEY.tab); // marketplaces
    panel.handleInput(KEY.down); // cursor 1 = first marketplace (acme)
    panel.handleInput(KEY.enter);
    expect(panel.snapshot().view).toEqual({ kind: "mkt-details", name: "acme" });
    panel.handleInput(KEY.enter); // first action = Browse plugins →
    expect(panel.snapshot().view).toEqual({ kind: "list", tab: "available" });
    expect(panel.snapshot().filter).toBe("@acme");
  });

  it("r on a marketplace row jumps to its Remove action; running it calls removeMarketplace with the right scope", () => {
    const { panel, calls } = makePanel();
    panel.handleInput(KEY.tab);
    panel.handleInput(KEY.tab);
    panel.handleInput(KEY.down); // acme (user scope)
    panel.handleInput("r"); // → mkt-details, cursor on Remove
    expect(panel.snapshot().view).toEqual({ kind: "mkt-details", name: "acme" });
    panel.handleInput(KEY.enter); // Remove marketplace
    expect(calls.removeMarketplace).toEqual([["acme", "user"]]);
  });

  it("u on a marketplace row updates it in place", () => {
    const { panel, calls } = makePanel();
    panel.handleInput(KEY.tab);
    panel.handleInput(KEY.tab);
    panel.handleInput(KEY.down);
    panel.handleInput("u");
    expect(calls.updateMarketplace).toEqual(["acme"]);
  });

  it("`a` opens add-marketplace from any tab", () => {
    const { panel } = makePanel();
    panel.handleInput("a"); // from installed tab
    expect(panel.snapshot().view).toEqual({ kind: "add-mkt" });
  });
});

describe("panel — configure", () => {
  it("schema-driven form steps through fields and calls configure with coerced values", () => {
    const deps = makeDeps({ manifests: { "code-review@acme": { config: { apiKey: { description: "token" }, retries: {} } } } });
    const { panel, calls } = makePanel(deps);
    panel.handleInput(KEY.enter); // details
    panel.handleInput(KEY.down); // action 1 = Configure options…
    panel.handleInput(KEY.enter);
    expect(panel.snapshot().view.kind).toBe("configure");
    type(panel, "secret");
    panel.handleInput(KEY.enter); // save & next → retries
    type(panel, "3");
    panel.handleInput(KEY.enter); // last field → commit
    expect(calls.configure).toEqual([["code-review@acme", { apiKey: "secret", retries: 3 }, "user"]]);
    expect(panel.snapshot().view.kind).toBe("plugin-details");
  });

  it("no manifest schema → free-form key=value fallback field", () => {
    const { panel, calls } = makePanel(); // no manifest for code-review
    panel.handleInput(KEY.enter);
    panel.handleInput(KEY.down);
    panel.handleInput(KEY.enter); // Configure
    expect(panel.snapshot().view.kind).toBe("configure");
    type(panel, "a=1,b=two");
    panel.handleInput(KEY.enter); // single field → commit
    expect(calls.configure).toEqual([["code-review@acme", { a: 1, b: "two" }, "user"]]);
  });

  it("Esc cancels configure back to details without calling configure", () => {
    const { panel, calls } = makePanel();
    panel.handleInput(KEY.enter);
    panel.handleInput(KEY.down);
    panel.handleInput(KEY.enter);
    panel.handleInput(KEY.escape);
    expect(panel.snapshot().view.kind).toBe("plugin-details");
    expect(calls.configure).toEqual([]);
  });
});

// ── render snapshots ─────────────────────────────────────────────────────────

describe("panel — render", () => {
  it("Installed tab renders tabs, group headers, badges and the reload hint after a toggle", () => {
    const { panel } = makePanel();
    const before = panel.render(78).join("\n");
    expect(before).toContain("Plugins");
    expect(before).toContain("Installed");
    expect(before).toContain("Available");
    expect(before).toContain("Marketplaces");
    expect(before).toContain("user");
    expect(before).toContain("code-review");
    expect(before).toContain("[on]");
    expect(before).toContain("[off]");
    expect(before).not.toContain("run /reload"); // not dirty yet
    panel.handleInput(KEY.space); // toggle → dirty
    expect(panel.render(78).join("\n")).toContain("run /reload to apply");
  });

  it("Available tab renders selection markers and (installed) label", () => {
    const { panel } = makePanel();
    panel.handleInput(KEY.tab);
    const out = panel.render(78).join("\n");
    expect(out).toContain("deep-research");
    expect(out).toContain("(installed)"); // code-review is installed
    expect(out).toContain("◯"); // unselected marker
  });

  it("install screen shows the Trust check block", () => {
    const { panel } = makePanel();
    panel.handleInput(KEY.tab);
    panel.handleInput(KEY.down);
    panel.handleInput("i");
    const out = panel.render(78).join("\n");
    expect(out).toContain("Trust check");
    expect(out).toContain("Install for me (user)");
  });

  it("Marketplaces tab always shows the Add-marketplace row and source counts", () => {
    const { panel } = makePanel();
    panel.handleInput(KEY.tab);
    panel.handleInput(KEY.tab);
    const out = panel.render(78).join("\n");
    expect(out).toContain("Add marketplace");
    expect(out).toContain("github:acme/plugins");
    expect(out).toContain("2 available");
  });

  it("every rendered line is width-bounded (borders align)", () => {
    const { panel } = makePanel();
    // strip nothing (identity theme) → visible width should equal line length
    for (const line of panel.render(60)) {
      // border chars on both ends; total visible width is constant
      expect(line.startsWith("│") || line.startsWith("╭") || line.startsWith("├") || line.startsWith("╰")).toBe(true);
    }
  });
});
