import {
  initTheme,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import activateClaudeUi from "./index.js";
import { CLAUDE_UI_FLAG } from "./src/constants.js";

interface RegisteredTool {
  name: string;
  renderShell?: string;
  parameters: unknown;
  execute: unknown;
  renderCall?: (args: unknown, theme: unknown, context: unknown) => unknown;
}

type EventHandler = (...args: unknown[]) => unknown;

function createFakeApi() {
  const tools: RegisteredTool[] = [];
  const events: string[] = [];
  const handlers = new Map<string, EventHandler>();
  const flags: Record<string, { type: string; default?: unknown }> = {};

  const api = {
    registerTool: vi.fn((tool: RegisteredTool) => {
      tools.push(tool);
    }),
    registerFlag: vi.fn((name: string, options: { type: string; default?: unknown }) => {
      flags[name] = options;
    }),
    getFlag: vi.fn((_name: string) => true),
    on: vi.fn((event: string, handler: EventHandler) => {
      events.push(event);
      handlers.set(event, handler);
    }),
    registerCommand: vi.fn(),
    registerShortcut: vi.fn(),
  };

  return { api, tools, events, handlers, flags };
}

function snapshotProperties(
  target: Record<string, unknown>,
  keys: string[],
): () => void {
  const descriptors = new Map(
    keys.map((key) => [key, Object.getOwnPropertyDescriptor(target, key)]),
  );

  return () => {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) {
        Object.defineProperty(target, key, descriptor);
      } else {
        delete target[key];
      }
    }
  };
}

describe("claude-ui extension activation", () => {
  it("registers the master flag defaulting to true", () => {
    const { api, flags } = createFakeApi();
    activateClaudeUi(api as never);
    expect(flags[CLAUDE_UI_FLAG]).toMatchObject({ type: "boolean", default: true });
  });

  it("overrides the seven built-in tools with a self render shell", () => {
    const { api, tools } = createFakeApi();
    activateClaudeUi(api as never);
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual(["bash", "edit", "find", "grep", "ls", "read", "write"]);
    for (const tool of tools) {
      expect(tool.renderShell).toBe("self");
      expect(typeof tool.execute).toBe("function");
      expect(tool.parameters).toBeTruthy();
    }
  });

  it("native Bash override keeps the Claude two-line command preview", () => {
    const { api, tools } = createFakeApi();
    activateClaudeUi(api as never);
    const bash = tools.find((tool) => tool.name === "bash")!;
    const component = bash.renderCall!(
      { command: "echo one\necho two\necho three" },
      {
        fg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      },
      { isPartial: true, cwd: process.cwd() },
    ) as { render(width: number): string[] };
    const output = component.render(200).join("\n");
    expect(output).toContain("echo one");
    expect(output).toContain("echo two");
    expect(output).not.toContain("echo three");
    expect(output).toContain("…");
  });

  it("subscribes to session_start and before_agent_start to (re)capture the theme", () => {
    const { api, events } = createFakeApi();
    activateClaudeUi(api as never);
    expect(events).toContain("session_start");
    expect(events).toContain("before_agent_start");
  });

  it("does not call a stale extension API while rendering after session replacement", async () => {
    const prototype = UserMessageComponent.prototype as unknown as Record<
      string,
      unknown
    >;
    const restore = snapshotProperties(prototype, [
      "render",
      "__piUserMessageOriginalRender",
      "__piClaudeUiUserPatched",
      "__piClaudeUiUserVersion",
    ]);
    const pristine = prototype.__piUserMessageOriginalRender;
    if (typeof pristine === "function") {
      prototype.render = pristine;
    }
    delete prototype.__piClaudeUiUserPatched;
    delete prototype.__piClaudeUiUserVersion;

    try {
      const { api, handlers } = createFakeApi();
      let stale = false;
      api.getFlag.mockImplementation(() => {
        if (stale) {
          throw new Error("stale extension API");
        }
        return true;
      });

      activateClaudeUi(api as never);
      const sessionStart = handlers.get("session_start");
      expect(sessionStart).toBeTypeOf("function");
      await sessionStart?.({}, {
        ui: {
          theme: {
            name: "test",
            fg: (_color: string, text: string) => text,
            bold: (text: string) => text,
            getBgAnsi: () => "",
          },
        },
      });
      expect(api.getFlag).toHaveBeenCalledTimes(1);

      stale = true;
      initTheme("dark", false);
      const identity = (text: string): string => text;
      const message = new UserMessageComponent("hello", {
        heading: identity,
        link: identity,
        linkUrl: identity,
        code: identity,
        codeBlock: identity,
        codeBlockBorder: identity,
        quote: identity,
        quoteBorder: identity,
        hr: identity,
        listBullet: identity,
        bold: identity,
        italic: identity,
        strikethrough: identity,
        underline: identity,
      });
      expect(() => message.render(40)).not.toThrow();
      expect(api.getFlag).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });
});
