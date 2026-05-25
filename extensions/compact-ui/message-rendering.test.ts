import { describe, expect, it } from "vitest";
import { extractMarkdownText, patchAssistantMessagePrototype, patchUserMessagePrototype } from "./message-rendering.js";

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

describe("extractMarkdownText", () => {
  it("finds nested markdown text stored by Pi Markdown components", () => {
    const instance = {
      children: [
        {
          children: [
            { text: "**hello**\nworld" },
          ],
        },
      ],
    };

    expect(extractMarkdownText(instance)).toBe("**hello**\nworld");
  });
});

describe("patchUserMessagePrototype", () => {
  it("renders user messages from nested markdown text instead of original padded box output", () => {
    const prototype = {
      render(_width?: number) {
        return ["original padded box"];
      },
    };
    const instance = {
      children: [{ children: [{ text: "hello\nworld" }] }],
    };

    patchUserMessagePrototype(prototype, () => theme);
    const output = prototype.render.call(instance, 12);

    expect(output).toEqual(["› hello     ", "  world     "]);
  });

  it("is idempotent when applied multiple times", () => {
    const prototype = {
      render(_width?: number) {
        return ["hello"];
      },
    };

    patchUserMessagePrototype(prototype, () => theme);
    patchUserMessagePrototype(prototype, () => theme);

    expect(prototype.render(10)).toEqual(["› hello   "]);
  });
});

describe("patchAssistantMessagePrototype", () => {
  it("renders assistant messages with a Codex bullet prefix", () => {
    const prototype = {
      render(_width?: number) {
        return ["", "answer", "line two"];
      },
    };

    patchAssistantMessagePrototype(prototype, () => theme);
    const output = prototype.render(12);

    expect(output).toEqual(["• answer    ", "  line two  "]);
  });
});
