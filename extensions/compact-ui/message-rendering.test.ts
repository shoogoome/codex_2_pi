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
      render(_width?: number) {
        return ["", "hello", "world", ""];
      },
    };

    patchUserMessagePrototype(prototype, () => theme);
    const output = prototype.render(12);

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
