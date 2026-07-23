import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface SettingsEnvOptions {
  cwd: string;
  agentDir: string;
  environ?: NodeJS.ProcessEnv;
}

export interface SettingsEnvResult {
  loaded: string[];
  skipped: string[];
  warnings: string[];
}

interface EnvSettings {
  env?: unknown;
  envOverride?: unknown;
}

function stripJsonComments(input: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    const next = input[index + 1];

    if (lineComment) {
      if (character === "\n" || character === "\r") {
        lineComment = false;
        output += character;
      } else {
        output += " ";
      }
      continue;
    }

    if (blockComment) {
      if (character === "*" && next === "/") {
        output += "  ";
        index += 1;
        blockComment = false;
      } else {
        output += character === "\n" || character === "\r" ? character : " ";
      }
      continue;
    }

    if (inString) {
      output += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      output += character;
    } else if (character === "/" && next === "/") {
      output += "  ";
      index += 1;
      lineComment = true;
    } else if (character === "/" && next === "*") {
      output += "  ";
      index += 1;
      blockComment = true;
    } else {
      output += character;
    }
  }

  return output;
}

function stripTrailingCommas(input: string): string {
  let output = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];

    if (inString) {
      output += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      output += character;
      continue;
    }

    if (character === ",") {
      let lookahead = index + 1;
      while (/\s/.test(input[lookahead] ?? "")) {
        lookahead += 1;
      }
      if (input[lookahead] === "}" || input[lookahead] === "]") {
        continue;
      }
    }

    output += character;
  }

  return output;
}

export function parseSettingsJson(content: string): EnvSettings {
  return JSON.parse(stripTrailingCommas(stripJsonComments(content))) as EnvSettings;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeEnvValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

export function loadSettingsEnv({
  cwd,
  agentDir,
  environ = process.env,
}: SettingsEnvOptions): SettingsEnvResult {
  const settingsPaths = [
    join(agentDir, "settings.json"),
    join(cwd, ".pi", "settings.json"),
  ];
  const merged = new Map<string, string>();
  const warnings: string[] = [];
  let overrideExisting = false;

  for (const settingsPath of settingsPaths) {
    if (!existsSync(settingsPath)) continue;

    let settings: EnvSettings;
    try {
      settings = parseSettingsJson(readFileSync(settingsPath, "utf8"));
    } catch (error) {
      warnings.push(
        `无法解析 ${settingsPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }

    if (settings.envOverride !== undefined) {
      if (typeof settings.envOverride === "boolean") {
        overrideExisting = settings.envOverride;
      } else {
        warnings.push(`${settingsPath} 的 envOverride 必须是 boolean`);
      }
    }

    if (settings.env === undefined) continue;
    if (!isRecord(settings.env)) {
      warnings.push(`${settingsPath} 的 env 必须是对象`);
      continue;
    }

    for (const [name, rawValue] of Object.entries(settings.env)) {
      if (!name || name.includes("=") || name.includes("\0")) {
        warnings.push(`${settingsPath} 包含无效环境变量名 ${JSON.stringify(name)}`);
        continue;
      }

      const value = normalizeEnvValue(rawValue);
      if (value === undefined) {
        warnings.push(`${settingsPath} 中 env.${name} 必须是 string、number 或 boolean`);
        continue;
      }
      merged.set(name, value);
    }
  }

  const loaded: string[] = [];
  const skipped: string[] = [];
  for (const [name, value] of merged) {
    if (!overrideExisting && environ[name] !== undefined) {
      skipped.push(name);
      continue;
    }
    environ[name] = value;
    loaded.push(name);
  }

  return { loaded, skipped, warnings };
}
