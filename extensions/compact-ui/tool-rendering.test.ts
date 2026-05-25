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
    expect(render(renderCompactTextResult("1\n2\n3", { expanded: false, maxLines: 2 }, theme))).toEqual(["1", "2", "... (1 more line)"]);
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

describe("CompactText rendering", () => {
  it("renders multiline compact results as separate TUI lines", () => {
    expect(render(renderCompactTextResult("1\n2\n3", { expanded: false, maxLines: 2 }, theme))).toEqual(["1", "2", "... (1 more line)"]);
  });
});

describe("createCompactToolDefinition runtime tool lookup", () => {
  it("uses the runtime cwd tool when provided", async () => {
    const native = {
      name: "read",
      label: "Read",
      description: "Read a file",
      parameters: {},
      async execute() {
        return { content: [{ type: "text" as const, text: "bootstrap" }], details: { cwd: "bootstrap" } };
      },
    };

    const wrapped = createCompactToolDefinition(native, {
      renderCallSummary: () => "read file.txt",
      resultMode: "preview",
      getRuntimeTool(cwd) {
        return {
          ...native,
          async execute() {
            return { content: [{ type: "text" as const, text: cwd }], details: { cwd } };
          },
        };
      },
    });

    await expect(wrapped.execute("tool-1", {} as never, undefined, undefined, { cwd: "/tmp/project" } as never)).resolves.toEqual({
      content: [{ type: "text", text: "/tmp/project" }],
      details: { cwd: "/tmp/project" },
    });
  });
});
