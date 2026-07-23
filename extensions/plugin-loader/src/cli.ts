import type { PluginScope } from "./manager.js";

export interface ParsedPluginCommand {
  command: string;
  args: string[];
  scope?: PluginScope;
  json: boolean;
  available: boolean;
  all: boolean;
  keepData: boolean;
  prune: boolean;
  yes: boolean;
  configs: Record<string, unknown>;
}

export function shellSplit(input: string): string[] {
  const out: string[] = [];
  let token = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let started = false;
  for (const char of input.trim()) {
    if (escaped) {
      token += char;
      escaped = false;
      started = true;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      else token += char;
      started = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) {
        out.push(token);
        token = "";
        started = false;
      }
    } else {
      token += char;
      started = true;
    }
  }
  if (escaped) token += "\\";
  if (quote) throw new Error("Unterminated quote in plugin command.");
  if (started) out.push(token);
  return out;
}

function configValue(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  if ((raw.startsWith("{") && raw.endsWith("}")) || (raw.startsWith("[") && raw.endsWith("]"))) {
    try { return JSON.parse(raw); } catch { /* keep a string */ }
  }
  return raw;
}

export function parsePluginCommand(input: string): ParsedPluginCommand {
  const tokens = shellSplit(input);
  const command = tokens.shift() ?? "";
  const parsed: ParsedPluginCommand = {
    command,
    args: [],
    json: false,
    available: false,
    all: false,
    keepData: false,
    prune: false,
    yes: false,
    configs: {},
  };
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token === "--json") parsed.json = true;
    else if (token === "--available") parsed.available = true;
    else if (token === "--all" || token === "-a") parsed.all = true;
    else if (token === "--keep-data") parsed.keepData = true;
    else if (token === "--prune") parsed.prune = true;
    else if (token === "--yes" || token === "-y") parsed.yes = true;
    else if (token === "--scope" || token === "-s") {
      const value = tokens[++index];
      if (!value) throw new Error(`${token} requires user, project, or local.`);
      if (value !== "user" && value !== "project" && value !== "local") throw new Error(`Invalid scope: ${value}`);
      parsed.scope = value;
    } else if (token.startsWith("--scope=")) {
      const value = token.slice("--scope=".length);
      if (value !== "user" && value !== "project" && value !== "local") throw new Error(`Invalid scope: ${value}`);
      parsed.scope = value;
    } else if (token === "--config") {
      const pair = tokens[++index];
      if (!pair) throw new Error("--config requires key=value.");
      const equals = pair.indexOf("=");
      if (equals < 1) throw new Error("--config requires key=value.");
      parsed.configs[pair.slice(0, equals)] = configValue(pair.slice(equals + 1));
    } else if (token.startsWith("--config=")) {
      const pair = token.slice("--config=".length);
      const equals = pair.indexOf("=");
      if (equals < 1) throw new Error("--config requires key=value.");
      parsed.configs[pair.slice(0, equals)] = configValue(pair.slice(equals + 1));
    } else if (token.startsWith("-")) throw new Error(`Unknown option: ${token}`);
    else parsed.args.push(token);
  }
  return parsed;
}

export const PLUGIN_HELP = `Plugin management

/plugin                         Open the interactive plugin menu
/plugin list [--available] [--json]
/plugin marketplace add <path|git-url> [--scope user|project|local]
/plugin marketplace list [--json]
/plugin marketplace remove <name> [--scope ...]
/plugin marketplace update [name]
/plugin install|i <plugin@marketplace> [--scope ...] [--config key=value]
/plugin uninstall|remove <plugin> [--scope ...] [--keep-data] [--prune]
/plugin enable|disable <plugin> [--scope ...]
/plugin update <plugin> [--scope ...]
/plugin details <plugin> [--json]
/plugin configure <plugin> key=value ... [--scope ...]
/plugin validate <path>
/plugin init|new <name> [parent-dir]
/plugin prune|autoremove [--scope ...]

Scopes default to user for install/update/uninstall and auto-detect for enable/disable.`;
