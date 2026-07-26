/**
 * Registers frameless overrides for the built-in read/bash/edit/write/grep/
 * find/ls tools. Every override uses `renderShell: "self"` so the
 * ToolExecutionComponent uses its plain `selfRenderContainer` (no toolPending/
 * Success/Error background box). Execution is delegated to the cached built-in
 * tool factories; parameters/description/prompt metadata are carried over.
 */
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  keyHint,
  keyText,
  rawKeyHint,
  type EditToolDetails,
  type ExtensionAPI,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { FoldableText } from "./foldable-text.js";
import {
  buildResultLines,
  buildToolHead,
  prefixResultRows,
  resolveMaxLines,
  styledSegments,
  type FoldOptions,
  type SummarySegment,
  type ToolState,
} from "./tool-gutter.js";
import { renderEditDiff, renderWriteResult } from "./diff-render.js";
import { DEFAULT_MAX_ERROR_LINES, RESULT_PREFIX } from "./constants.js";
import type { ClaudeUiTheme } from "./theme-types.js";

interface BuiltInTools {
  read: ReturnType<typeof createReadTool>;
  grep: ReturnType<typeof createGrepTool>;
  find: ReturnType<typeof createFindTool>;
  ls: ReturnType<typeof createLsTool>;
  bash: ReturnType<typeof createBashTool>;
  edit: ReturnType<typeof createEditTool>;
  write: ReturnType<typeof createWriteTool>;
}

type BuiltInName = keyof BuiltInTools;

const builtInToolCache = new Map<string, BuiltInTools>();

function getBuiltInTools(cwd: string): BuiltInTools {
  let tools = builtInToolCache.get(cwd);
  if (!tools) {
    tools = {
      read: createReadTool(cwd),
      grep: createGrepTool(cwd),
      find: createFindTool(cwd),
      ls: createLsTool(cwd),
      bash: createBashTool(cwd),
      edit: createEditTool(cwd),
      write: createWriteTool(cwd),
    };
    builtInToolCache.set(cwd, tools);
  }
  return tools;
}

function cloneParameters<T>(parameters: T, seen = new WeakMap<object, unknown>()): T {
  if (parameters === null || typeof parameters !== "object") {
    return parameters;
  }
  if (seen.has(parameters)) {
    return seen.get(parameters) as T;
  }
  const clone = Array.isArray(parameters)
    ? []
    : Object.create(Object.getPrototypeOf(parameters));
  seen.set(parameters, clone);
  for (const key of Reflect.ownKeys(parameters)) {
    const descriptor = Object.getOwnPropertyDescriptor(parameters, key);
    if (!descriptor) {
      continue;
    }
    if ("value" in descriptor) {
      descriptor.value = cloneParameters(descriptor.value, seen);
    }
    Object.defineProperty(clone, key, descriptor);
  }
  return clone as T;
}

interface PromptMetadata {
  promptSnippet?: string;
  promptGuidelines?: string[];
}

function extractPromptMetadata(tool: unknown): PromptMetadata {
  const source = (tool && typeof tool === "object" ? tool : {}) as PromptMetadata;
  const promptSnippet =
    typeof source.promptSnippet === "string" && source.promptSnippet.trim().length > 0
      ? source.promptSnippet
      : undefined;
  const promptGuidelines = Array.isArray(source.promptGuidelines)
    ? source.promptGuidelines.filter(
        (item): item is string => typeof item === "string" && item.trim().length > 0,
      )
    : undefined;
  return {
    promptSnippet,
    promptGuidelines:
      promptGuidelines && promptGuidelines.length > 0 ? [...promptGuidelines] : undefined,
  };
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function getStringField(value: unknown, field: string): string | undefined {
  const raw = toRecord(value)[field];
  return typeof raw === "string" ? raw : undefined;
}

function getPathArg(value: unknown): string | undefined {
  return getStringField(value, "file_path") ?? getStringField(value, "path");
}

function shortenPath(inputPath: string | undefined): string {
  if (!inputPath) {
    return "";
  }
  const home = homedir();
  return inputPath.startsWith(home) ? `~${inputPath.slice(home.length)}` : inputPath;
}

/**
 * Claude's getDisplayPath: paths inside the cwd render relative to it;
 * outside paths fall back to ~-shortened absolute.
 */
function displayPath(inputPath: string | undefined, cwd: string): string {
  if (!inputPath) {
    return "";
  }
  const absolute = isAbsolute(inputPath) ? inputPath : resolve(cwd, inputPath);
  const rel = relative(cwd, absolute);
  if (rel === "") {
    return ".";
  }
  if (!rel.startsWith("..") && !isAbsolute(rel)) {
    return rel;
  }
  return shortenPath(absolute);
}

/** Strip pi's trailing model-facing notices ("\n\n[Showing lines …]" etc.). */
function stripTrailingNotices(text: string): string {
  return text.replace(/\n\n\[[^\]\n]*(?:\][^\[\n]*)*\]\s*$/, "");
}

/** Count the content lines of a read result (notices excluded). */
function countReadLines(text: string): number {
  const stripped = stripTrailingNotices(text.replace(/\r/g, ""));
  if (stripped.trim().length === 0) {
    return 0;
  }
  return stripped.split("\n").length;
}

/** Count grep match lines (`path:line: content`); context lines don't match. */
function countGrepMatches(text: string): number {
  const stripped = stripTrailingNotices(text.replace(/\r/g, ""));
  if (stripped.trim().length === 0 || stripped.trim() === "No matches found") {
    return 0;
  }
  const matches = stripped
    .split("\n")
    .filter((line) => /^.+?:\d+: /.test(line)).length;
  // Fall back to counting non-empty lines when the format is unexpected.
  return matches > 0
    ? matches
    : stripped.split("\n").filter((line) => line.trim().length > 0).length;
}

/** Count non-empty lines (find results are one path per line). */
function countNonEmptyLines(text: string): number {
  const stripped = stripTrailingNotices(text.replace(/\r/g, ""));
  return stripped.split("\n").filter((line) => line.trim().length > 0).length;
}

/** A single summary row with the ⎿ connector, e.g. `⎿  Read **245** lines`. */
function summaryComponent(
  segments: SummarySegment[],
  theme: ClaudeUiTheme,
): Component {
  const [row] = prefixResultRows([styledSegments(theme, segments)], theme);
  return new Text(row, 0, 0);
}

/** Bash command summary: full command, max 2 lines / 160 chars, then `…`. */
const MAX_COMMAND_DISPLAY_LINES = 2;
const MAX_COMMAND_DISPLAY_CHARS = 160;

function summarizeCommand(command: string): string {
  const normalized = command.replace(/\r/g, "");
  const lines = normalized.split("\n");
  if (lines.length <= MAX_COMMAND_DISPLAY_LINES &&
      normalized.length <= MAX_COMMAND_DISPLAY_CHARS) {
    return normalized.trim();
  }
  let truncated = lines.slice(0, MAX_COMMAND_DISPLAY_LINES).join("\n");
  if (truncated.length > MAX_COMMAND_DISPLAY_CHARS) {
    truncated = truncated.slice(0, MAX_COMMAND_DISPLAY_CHARS);
  }
  return `${truncated.trim()}…`;
}

function extractTextOutput(result: unknown): string {
  const content = toRecord(result).content;
  const blocks = Array.isArray(content) ? content : [];
  return blocks
    .filter(
      (block): block is { type: string; text: string } =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("\n");
}

function isErrorResult(result: unknown, isError: boolean | undefined): boolean {
  return isError === true || toRecord(result).isError === true;
}

/**
 * Resolve the "expand" hint suffix (e.g. "ctrl+o to expand"). Prefers pi's
 * keybinding-aware `keyHint`/`rawKeyHint` so the shown key tracks the user's
 * config; degrades to a literal string if the keybinding registry is
 * unavailable (e.g. very early render / tests).
 */
function resolveExpandHint(): string {
  try {
    const keys = keyText("app.tools.expand");
    if (keys.trim().length > 0) {
      return keyHint("app.tools.expand", "to expand");
    }
    return rawKeyHint("ctrl+o", "to expand");
  } catch {
    return "ctrl+o to expand";
  }
}

/** Compact a result by rendered terminal rows, not only literal newlines. */
function resultComponent(
  text: string,
  theme: ClaudeUiTheme,
  fold: FoldOptions = {},
): Component {
  // Build every logical row first; FoldableText then wraps at the actual
  // component width and applies the cap to visual terminal rows.
  const lines = buildResultLines(text, theme, { ...fold, expanded: true });
  if (lines.length === 0) {
    return new Text("", 0, 0);
  }
  return new FoldableText(lines.join("\n"), theme, fold);
}


/** Render error output in the error color with the ⎿ connector, folded by visual terminal rows. */
function errorComponent(text: string, theme: ClaudeUiTheme, fold: FoldOptions): Component {
  const styled = prefixResultRows(
    text.replace(/\r/g, "").split("\n").map((line) => theme.fg("error", line)),
    theme,
  );
  return new FoldableText(styled.join("\n"), theme, fold);
}

interface OverrideSpec {
  argSummary: (args: unknown, cwd: string) => string | undefined;
}

const OVERRIDES: Record<BuiltInName, OverrideSpec> = {
  read: {
    // Claude: the display path only (line ranges surface in verbose mode).
    argSummary: (args, cwd) => displayPath(getPathArg(args), cwd) || "...",
  },
  grep: {
    // Claude: `pattern: "…"` plus `path: "…"` when a scope was given.
    argSummary: (args, cwd) => {
      const pattern = getStringField(args, "pattern") ?? "";
      if (!pattern) {
        return undefined;
      }
      const parts = [`pattern: "${pattern}"`];
      const scope = getStringField(args, "path");
      if (scope && scope !== ".") {
        parts.push(`path: "${displayPath(scope, cwd)}"`);
      }
      return parts.join(", ");
    },
  },
  find: {
    argSummary: (args, cwd) => {
      const pattern = getStringField(args, "pattern") ?? "";
      if (!pattern) {
        return undefined;
      }
      const parts = [`pattern: "${pattern}"`];
      const scope = getStringField(args, "path");
      if (scope && scope !== ".") {
        parts.push(`path: "${displayPath(scope, cwd)}"`);
      }
      return parts.join(", ");
    },
  },
  ls: {
    argSummary: (args, cwd) => displayPath(getStringField(args, "path") || ".", cwd),
  },
  bash: {
    // Claude: the full command (2 lines / 160 chars max), not just line one.
    argSummary: (args) => {
      const command = getStringField(args, "command") ?? "";
      return command.trim().length > 0 ? summarizeCommand(command) : undefined;
    },
  },
  edit: {
    argSummary: (args, cwd) => displayPath(getPathArg(args), cwd) || "...",
  },
  write: {
    argSummary: (args, cwd) => displayPath(getPathArg(args), cwd) || "...",
  },
};

/** Claude's user-facing tool names (userFacingName in claude/tools/*). */
const DISPLAY_NAMES: Record<BuiltInName, string> = {
  read: "Read",
  grep: "Search", // GrepTool userFacingName
  find: "Search", // GlobTool userFacingName
  ls: "LS",
  bash: "Bash",
  edit: "Update", // FileEditTool userFacingName for existing files
  write: "Write",
};

export function registerToolOverrides(pi: ExtensionAPI, isEnabled: () => boolean): void {
  const bootstrap = getBuiltInTools(process.cwd());
  const names: BuiltInName[] = [
    "read",
    "grep",
    "find",
    "ls",
    "bash",
    "edit",
    "write",
  ];

  for (const name of names) {
    const builtIn = bootstrap[name];
    const spec = OVERRIDES[name];
    const promptMetadata = extractPromptMetadata(builtIn);
    const parameters = cloneParameters(
      (builtIn as { parameters: unknown }).parameters,
    ) as never;

    pi.registerTool({
      name,
      label: name,
      description: (builtIn as { description: string }).description,
      ...promptMetadata,
      parameters,
      renderShell: "self",
      prepareArguments: (builtIn as { prepareArguments?: (args: unknown) => never })
        .prepareArguments,
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        return getBuiltInTools(ctx.cwd)[name].execute(
          toolCallId,
          params as never,
          signal,
          onUpdate as never,
        );
      },
      renderCall(args, theme, context) {
        // pi re-invokes renderCall when the result lands, so the dot color
        // tracks the lifecycle like Claude's ToolUseLoader: dim while the
        // call is in flight, green on success, red on error.
        const state: ToolState =
          context?.isPartial !== false
            ? "pending"
            : context.isError
              ? "error"
              : "success";
        const head = buildToolHead(
          DISPLAY_NAMES[name],
          spec.argSummary(args, context?.cwd ?? process.cwd()),
          theme,
          state,
        );
        return new FoldableText(head, theme, {
          maxLines: 1,
          overflowMarker: "…",
        });
      },
      renderResult(
        result,
        options: ToolRenderResultOptions,
        theme,
        context,
      ) {
        if (!isEnabled()) {
          const text = extractTextOutput(result);
          return new Text(text ? theme.fg("toolOutput", text) : "", 0, 0);
        }

        if (options.isPartial) {
          const verb =
            name === "edit"
              ? "editing…"
              : name === "write"
                ? "writing…"
                : name === "bash"
                  ? "running…"
                  : `${name}…`;
          return new Text(theme.fg("dim", verb), 0, 0);
        }

        const errored = isErrorResult(result, context?.isError);
        const fallback = extractTextOutput(result);
        const cwd = context?.cwd ?? process.cwd();

        // Collapsed views fold with a "ctrl+o to expand" hint; expanded views
        // render everything. General output folds at the result cap (Claude
        // MAX_LINES_TO_SHOW=3); edit/write previews and error output fold at
        // 10 (Claude MAX_LINES_TO_RENDER / MAX_RENDERED_LINES).
        const limits = resolveMaxLines();
        const base: FoldOptions = options.expanded
          ? { expanded: true }
          : { expanded: false, expandHint: resolveExpandHint() };
        const resultFold: FoldOptions = { ...base, maxLines: limits.result };
        const diffFold: FoldOptions = { ...base, maxLines: limits.diff };
        const errorFold: FoldOptions = { ...base, maxLines: DEFAULT_MAX_ERROR_LINES };

        if (errored) {
          return errorComponent(fallback || `${name} failed.`, theme, errorFold);
        }

        if (name === "edit") {
          const details = result.details as EditToolDetails | undefined;
          return renderEditDiff(details?.diff, theme, fallback, diffFold);
        }
        if (name === "write") {
          const content = getStringField(context?.args, "content");
          const rawPath = getPathArg(context?.args);
          return renderWriteResult(
            content,
            displayPath(rawPath, cwd) || "...",
            rawPath,
            theme,
            fallback,
            diffFold,
          );
        }

        // Claude never echoes search/read content back — it shows a summary
        // row with a bold count: `Read 245 lines` / `Found 3 lines` /
        // `Found 12 files`.
        if (name === "read") {
          const hasImage =
            result &&
            typeof result === "object" &&
            Array.isArray((result as { content?: unknown[] }).content) &&
            (result as { content: Array<{ type?: unknown }> }).content.some(
              (block) => block?.type === "image",
            );
          if (hasImage) {
            return summaryComponent(["Read image"], theme);
          }
          const lineCount = countReadLines(fallback);
          return summaryComponent(
            ["Read ", { bold: String(lineCount) }, lineCount === 1 ? " line" : " lines"],
            theme,
          );
        }
        if (name === "grep") {
          const matches = countGrepMatches(fallback);
          return summaryComponent(
            ["Found ", { bold: String(matches) }, matches === 1 ? " line" : " lines"],
            theme,
          );
        }
        if (name === "find") {
          const files = countNonEmptyLines(fallback);
          return summaryComponent(
            ["Found ", { bold: String(files) }, files === 1 ? " file" : " files"],
            theme,
          );
        }

        if (name === "bash" && fallback.trim().length === 0) {
          // Claude BashToolResultMessage: dim `(No output)` when the command
          // produced nothing.
          return new Text(
            `${theme.fg("dim", RESULT_PREFIX)}${theme.fg("dim", "(No output)")}`,
            0,
            0,
          );
        }

        return resultComponent(fallback, theme, resultFold);
      },
    });
  }
}
