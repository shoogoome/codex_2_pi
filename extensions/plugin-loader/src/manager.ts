import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { parseManifest } from "./manifest.js";

export type PluginScope = "user" | "project" | "local";

export interface MarketplaceRecord {
  name: string;
  source: string;
  path: string;
  updatedAt: string;
}

export interface InstalledPluginRecord {
  id: string;
  name: string;
  marketplace: string;
  version: string;
  source: string;
  path: string;
  installedAt: string;
  updatedAt: string;
  scope: PluginScope;
  autoInstalled?: boolean;
  installedAsDependencyOf?: string[];
  userConfig?: Record<string, unknown>;
}

export interface PluginState {
  version: 1;
  marketplaces: Record<string, MarketplaceRecord>;
  installed: Record<string, InstalledPluginRecord>;
  enabled: Record<string, boolean>;
}

export interface MarketplacePlugin {
  name: string;
  version?: string;
  description?: string;
  source: string | { source: string; [key: string]: unknown };
  dependencies?: string[];
  defaultEnabled?: boolean;
  [key: string]: unknown;
}

export interface MarketplaceManifest {
  name: string;
  owner?: unknown;
  metadata?: unknown;
  plugins: MarketplacePlugin[];
}

export interface AvailablePlugin {
  id: string;
  name: string;
  marketplace: string;
  version: string;
  description?: string;
  source: string;
  installed: boolean;
}

export interface PluginDetails {
  id: string;
  installed?: InstalledPluginRecord;
  available?: AvailablePlugin;
  enabled: boolean;
  manifest?: Record<string, unknown>;
  components: Record<string, number | boolean>;
}

export interface ValidationResult {
  valid: boolean;
  kind: "plugin" | "marketplace" | "unknown";
  errors: string[];
  warnings: string[];
}

export interface ManagerOptions {
  cwd?: string;
  home?: string;
  run?: (command: string, args: string[], cwd?: string) => string;
  now?: () => Date;
}

const EMPTY_STATE: PluginState = {
  version: 1,
  marketplaces: {},
  installed: {},
  enabled: {},
};

function cloneEmptyState(): PluginState {
  return { version: 1, marketplaces: {}, installed: {}, enabled: {} };
}

export function normalizeScope(value: string | undefined, fallback: PluginScope = "user"): PluginScope {
  const scope = value ?? fallback;
  if (scope !== "user" && scope !== "project" && scope !== "local") {
    throw new Error(`Invalid scope "${scope}". Expected user, project, or local.`);
  }
  return scope;
}

export function statePath(scope: PluginScope, cwd: string, home = homedir()): string {
  if (scope === "user") return join(home, ".pi", "agent", "plugins", "state.json");
  return join(cwd, ".pi", scope === "project" ? "plugins.json" : "plugins.local.json");
}

export function cacheRoot(scope: PluginScope, cwd: string, home = homedir()): string {
  if (scope === "user") return join(home, ".pi", "agent", "plugins", "cache");
  return join(cwd, ".pi", "plugin-cache", scope);
}

export function marketplaceCacheRoot(scope: PluginScope, cwd: string, home = homedir()): string {
  if (scope === "user") return join(home, ".pi", "agent", "plugins", "marketplaces");
  return join(cwd, ".pi", "plugin-marketplaces", scope);
}

export function readState(path: string): PluginState {
  if (!existsSync(path)) return cloneEmptyState();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<PluginState>;
    return {
      version: 1,
      marketplaces: parsed.marketplaces && typeof parsed.marketplaces === "object" ? parsed.marketplaces : {},
      installed: parsed.installed && typeof parsed.installed === "object" ? parsed.installed : {},
      enabled: parsed.enabled && typeof parsed.enabled === "object" ? parsed.enabled : {},
    };
  } catch (error) {
    throw new Error(`Cannot read plugin state ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function writeState(path: string, state: PluginState): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

function safeName(value: string, label: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value) || value === "." || value === "..") {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return value;
}

function assertInside(root: string, target: string): string {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  const rel = relative(resolvedRoot, resolvedTarget);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Path escapes its root: ${target}`);
  }
  return resolvedTarget;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot parse ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function parseMarketplaceManifest(value: unknown): MarketplaceManifest {
  if (!value || typeof value !== "object") throw new Error("Marketplace manifest must be an object.");
  const raw = value as Record<string, unknown>;
  if (typeof raw.name !== "string" || !raw.name.trim()) throw new Error("Marketplace requires a name.");
  safeName(raw.name, "marketplace name");
  if (!Array.isArray(raw.plugins)) throw new Error("Marketplace requires a plugins array.");
  const plugins = raw.plugins.map((entry, index) => {
    if (!entry || typeof entry !== "object") throw new Error(`plugins[${index}] must be an object.`);
    const plugin = entry as Record<string, unknown>;
    if (typeof plugin.name !== "string") throw new Error(`plugins[${index}] requires name.`);
    safeName(plugin.name, "plugin name");
    const source = plugin.source;
    if (!(typeof source === "string" || (source && typeof source === "object" && typeof (source as Record<string, unknown>).source === "string"))) {
      throw new Error(`plugins[${index}] requires a string source.`);
    }
    if (plugin.dependencies !== undefined && (!Array.isArray(plugin.dependencies) || plugin.dependencies.some((x) => typeof x !== "string"))) {
      throw new Error(`plugins[${index}].dependencies must be a string array.`);
    }
    return plugin as unknown as MarketplacePlugin;
  });
  return { ...(raw as unknown as MarketplaceManifest), name: raw.name, plugins };
}

function marketplaceManifestPath(root: string): string {
  const candidates = [join(root, ".claude-plugin", "marketplace.json"), join(root, ".pi-plugin", "marketplace.json"), join(root, "marketplace.json")];
  const found = candidates.find(existsSync);
  if (!found) throw new Error(`No marketplace.json found in ${root}`);
  return found;
}

function pluginManifestPath(root: string): string | undefined {
  return [join(root, ".pi-plugin", "plugin.json"), join(root, ".claude-plugin", "plugin.json"), join(root, ".cursor-plugin", "plugin.json")].find(existsSync);
}

function sourceValue(plugin: MarketplacePlugin): string {
  return typeof plugin.source === "string" ? plugin.source : plugin.source.source;
}

function looksLikeGit(source: string): boolean {
  const shorthand = source.match(/^([a-zA-Z0-9][\w.-]*)\/([a-zA-Z0-9][\w.-]*)(?:#.*)?$/);
  return /^(?:git@|ssh:\/\/|https?:\/\/).+\.git(?:#.*)?$/.test(source) || Boolean(shorthand);
}

function normalizeGitSource(source: string): { url: string; ref?: string } {
  let input = source;
  let ref: string | undefined;
  const hash = input.lastIndexOf("#");
  if (hash > input.indexOf("//") + 1) {
    ref = input.slice(hash + 1) || undefined;
    input = input.slice(0, hash);
  }
  if (/^[\w.-]+\/[\w.-]+$/.test(input)) input = `https://github.com/${input}.git`;
  return { url: input, ref };
}

function copyDirectorySafe(source: string, destination: string): void {
  const sourceReal = realpathSync(source);
  if (!statSync(sourceReal).isDirectory()) throw new Error(`Source is not a directory: ${source}`);
  const parent = dirname(destination);
  mkdirSync(parent, { recursive: true });
  const staging = `${destination}.staging-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const backup = `${destination}.backup-${process.pid}-${Math.random().toString(16).slice(2)}`;
  rmSync(staging, { recursive: true, force: true });
  cpSync(sourceReal, staging, {
    recursive: true,
    dereference: false,
    filter: (path) => basename(path) !== ".git",
  });
  const hadDestination = existsSync(destination);
  try {
    if (hadDestination) renameSync(destination, backup);
    renameSync(staging, destination);
    rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    if (hadDestination && existsSync(backup) && !existsSync(destination)) renameSync(backup, destination);
    throw error;
  }
}

function countMarkdown(path: string): number {
  if (!existsSync(path) || !statSync(path).isDirectory()) return 0;
  return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".md")).length;
}

export class PluginManager {
  readonly cwd: string;
  readonly home: string;
  private readonly run: (command: string, args: string[], cwd?: string) => string;
  private readonly now: () => Date;

  constructor(options: ManagerOptions = {}) {
    this.cwd = resolve(options.cwd ?? process.cwd());
    this.home = resolve(options.home ?? homedir());
    this.run = options.run ?? ((command, args, cwd) => execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 }));
    this.now = options.now ?? (() => new Date());
  }

  private path(scope: PluginScope): string {
    return statePath(scope, this.cwd, this.home);
  }

  getState(scope: PluginScope): PluginState {
    return readState(this.path(scope));
  }

  private save(scope: PluginScope, state: PluginState): void {
    writeState(this.path(scope), state);
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private materializeMarketplace(source: string, scope: PluginScope, requestedName?: string): { path: string; manifest: MarketplaceManifest } {
    const local = source.startsWith("file://") ? new URL(source).pathname : source;
    if (existsSync(resolve(this.cwd, local)) || isAbsolute(local) && existsSync(local)) {
      const path = realpathSync(isAbsolute(local) ? local : resolve(this.cwd, local));
      const manifest = parseMarketplaceManifest(readJson(marketplaceManifestPath(path)));
      return { path, manifest };
    }
    if (!looksLikeGit(source)) throw new Error(`Unsupported marketplace source: ${source}. Use a local directory, GitHub owner/repo, or git URL.`);
    const { url, ref } = normalizeGitSource(source);
    const temp = mkdtempSync(join(tmpdir(), "pi-marketplace-"));
    try {
      const args = ["clone", "--depth", "1"];
      if (ref) args.push("--branch", ref);
      args.push(url, temp);
      this.run("git", args, this.cwd);
      const manifest = parseMarketplaceManifest(readJson(marketplaceManifestPath(temp)));
      const name = safeName(requestedName ?? manifest.name, "marketplace name");
      const destination = assertInside(marketplaceCacheRoot(scope, this.cwd, this.home), join(marketplaceCacheRoot(scope, this.cwd, this.home), name));
      copyDirectorySafe(temp, destination);
      return { path: destination, manifest };
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }

  addMarketplace(source: string, scope: PluginScope = "user"): MarketplaceRecord {
    const materialized = this.materializeMarketplace(source, scope);
    const state = this.getState(scope);
    const record: MarketplaceRecord = { name: materialized.manifest.name, source, path: materialized.path, updatedAt: this.timestamp() };
    state.marketplaces[record.name] = record;
    this.save(scope, state);
    return record;
  }

  listMarketplaces(scope?: PluginScope): Array<MarketplaceRecord & { scope: PluginScope }> {
    const scopes: PluginScope[] = scope ? [scope] : ["local", "project", "user"];
    const seen = new Set<string>();
    const result: Array<MarketplaceRecord & { scope: PluginScope }> = [];
    for (const itemScope of scopes) {
      for (const record of Object.values(this.getState(itemScope).marketplaces)) {
        if (seen.has(record.name)) continue;
        seen.add(record.name);
        result.push({ ...record, scope: itemScope });
      }
    }
    return result;
  }

  removeMarketplace(name: string, scope?: PluginScope): number {
    safeName(name, "marketplace name");
    const scopes: PluginScope[] = scope ? [scope] : ["user", "project", "local"];
    let removed = 0;
    for (const itemScope of scopes) {
      const state = this.getState(itemScope);
      if (!state.marketplaces[name]) continue;
      const record = state.marketplaces[name];
      delete state.marketplaces[name];
      this.save(itemScope, state);
      const root = marketplaceCacheRoot(itemScope, this.cwd, this.home);
      if (record && relative(root, record.path).split(sep)[0] === name && existsSync(record.path)) rmSync(record.path, { recursive: true, force: true });
      removed++;
    }
    return removed;
  }

  updateMarketplace(name?: string): MarketplaceRecord[] {
    const targets = this.listMarketplaces().filter((item) => !name || item.name === name);
    if (name && targets.length === 0) throw new Error(`Marketplace not found: ${name}`);
    const result: MarketplaceRecord[] = [];
    for (const target of targets) {
      const materialized = this.materializeMarketplace(target.source, target.scope, target.name);
      const state = this.getState(target.scope);
      const updated = { ...target, path: materialized.path, updatedAt: this.timestamp() };
      state.marketplaces[target.name] = updated;
      this.save(target.scope, state);
      result.push(updated);
    }
    return result;
  }

  private marketplaceData(record: MarketplaceRecord): MarketplaceManifest {
    return parseMarketplaceManifest(readJson(marketplaceManifestPath(record.path)));
  }

  listAvailable(): AvailablePlugin[] {
    const installed = new Set(this.listInstalled().map((item) => item.id));
    const result: AvailablePlugin[] = [];
    for (const market of this.listMarketplaces()) {
      const manifest = this.marketplaceData(market);
      for (const plugin of manifest.plugins) {
        const id = `${plugin.name}@${market.name}`;
        result.push({
          id,
          name: plugin.name,
          marketplace: market.name,
          version: plugin.version ?? "0.0.0",
          description: plugin.description,
          source: sourceValue(plugin),
          installed: installed.has(id),
        });
      }
    }
    return result;
  }

  private resolveAvailable(identifier: string): { market: MarketplaceRecord & { scope: PluginScope }; plugin: MarketplacePlugin; id: string } {
    const [name, requestedMarket] = identifier.split("@", 2);
    safeName(name!, "plugin name");
    if (requestedMarket) safeName(requestedMarket, "marketplace name");
    const matches: Array<{ market: MarketplaceRecord & { scope: PluginScope }; plugin: MarketplacePlugin }> = [];
    for (const market of this.listMarketplaces()) {
      if (requestedMarket && market.name !== requestedMarket) continue;
      const plugin = this.marketplaceData(market).plugins.find((entry) => entry.name === name);
      if (plugin) matches.push({ market, plugin });
    }
    if (matches.length === 0) throw new Error(`Plugin not found in configured marketplaces: ${identifier}`);
    if (matches.length > 1 && !requestedMarket) throw new Error(`Plugin "${name}" is ambiguous; use plugin@marketplace.`);
    const found = matches[0]!;
    return { ...found, id: `${found.plugin.name}@${found.market.name}` };
  }

  private materializePlugin(found: ReturnType<PluginManager["resolveAvailable"]>, scope: PluginScope): { sourcePath: string; version: string } {
    const raw = sourceValue(found.plugin);
    const marketRoot = found.market.path;
    const candidate = isAbsolute(raw) ? raw : resolve(marketRoot, raw);
    if (existsSync(candidate)) {
      const rootReal = realpathSync(marketRoot);
      const sourceReal = realpathSync(candidate);
      const rel = relative(rootReal, sourceReal);
      if (rel === ".." || rel.startsWith(`..${sep}`)) throw new Error(`Plugin source escapes marketplace: ${raw}`);
      return { sourcePath: sourceReal, version: found.plugin.version ?? this.readPluginVersion(sourceReal) ?? "0.0.0" };
    }
    if (!looksLikeGit(raw)) throw new Error(`Plugin source does not exist: ${raw}`);
    const { url, ref } = normalizeGitSource(raw);
    const temp = mkdtempSync(join(tmpdir(), "pi-plugin-"));
    const args = ["clone", "--depth", "1"];
    if (ref) args.push("--branch", ref);
    args.push(url, temp);
    this.run("git", args, this.cwd);
    return { sourcePath: temp, version: found.plugin.version ?? this.readPluginVersion(temp) ?? "0.0.0" };
  }

  private readPluginVersion(root: string): string | undefined {
    const manifestPath = pluginManifestPath(root);
    if (!manifestPath) return undefined;
    const value = readJson(manifestPath);
    return value && typeof value === "object" && typeof (value as Record<string, unknown>).version === "string"
      ? (value as Record<string, unknown>).version as string
      : undefined;
  }

  install(identifier: string, scope: PluginScope = "user", options: { userConfig?: Record<string, unknown>; autoInstalled?: boolean; dependencyOf?: string } = {}): InstalledPluginRecord[] {
    const installed: InstalledPluginRecord[] = [];
    const visiting = new Set<string>();
    const installOne = (target: string, autoInstalled = false, dependencyOf?: string): InstalledPluginRecord => {
      const found = this.resolveAvailable(target);
      if (visiting.has(found.id)) throw new Error(`Plugin dependency cycle detected at ${found.id}`);
      const state = this.getState(scope);
      const existing = state.installed[found.id];
      if (existing) {
        if (dependencyOf) existing.installedAsDependencyOf = [...new Set([...(existing.installedAsDependencyOf ?? []), dependencyOf])];
        this.save(scope, state);
        return existing;
      }
      visiting.add(found.id);
      for (const dependency of found.plugin.dependencies ?? []) installOne(dependency, true, found.id);
      const materialized = this.materializePlugin(found, scope);
      try {
        const versionName = safeName(materialized.version.replace(/[^a-zA-Z0-9._-]/g, "-") || "0.0.0", "plugin version");
        const destination = assertInside(cacheRoot(scope, this.cwd, this.home), join(cacheRoot(scope, this.cwd, this.home), found.market.name, found.plugin.name, versionName));
        copyDirectorySafe(materialized.sourcePath, destination);
        const validation = this.validate(destination);
        if (!validation.valid) throw new Error(`Invalid plugin ${found.id}: ${validation.errors.join("; ")}`);
        const now = this.timestamp();
        const current = this.getState(scope);
        const record: InstalledPluginRecord = {
          id: found.id,
          name: found.plugin.name,
          marketplace: found.market.name,
          version: materialized.version,
          source: sourceValue(found.plugin),
          path: destination,
          installedAt: now,
          updatedAt: now,
          scope,
          autoInstalled,
          installedAsDependencyOf: dependencyOf ? [dependencyOf] : undefined,
          userConfig: options.userConfig,
        };
        current.installed[found.id] = record;
        if (!(found.id in current.enabled)) current.enabled[found.id] = found.plugin.defaultEnabled !== false;
        this.save(scope, current);
        installed.push(record);
        return record;
      } finally {
        if (materialized.sourcePath.startsWith(join(tmpdir(), "pi-plugin-"))) rmSync(materialized.sourcePath, { recursive: true, force: true });
        visiting.delete(found.id);
      }
    };
    installOne(identifier, options.autoInstalled, options.dependencyOf);
    return installed;
  }

  listInstalled(scope?: PluginScope): InstalledPluginRecord[] {
    const scopes: PluginScope[] = scope ? [scope] : ["local", "project", "user"];
    const seen = new Set<string>();
    const result: InstalledPluginRecord[] = [];
    for (const itemScope of scopes) {
      for (const record of Object.values(this.getState(itemScope).installed)) {
        if (seen.has(record.id)) continue;
        seen.add(record.id);
        result.push({ ...record, scope: itemScope });
      }
    }
    return result;
  }

  uninstall(identifier: string, scope: PluginScope = "user", options: { keepData?: boolean; prune?: boolean } = {}): InstalledPluginRecord {
    const state = this.getState(scope);
    const record = state.installed[identifier] ?? Object.values(state.installed).find((item) => item.name === identifier);
    if (!record) throw new Error(`Plugin is not installed in ${scope} scope: ${identifier}`);
    delete state.installed[record.id];
    delete state.enabled[record.id];
    this.save(scope, state);
    const root = cacheRoot(scope, this.cwd, this.home);
    assertInside(root, record.path);
    rmSync(record.path, { recursive: true, force: true });
    if (!options.keepData) rmSync(join(this.pluginDataRoot(scope), record.id.replace("@", "--")), { recursive: true, force: true });
    for (const item of Object.values(state.installed)) {
      if (item.installedAsDependencyOf?.includes(record.id)) item.installedAsDependencyOf = item.installedAsDependencyOf.filter((id) => id !== record.id);
    }
    for (const dependency of Object.values(state.installed)) {
      if (!dependency.autoInstalled || !dependency.installedAsDependencyOf?.includes(record.id)) continue;
      dependency.installedAsDependencyOf = dependency.installedAsDependencyOf.filter((id) => id !== record.id);
    }
    this.save(scope, state);
    if (options.prune) this.prune(scope);
    return record;
  }

  update(identifier: string, scope: PluginScope = "user"): InstalledPluginRecord[] {
    const state = this.getState(scope);
    const record = state.installed[identifier] ?? Object.values(state.installed).find((item) => item.name === identifier);
    if (!record) throw new Error(`Plugin is not installed in ${scope} scope: ${identifier}`);
    const found = this.resolveAvailable(record.id);
    const materialized = this.materializePlugin(found, scope);
    try {
      const versionName = safeName(materialized.version.replace(/[^a-zA-Z0-9._-]/g, "-") || "0.0.0", "plugin version");
      const destination = assertInside(cacheRoot(scope, this.cwd, this.home), join(cacheRoot(scope, this.cwd, this.home), found.market.name, found.plugin.name, versionName));
      const validation = this.validate(materialized.sourcePath);
      if (!validation.valid) throw new Error(`Invalid plugin ${found.id}: ${validation.errors.join("; ")}`);
      copyDirectorySafe(materialized.sourcePath, destination);
      if (record.path !== destination) rmSync(record.path, { recursive: true, force: true });
      const updated: InstalledPluginRecord = {
        ...record,
        version: materialized.version,
        source: sourceValue(found.plugin),
        path: destination,
        updatedAt: this.timestamp(),
      };
      state.installed[record.id] = updated;
      this.save(scope, state);
      return [updated];
    } finally {
      if (materialized.sourcePath.startsWith(join(tmpdir(), "pi-plugin-"))) rmSync(materialized.sourcePath, { recursive: true, force: true });
    }
  }

  setEnabled(identifier: string, enabled: boolean, scope?: PluginScope): { id: string; scope: PluginScope; enabled: boolean } {
    let targetScope = scope;
    let id = identifier;
    if (!targetScope) {
      const found = this.listInstalled().find((record) => record.id === identifier || record.name === identifier);
      if (found) {
        targetScope = found.scope;
        id = found.id;
      } else targetScope = "user";
    }
    const state = this.getState(targetScope);
    const installed = state.installed[id] ?? Object.values(state.installed).find((item) => item.name === identifier);
    if (installed) id = installed.id;
    state.enabled[id] = enabled;
    this.save(targetScope, state);
    return { id, scope: targetScope, enabled };
  }

  isEnabled(identifier: string): boolean {
    for (const scope of ["local", "project", "user"] as const) {
      const state = this.getState(scope);
      const record = Object.values(state.installed).find((item) => item.id === identifier || item.name === identifier);
      const id = record?.id ?? identifier;
      if (id in state.enabled) return state.enabled[id] !== false;
    }
    return true;
  }

  configure(identifier: string, values: Record<string, unknown>, scope?: PluginScope): InstalledPluginRecord {
    const candidates = scope ? this.listInstalled(scope) : this.listInstalled();
    const record = candidates.find((item) => item.id === identifier || item.name === identifier);
    if (!record) throw new Error(`Plugin is not installed: ${identifier}`);
    const state = this.getState(record.scope);
    state.installed[record.id]!.userConfig = { ...(state.installed[record.id]!.userConfig ?? {}), ...values };
    this.save(record.scope, state);
    return state.installed[record.id]!;
  }

  details(identifier: string): PluginDetails {
    const installed = this.listInstalled().find((item) => item.id === identifier || item.name === identifier);
    const available = this.listAvailable().find((item) => item.id === identifier || item.name === identifier);
    if (!installed && !available) throw new Error(`Unknown plugin: ${identifier}`);
    const id = installed?.id ?? available!.id;
    const root = installed?.path;
    const manifestPath = root ? pluginManifestPath(root) : undefined;
    const manifest = manifestPath ? readJson(manifestPath) as Record<string, unknown> : undefined;
    return {
      id,
      installed,
      available,
      enabled: this.isEnabled(id),
      manifest,
      components: root ? {
        commands: countMarkdown(join(root, "commands")),
        skills: existsSync(join(root, "skills")) ? readdirSync(join(root, "skills"), { withFileTypes: true }).filter((x) => x.isDirectory()).length : 0,
        agents: countMarkdown(join(root, "agents")),
        hooks: existsSync(join(root, "hooks", "hooks.json")),
        mcp: existsSync(join(root, ".mcp.json")),
        lsp: existsSync(join(root, ".lsp.json")),
        outputStyles: countMarkdown(join(root, "output-styles")),
      } : {},
    };
  }

  validate(path: string): ValidationResult {
    const root = resolve(this.cwd, path);
    const errors: string[] = [];
    const warnings: string[] = [];
    if (!existsSync(root) || !statSync(root).isDirectory()) return { valid: false, kind: "unknown", errors: [`Directory not found: ${root}`], warnings };
    try {
      const marketplacePath = [join(root, ".claude-plugin", "marketplace.json"), join(root, ".pi-plugin", "marketplace.json"), join(root, "marketplace.json")].find(existsSync);
      if (marketplacePath) {
        const manifest = parseMarketplaceManifest(readJson(marketplacePath));
        for (const plugin of manifest.plugins) {
          const source = sourceValue(plugin);
          if (!looksLikeGit(source)) {
            const target = resolve(root, source);
            const rel = relative(root, target);
            if (rel === ".." || rel.startsWith(`..${sep}`)) errors.push(`Plugin ${plugin.name} source escapes marketplace: ${source}`);
            else if (!existsSync(target)) errors.push(`Plugin ${plugin.name} source is missing: ${source}`);
          }
        }
        return { valid: errors.length === 0, kind: "marketplace", errors, warnings };
      }
      const manifestPath = pluginManifestPath(root);
      if (manifestPath) {
        const parsed = parseManifest(readFileSync(manifestPath, "utf8"), basename(root));
        if (!parsed.name) errors.push("Plugin manifest requires name.");
        if (parsed.name) safeName(parsed.name, "plugin name");
      } else if (!["commands", "skills", "agents", "hooks", "output-styles"].some((dir) => existsSync(join(root, dir))) && !existsSync(join(root, ".mcp.json"))) {
        errors.push("No plugin manifest or recognized component directory found.");
      } else warnings.push("Plugin has no manifest; directory name will be used.");
      for (const jsonPath of [join(root, ".mcp.json"), join(root, ".lsp.json"), join(root, "hooks", "hooks.json")]) {
        if (existsSync(jsonPath)) try { readJson(jsonPath); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
      }
      return { valid: errors.length === 0, kind: "plugin", errors, warnings };
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      return { valid: false, kind: "unknown", errors, warnings };
    }
  }

  init(name: string, parent = join(this.home, ".pi", "agent", "skills")): string {
    safeName(name, "plugin name");
    const root = assertInside(parent, join(parent, name));
    if (existsSync(root)) throw new Error(`Path already exists: ${root}`);
    mkdirSync(join(root, ".claude-plugin"), { recursive: true });
    mkdirSync(join(root, "skills", name), { recursive: true });
    writeFileSync(join(root, ".claude-plugin", "plugin.json"), `${JSON.stringify({ name, version: "0.1.0", description: "" }, null, 2)}\n`);
    writeFileSync(join(root, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: Describe when to use this skill.\n---\n\n# ${name}\n`);
    return root;
  }

  prune(scope: PluginScope = "user"): InstalledPluginRecord[] {
    const state = this.getState(scope);
    const removed: InstalledPluginRecord[] = [];
    let changed = true;
    while (changed) {
      changed = false;
      for (const record of Object.values(state.installed)) {
        if (!record.autoInstalled || (record.installedAsDependencyOf?.length ?? 0) > 0) continue;
        delete state.installed[record.id];
        delete state.enabled[record.id];
        rmSync(record.path, { recursive: true, force: true });
        removed.push(record);
        changed = true;
      }
    }
    this.save(scope, state);
    return removed;
  }

  pluginDataRoot(scope: PluginScope): string {
    if (scope === "user") return join(this.home, ".pi", "agent", "plugins", "data");
    return join(this.cwd, ".pi", "plugin-data", scope);
  }

  pluginEnvironment(record: InstalledPluginRecord): Record<string, string> {
    const data = join(this.pluginDataRoot(record.scope), record.id.replace("@", "--"));
    mkdirSync(data, { recursive: true });
    return { CLAUDE_PLUGIN_ROOT: record.path, CLAUDE_PLUGIN_DATA: data };
  }
}

export { EMPTY_STATE };
