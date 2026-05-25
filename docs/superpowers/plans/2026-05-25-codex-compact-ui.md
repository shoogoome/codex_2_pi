# Codex Compact UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a package extension that makes Pi chat and common built-in tool rendering more compact in a Codex-inspired style.

**Architecture:** Create a new `extensions/compact-ui` package. The extension will patch Pi message component render methods for Codex-like user/assistant prefixes and register same-name built-in tool wrappers that delegate execution to Pi's native tools while replacing only call/result rendering.

**Tech Stack:** TypeScript ESM, Pi extension API from `@earendil-works/pi-coding-agent`, TUI components from `@earendil-works/pi-tui`, Vitest global APIs.

---

## File Structure

- Create `extensions/compact-ui/package.json`: package metadata for Pi auto-discovery.
- Create `extensions/compact-ui/text.ts`: ANSI-safe line helpers, visual width padding, prefixing, and text extraction utilities.
- Create `extensions/compact-ui/text.test.ts`: focused tests for line normalization and prefixing.
- Create `extensions/compact-ui/message-rendering.ts`: idempotent patchers for `UserMessageComponent` and `AssistantMessageComponent` prototypes.
- Create `extensions/compact-ui/message-rendering.test.ts`: tests with fake renderable objects and fake theme to verify Codex-style output/fallback behavior.
- Create `extensions/compact-ui/tool-rendering.ts`: compact built-in tool wrapper factory, native tool delegation, and compact renderers for `read`, `grep`, `find`, `ls`, `bash`, `edit`, and `write`.
- Create `extensions/compact-ui/tool-rendering.test.ts`: render-only tests for compact tool call/result summaries using lightweight fake tool definitions.
- Create `extensions/compact-ui/index.ts`: Pi extension entry point that applies message patches and registers compact tool wrappers.
- Modify `README.md`: document the new compact UI behavior and limitations.
- Modify root `package.json` only if needed. Current `pi.extensions: ["./extensions"]` already discovers `extensions/compact-ui`, so no manifest change should be necessary.

---

### Task 1: Text Helpers

**Files:**
- Create: `extensions/compact-ui/text.ts`
- Test: `extensions/compact-ui/text.test.ts`

- [ ] **Step 1: Write failing tests for Codex-style prefixing and blank trimming**

Create `extensions/compact-ui/text.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { prefixWrappedLines, trimVisualBlankEdges } from "./text.js";

const plainTheme = {
  fg(_color: string, text: string) {
    return text;
  },
  bold(text: string) {
    return text;
  },
};

describe("trimVisualBlankEdges", () => {
  it("removes leading and trailing blank lines while preserving interior blanks", () => {
    expect(trimVisualBlankEdges(["", "  ", "one", "", "two", "  "])).toEqual(["one", "", "two"]);
  });
});

describe("prefixWrappedLines", () => {
  it("uses an initial prefix for the first line and continuation prefix afterward", () => {
    const lines = prefixWrappedLines(["hello", "world"], {
      width: 12,
      initialPrefix: "› ",
      continuationPrefix: "  ",
      theme: plainTheme,
      prefixColor: "dim",
      contentColor: "userMessageText",
      backgroundColor: undefined,
    });

    expect(lines).toEqual(["› hello     ", "  world     "]);
  });

  it("returns one prefixed blank line for empty content", () => {
    const lines = prefixWrappedLines([], {
      width: 6,
      initialPrefix: "• ",
      continuationPrefix: "  ",
      theme: plainTheme,
      prefixColor: "dim",
      contentColor: undefined,
      backgroundColor: undefined,
    });

    expect(lines).toEqual(["•     "]);
  });
});
```

- [ ] **Step 2: Run tests and verify they fail because helper module is missing**

Run:

```bash
npm test -- extensions/compact-ui/text.test.ts
```

Expected: FAIL with module-not-found or missing export for `./text.js`.

- [ ] **Step 3: Implement text helpers**

Create `extensions/compact-ui/text.ts`:

```ts
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const SGR_ESCAPE_PATTERN = /\x1b\[[0-9;]*m/g;
const OSC_133_PATTERN = /\x1b\]133;[A-Z](?:;[^\x07\x1b]*)?(?:\x07|\x1b\\)/g;

export interface CompactThemeLike {
  fg(color: string, text: string): string;
  bg?(color: string, text: string): string;
  bold?(text: string): string;
}

export interface PrefixWrappedLinesOptions {
  width: number;
  initialPrefix: string;
  continuationPrefix: string;
  theme?: CompactThemeLike;
  prefixColor?: string;
  contentColor?: string;
  backgroundColor?: string;
}

function stripVisualControlSequences(text: string): string {
  return text.replace(OSC_133_PATTERN, "").replace(SGR_ESCAPE_PATTERN, "");
}

function isVisualBlank(line: string): boolean {
  return stripVisualControlSequences(line).trim().length === 0;
}

export function trimVisualBlankEdges(lines: string[]): string[] {
  let start = 0;
  while (start < lines.length && isVisualBlank(lines[start] ?? "")) start++;

  let end = lines.length;
  while (end > start && isVisualBlank(lines[end - 1] ?? "")) end--;

  return lines.slice(start, end);
}

function color(theme: CompactThemeLike | undefined, colorName: string | undefined, text: string): string {
  if (!theme || !colorName || text.length === 0) return text;
  try {
    return theme.fg(colorName, text);
  } catch {
    return text;
  }
}

function background(theme: CompactThemeLike | undefined, colorName: string | undefined, text: string): string {
  if (!theme || !colorName || text.length === 0) return text;
  try {
    return theme.bg ? theme.bg(colorName, text) : text;
  } catch {
    return text;
  }
}

function padToWidth(text: string, width: number): string {
  const visual = visibleWidth(text);
  return `${text}${" ".repeat(Math.max(0, width - visual))}`;
}

export function prefixWrappedLines(lines: string[], options: PrefixWrappedLinesOptions): string[] {
  const safeWidth = Math.max(1, Math.floor(options.width));
  const body = lines.length > 0 ? lines : [""];

  return body.map((line, index) => {
    const rawPrefix = index === 0 ? options.initialPrefix : options.continuationPrefix;
    const prefix = color(options.theme, options.prefixColor, options.theme?.bold ? options.theme.bold(rawPrefix) : rawPrefix);
    const prefixWidth = visibleWidth(rawPrefix);
    const contentWidth = Math.max(1, safeWidth - prefixWidth);
    const clipped = truncateToWidth(line, contentWidth, "", true);
    const styledContent = color(options.theme, options.contentColor, clipped);
    const padded = `${prefix}${styledContent}${" ".repeat(Math.max(0, contentWidth - visibleWidth(clipped)))}`;
    return background(options.theme, options.backgroundColor, padToWidth(padded, safeWidth));
  });
}
```

- [ ] **Step 4: Run tests and verify they pass**

Run:

```bash
npm test -- extensions/compact-ui/text.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit text helpers**

```bash
git add extensions/compact-ui/text.ts extensions/compact-ui/text.test.ts
git commit -m "feat: add compact UI text helpers"
```

---

### Task 2: Compact Message Rendering

**Files:**
- Create: `extensions/compact-ui/message-rendering.ts`
- Test: `extensions/compact-ui/message-rendering.test.ts`

- [ ] **Step 1: Write failing tests for idempotent message render patching**

Create `extensions/compact-ui/message-rendering.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { patchAssistantMessagePrototype, patchUserMessagePrototype } from "./message-rendering.js";

const theme = {
  fg(_color: string, text: string) {
    return text;
  },
  bg(_color: string, text: string) {
    return text;
  },
  bold(text: string) {
    return text;
  },
};

describe("patchUserMessagePrototype", () => {
  it("renders user messages with a Codex prompt prefix", () => {
    const prototype = {
      render() {
        return ["", "hello", "world", ""];
      },
    };

    patchUserMessagePrototype(prototype, () => theme);
    const output = prototype.render.call({}, 12);

    expect(output).toEqual(["› hello     ", "  world     "]);
  });

  it("is idempotent when applied multiple times", () => {
    const prototype = {
      render() {
        return ["hello"];
      },
    };

    patchUserMessagePrototype(prototype, () => theme);
    patchUserMessagePrototype(prototype, () => theme);

    expect(prototype.render.call({}, 10)).toEqual(["› hello   "]);
  });
});

describe("patchAssistantMessagePrototype", () => {
  it("renders assistant messages with a Codex bullet prefix", () => {
    const prototype = {
      render() {
        return ["", "answer", "line two"];
      },
    };

    patchAssistantMessagePrototype(prototype, () => theme);
    const output = prototype.render.call({}, 12);

    expect(output).toEqual(["• answer    ", "  line two  "]);
  });
});
```

- [ ] **Step 2: Run tests and verify they fail because module is missing**

Run:

```bash
npm test -- extensions/compact-ui/message-rendering.test.ts
```

Expected: FAIL with module-not-found or missing exports.

- [ ] **Step 3: Implement message rendering patchers**

Create `extensions/compact-ui/message-rendering.ts`:

```ts
import { prefixWrappedLines, trimVisualBlankEdges, type CompactThemeLike } from "./text.js";

export type RenderFn = (width: number) => string[];

export interface PatchableRenderPrototype {
  render: RenderFn;
  __codexCompactOriginalRender?: RenderFn;
  __codexCompactPatchKind?: "user" | "assistant";
  __codexCompactPatchVersion?: number;
}

const PATCH_VERSION = 1;

function patchPrototype(
  prototype: PatchableRenderPrototype,
  kind: "user" | "assistant",
  getTheme: () => CompactThemeLike | undefined,
): void {
  if (typeof prototype.render !== "function") return;
  if (prototype.__codexCompactPatchKind === kind && prototype.__codexCompactPatchVersion === PATCH_VERSION) return;

  if (!prototype.__codexCompactOriginalRender) {
    prototype.__codexCompactOriginalRender = prototype.render;
  }

  const original = prototype.__codexCompactOriginalRender;
  prototype.render = function compactRender(this: unknown, width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    let originalLines: string[];
    try {
      originalLines = original.call(this, safeWidth);
    } catch {
      return original.call(this, safeWidth);
    }

    const body = trimVisualBlankEdges(originalLines);
    const theme = getTheme();
    if (kind === "user") {
      return prefixWrappedLines(body, {
        width: safeWidth,
        initialPrefix: "› ",
        continuationPrefix: "  ",
        theme,
        prefixColor: "dim",
        contentColor: "userMessageText",
        backgroundColor: "userMessageBg",
      });
    }

    return prefixWrappedLines(body, {
      width: safeWidth,
      initialPrefix: "• ",
      continuationPrefix: "  ",
      theme,
      prefixColor: "dim",
      contentColor: undefined,
      backgroundColor: undefined,
    });
  };

  prototype.__codexCompactPatchKind = kind;
  prototype.__codexCompactPatchVersion = PATCH_VERSION;
}

export function patchUserMessagePrototype(
  prototype: PatchableRenderPrototype,
  getTheme: () => CompactThemeLike | undefined,
): void {
  patchPrototype(prototype, "user", getTheme);
}

export function patchAssistantMessagePrototype(
  prototype: PatchableRenderPrototype,
  getTheme: () => CompactThemeLike | undefined,
): void {
  patchPrototype(prototype, "assistant", getTheme);
}
```

- [ ] **Step 4: Run message tests**

Run:

```bash
npm test -- extensions/compact-ui/message-rendering.test.ts extensions/compact-ui/text.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit message rendering**

```bash
git add extensions/compact-ui/message-rendering.ts extensions/compact-ui/message-rendering.test.ts
git commit -m "feat: add codex-style message rendering"
```

---

### Task 3: Compact Tool Rendering Helpers and Wrapper Factory

**Files:**
- Create: `extensions/compact-ui/tool-rendering.ts`
- Test: `extensions/compact-ui/tool-rendering.test.ts`

- [ ] **Step 1: Write failing tests for compact tool renderers**

Create `extensions/compact-ui/tool-rendering.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { compactLines, createCompactToolDefinition, renderCompactCallLine, renderCompactTextResult } from "./tool-rendering.js";

const theme = {
  fg(_color: string, text: string) {
    return text;
  },
  bold(text: string) {
    return text;
  },
};

function render(component: { render(width: number): string[] }): string[] {
  return component.render(80);
}

describe("compactLines", () => {
  it("collapses consecutive empty lines", () => {
    expect(compactLines(["a", "", "", "b", "", ""])).toEqual(["a", "", "b", ""]);
  });
});

describe("renderCompactCallLine", () => {
  it("renders a single-line tool call summary", () => {
    expect(render(renderCompactCallLine("read", "src/index.ts", theme))).toEqual(["read src/index.ts"]);
  });
});

describe("renderCompactTextResult", () => {
  it("renders hidden output as a muted completion line", () => {
    expect(render(renderCompactTextResult("", { expanded: false, maxLines: 4 }, theme))).toEqual(["↳ (no output)"]);
  });

  it("limits collapsed output and shows a remaining hint", () => {
    expect(render(renderCompactTextResult("1\n2\n3", { expanded: false, maxLines: 2 }, theme))).toEqual(["1\n2\n... (1 more line)"]);
  });
});

describe("createCompactToolDefinition", () => {
  it("delegates execution to the native tool", async () => {
    const native = {
      name: "read",
      label: "Read",
      description: "Read a file",
      parameters: {},
      async execute(_id: string, params: { value: string }) {
        return { content: [{ type: "text" as const, text: params.value }], details: { ok: true } };
      },
    };

    const wrapped = createCompactToolDefinition(native, {
      renderCallSummary: () => "read file.txt",
      resultMode: "preview",
    });

    await expect(wrapped.execute("tool-1", { value: "ok" } as never, undefined, undefined, { cwd: process.cwd() } as never)).resolves.toEqual({
      content: [{ type: "text", text: "ok" }],
      details: { ok: true },
    });
  });
});
```

- [ ] **Step 2: Run tests and verify they fail because module is missing**

Run:

```bash
npm test -- extensions/compact-ui/tool-rendering.test.ts
```

Expected: FAIL with module-not-found or missing exports.

- [ ] **Step 3: Implement compact tool rendering helpers**

Create `extensions/compact-ui/tool-rendering.ts`:

```ts
import type { AgentToolResult, ToolDefinition, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

interface RenderThemeLike {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export type CompactResultMode = "hidden" | "summary" | "preview";

export interface CompactToolOptions {
  renderCallSummary(args: unknown): string;
  resultMode: CompactResultMode;
  maxCollapsedLines?: number;
}

export function compactLines(lines: string[]): string[] {
  const out: string[] = [];
  let previousBlank = false;
  for (const line of lines) {
    const blank = line.trim().length === 0;
    if (blank && previousBlank) continue;
    out.push(line);
    previousBlank = blank;
  }
  return out;
}

function pluralize(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}

function extractText(result: AgentToolResult<unknown>): string {
  return result.content
    .filter((entry): entry is { type: "text"; text: string } => entry.type === "text")
    .map((entry) => entry.text)
    .join("\n");
}

export function renderCompactCallLine(name: string, detail: string, theme: RenderThemeLike): Text {
  const title = theme.fg("toolTitle", theme.bold(name));
  const suffix = detail ? ` ${theme.fg("accent", detail)}` : "";
  return new Text(`${title}${suffix}`, 0, 0);
}

export function renderCompactTextResult(
  text: string,
  options: { expanded: boolean; maxLines: number },
  theme: RenderThemeLike,
): Text {
  const lines = compactLines(text.split("\n")).filter((line, index, array) => !(index === array.length - 1 && line === ""));
  if (lines.length === 0) {
    return new Text(theme.fg("muted", "↳ (no output)"), 0, 0);
  }

  const maxLines = options.expanded ? lines.length : Math.max(0, options.maxLines);
  const shown = lines.slice(0, maxLines);
  const remaining = lines.length - shown.length;
  let output = shown.join("\n");
  if (remaining > 0) {
    output += `\n${theme.fg("muted", `... (${remaining} more ${pluralize(remaining, "line")})`)}`;
  }
  return new Text(output, 0, 0);
}

function renderSummaryResult(result: AgentToolResult<unknown>, theme: RenderThemeLike): Text {
  const text = extractText(result);
  const lines = compactLines(text.split("\n")).filter((line) => line.trim().length > 0);
  return new Text(theme.fg("muted", `↳ ${lines.length} ${pluralize(lines.length, "line")} returned`), 0, 0);
}

export function createCompactToolDefinition<TParams extends Record<string, unknown>, TDetails>(
  nativeTool: ToolDefinition<any, TDetails>,
  options: CompactToolOptions,
): ToolDefinition<any, TDetails> {
  return {
    ...nativeTool,
    renderCall(args, theme) {
      const summary = options.renderCallSummary(args);
      return renderCompactCallLine(nativeTool.name, summary, theme as unknown as RenderThemeLike);
    },
    renderResult(result, renderOptions: ToolRenderResultOptions, theme) {
      if (renderOptions.isPartial) {
        return new Text(theme.fg("warning", `${nativeTool.name}...`), 0, 0);
      }

      if (options.resultMode === "hidden") {
        return new Text(theme.fg("muted", "↳ output hidden"), 0, 0);
      }
      if (options.resultMode === "summary") {
        return renderSummaryResult(result as AgentToolResult<unknown>, theme as unknown as RenderThemeLike);
      }
      return renderCompactTextResult(extractText(result as AgentToolResult<unknown>), {
        expanded: renderOptions.expanded,
        maxLines: options.maxCollapsedLines ?? 8,
      }, theme as unknown as RenderThemeLike);
    },
  };
}
```

- [ ] **Step 4: Run tool rendering tests**

Run:

```bash
npm test -- extensions/compact-ui/tool-rendering.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit tool rendering helpers**

```bash
git add extensions/compact-ui/tool-rendering.ts extensions/compact-ui/tool-rendering.test.ts
git commit -m "feat: add compact tool render helpers"
```

---

### Task 4: Extension Entry Point and Native Tool Registration

**Files:**
- Create: `extensions/compact-ui/index.ts`
- Create: `extensions/compact-ui/package.json`
- Test: `extensions/compact-ui/index.test.ts`

- [ ] **Step 1: Write failing test for extension registration**

Create `extensions/compact-ui/index.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import compactUiExtension from "./index.js";

describe("compactUiExtension", () => {
  it("registers compact built-in tool wrappers", () => {
    const tools: Array<{ name: string }> = [];
    const handlers: Record<string, Function> = {};
    const pi = {
      registerTool(tool: { name: string }) {
        tools.push(tool);
      },
      on(event: string, handler: Function) {
        handlers[event] = handler;
      },
    };

    compactUiExtension(pi as never);

    expect(tools.map((tool) => tool.name).sort()).toEqual(["bash", "edit", "find", "grep", "ls", "read", "write"]);
    expect(handlers.session_start).toBeTypeOf("function");
    expect(handlers.before_agent_start).toBeTypeOf("function");
  });
});
```

- [ ] **Step 2: Run the test and verify it fails because entry point is missing**

Run:

```bash
npm test -- extensions/compact-ui/index.test.ts
```

Expected: FAIL with module-not-found or missing default export.

- [ ] **Step 3: Implement compact-ui package metadata**

Create `extensions/compact-ui/package.json`:

```json
{
  "name": "pi-codex-compact-ui",
  "version": "0.1.0",
  "type": "module",
  "main": "./index.ts",
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*"
  }
}
```

- [ ] **Step 4: Implement extension entry point**

Create `extensions/compact-ui/index.ts`:

```ts
import {
  AssistantMessageComponent,
  UserMessageComponent,
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { patchAssistantMessagePrototype, patchUserMessagePrototype, type PatchableRenderPrototype } from "./message-rendering.js";
import { createCompactToolDefinition } from "./tool-rendering.js";

function pathArg(args: unknown): string {
  const record = args && typeof args === "object" ? args as Record<string, unknown> : {};
  const value = record.path ?? record.file_path;
  return typeof value === "string" && value.trim() ? value.trim() : ".";
}

function patternArg(args: unknown): string {
  const record = args && typeof args === "object" ? args as Record<string, unknown> : {};
  const value = record.pattern;
  return typeof value === "string" ? value : "...";
}

function registerCompactTool(pi: ExtensionAPI, nativeTool: ToolDefinition<any, any>, resultMode: "hidden" | "summary" | "preview", renderCallSummary: (args: unknown) => string): void {
  pi.registerTool(createCompactToolDefinition(nativeTool, {
    resultMode,
    maxCollapsedLines: nativeTool.name === "bash" ? 10 : 8,
    renderCallSummary,
  }));
}

function registerCompactTools(pi: ExtensionAPI, cwd: string): void {
  registerCompactTool(pi, createReadTool(cwd), "hidden", pathArg);
  registerCompactTool(pi, createGrepTool(cwd), "summary", (args) => `/${patternArg(args)}/ in ${pathArg(args)}`);
  registerCompactTool(pi, createFindTool(cwd), "summary", (args) => `${patternArg(args)} in ${pathArg(args)}`);
  registerCompactTool(pi, createLsTool(cwd), "summary", pathArg);
  registerCompactTool(pi, createBashTool(cwd), "preview", (args) => {
    const record = args && typeof args === "object" ? args as Record<string, unknown> : {};
    return typeof record.command === "string" ? record.command : "...";
  });
  registerCompactTool(pi, createEditTool(cwd), "summary", pathArg);
  registerCompactTool(pi, createWriteTool(cwd), "summary", pathArg);
}

export default function compactUiExtension(pi: ExtensionAPI) {
  let activeContext: ExtensionContext | undefined;
  const getTheme = () => activeContext?.ui.theme;

  patchUserMessagePrototype(UserMessageComponent.prototype as unknown as PatchableRenderPrototype, getTheme);
  patchAssistantMessagePrototype(AssistantMessageComponent.prototype as unknown as PatchableRenderPrototype, getTheme);

  registerCompactTools(pi, process.cwd());

  pi.on("session_start", (_event, ctx) => {
    activeContext = ctx;
    patchUserMessagePrototype(UserMessageComponent.prototype as unknown as PatchableRenderPrototype, getTheme);
    patchAssistantMessagePrototype(AssistantMessageComponent.prototype as unknown as PatchableRenderPrototype, getTheme);
  });

  pi.on("before_agent_start", (_event, ctx) => {
    activeContext = ctx;
    patchUserMessagePrototype(UserMessageComponent.prototype as unknown as PatchableRenderPrototype, getTheme);
    patchAssistantMessagePrototype(AssistantMessageComponent.prototype as unknown as PatchableRenderPrototype, getTheme);
  });
}
```

- [ ] **Step 5: Run extension tests**

Run:

```bash
npm test -- extensions/compact-ui/index.test.ts extensions/compact-ui/message-rendering.test.ts extensions/compact-ui/tool-rendering.test.ts extensions/compact-ui/text.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit extension entry point**

```bash
git add extensions/compact-ui/index.ts extensions/compact-ui/index.test.ts extensions/compact-ui/package.json
git commit -m "feat: register codex compact UI extension"
```

---

### Task 5: README and Full Verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add README documentation**

Modify `README.md` package table to include:

```markdown
| `extensions/compact-ui` | 添加 Codex 风格紧凑 UI：用户/模型消息前缀化，并让常见内置工具使用更短的调用与结果渲染。 |
```

Add a section after existing tool sections:

```markdown
## Compact UI

此包包含 Codex 风格紧凑 UI 扩展：

- 用户消息使用 `›` 前缀和主题 `userMessageBg` 背景，不再显示 Pi 默认的大气泡。
- 模型消息使用 `•` 前缀和后续行缩进，减少消息块间的视觉重量。
- `read`、`grep`、`find`、`ls`、`bash`、`edit` 和 `write` 使用紧凑渲染；执行逻辑仍委托给 Pi 原生工具。

紧凑间距不是 theme token 能力；该行为由 `extensions/compact-ui` 扩展实现。
```

- [ ] **Step 2: Verify README mentions compact-ui**

Run:

```bash
grep -n "compact-ui\|Compact UI" README.md
```

Expected: at least two matching lines.

- [ ] **Step 3: Run full tests**

Run:

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 4: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: `tsc --noEmit` exits 0.

- [ ] **Step 5: Check package resources**

Run:

```bash
node - <<'NODE'
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
if (!pkg.pi.extensions.includes('./extensions')) throw new Error('extensions directory not registered');
if (!pkg.pi.themes.includes('./themes')) throw new Error('themes directory not registered');
for (const file of ['extensions/compact-ui/package.json', 'themes/vague-codex.json']) {
  JSON.parse(fs.readFileSync(file, 'utf8'));
}
console.log('package resources valid');
NODE
```

Expected: `package resources valid`.

- [ ] **Step 6: Commit documentation**

```bash
git add README.md
git commit -m "docs: document compact UI extension"
```

---

## Self-Review

- Spec coverage: user message compacting is Task 2/4; assistant compacting is Task 2/4; built-in tool compacting is Task 3/4; package discovery is covered by current root manifest and Task 5 checks; docs are Task 5.
- Placeholder scan: no `TBD`, `TODO`, or unspecified "add tests" instructions remain.
- Type consistency: `CompactThemeLike`, `PatchableRenderPrototype`, `createCompactToolDefinition`, and `registerCompactTools` signatures are introduced before use and reused consistently.
