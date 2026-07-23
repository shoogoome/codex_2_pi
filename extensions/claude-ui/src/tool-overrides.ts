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
import { FoldableText } from "./foldable-text.js";
import { buildResultLines, buildToolHead, resolveMaxLines, type FoldOptions } from "./tool-gutter.js";
import { renderEditDiff, renderWriteDiff } from "./diff-render.js";
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

function getNumericField(value: unknown, field: string): number | undefined {
  const raw = toRecord(value)[field];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
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

/** Render error output in the error color, folded by visual terminal rows. */
function errorComponent(text: string, theme: ClaudeUiTheme, fold: FoldOptions): Component {
  const styled = text.replace(/\r/g, "").split("\n").map((line) => theme.fg("error", line));
  return new FoldableText(styled.join("\n"), theme, fold);
}

interface OverrideSpec {
  argSummary: (args: unknown, theme: ClaudeUiTheme) => string | undefined;
}

const OVERRIDES: Record<BuiltInName, OverrideSpec> = {
  read: {
    argSummary: (args) => {
      const path = shortenPath(getPathArg(args)) || "...";
      const offset = getNumericField(args, "offset");
      const limit = getNumericField(args, "limit");
      if (offset !== undefined || limit !== undefined) {
        const from = offset ?? 1;
        const to = limit !== undefined ? from + limit - 1 : undefined;
        return `${path}:${from}${to ? `-${to}` : ""}`;
      }
      return path;
    },
  },
  grep: {
    argSummary: (args) => {
      const pattern = getStringField(args, "pattern") ?? "";
      const scope = shortenPath(getStringField(args, "path") || ".");
      const glob = getStringField(args, "glob");
      return `/${pattern}/ in ${scope}${glob ? ` (${glob})` : ""}`;
    },
  },
  find: {
    argSummary: (args) => {
      const pattern = getStringField(args, "pattern") ?? "";
      const scope = shortenPath(getStringField(args, "path") || ".");
      return `${pattern} in ${scope}`;
    },
  },
  ls: {
    argSummary: (args) => shortenPath(getStringField(args, "path") || "."),
  },
  bash: {
    argSummary: (args) => {
      const command = getStringField(args, "command") ?? "";
      const firstLine = command.replace(/\r/g, "").split("\n")[0] ?? "";
      return firstLine.trim();
    },
  },
  edit: {
    argSummary: (args) => shortenPath(getPathArg(args)) || "...",
  },
  write: {
    argSummary: (args) => shortenPath(getPathArg(args)) || "...",
  },
};

const RESULT_HIDDEN: ReadonlySet<BuiltInName> = new Set(["read", "grep", "find", "ls"]);

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
      renderCall(args, theme) {
        const head = buildToolHead(name, spec.argSummary(args, theme), theme);
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

        // Collapsed views fold with a "ctrl+o to expand" hint; expanded views
        // render everything. General/error output folds at the result cap
        // (Claude MAX_LINES_TO_SHOW=3); edit/write diffs fold at the diff cap
        // (Claude MAX_LINES_TO_RENDER=10). Both caps are env-overridable.
        const limits = resolveMaxLines();
        const base: FoldOptions = options.expanded
          ? { expanded: true }
          : { expanded: false, expandHint: resolveExpandHint() };
        const resultFold: FoldOptions = { ...base, maxLines: limits.result };
        const diffFold: FoldOptions = { ...base, maxLines: limits.diff };

        if (errored) {
          return errorComponent(fallback || `${name} failed.`, theme, resultFold);
        }

        if (name === "edit") {
          const details = result.details as EditToolDetails | undefined;
          return renderEditDiff(details?.diff, theme, fallback, diffFold);
        }
        if (name === "write") {
          const content = getStringField(context?.args, "content");
          return renderWriteDiff(content, theme, fallback, diffFold);
        }

        if (RESULT_HIDDEN.has(name)) {
          // Search/read results are shown as a concise connector line only.
          const lineCount = fallback
            ? fallback.replace(/\r/g, "").split("\n").filter((l) => l.length > 0).length
            : 0;
          if (lineCount === 0) {
            return new Text("", 0, 0);
          }
          return resultComponent(fallback, theme, resultFold);
        }

        return resultComponent(fallback, theme, resultFold);
      },
    });
  }
}
