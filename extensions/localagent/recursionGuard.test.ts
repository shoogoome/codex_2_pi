import { describe, it, expect } from "vitest";
import { isInForkChild } from "./recursionGuard.js";
import { FORK_BOILERPLATE_TAG } from "./boilerplate.js";

function userMsg(text: string): unknown {
  return { role: "user", content: [{ type: "text", text }] };
}

describe("isInForkChild", () => {
  it("空数组返回 false", () => {
    expect(isInForkChild([])).toBe(false);
  });

  it("没 boilerplate tag 的纯对话返回 false", () => {
    expect(
      isInForkChild([userMsg("hello"), userMsg("world")]),
    ).toBe(false);
  });

  it("user message 含 boilerplate tag 返回 true", () => {
    const msg = userMsg(`<${FORK_BOILERPLATE_TAG}>STOP</${FORK_BOILERPLATE_TAG}>\n\nDo X`);
    expect(isInForkChild([msg])).toBe(true);
  });

  it("assistant message 含 tag(罕见情况)返回 false — claude 原版只检 user", () => {
    const msg = { role: "assistant", content: [{ type: "text", text: `<${FORK_BOILERPLATE_TAG}>` }] };
    expect(isInForkChild([msg])).toBe(false);
  });

  it("content 是 string 不是数组也能识别", () => {
    expect(isInForkChild([{ role: "user", content: `<${FORK_BOILERPLATE_TAG}>` }])).toBe(true);
  });

  it("content 数组里多个 block,只要有一个 text block 含 tag 就 true", () => {
    expect(
      isInForkChild([
        {
          role: "user",
          content: [
            { type: "text", text: "前缀无关" },
            { type: "text", text: `<${FORK_BOILERPLATE_TAG}>` },
          ],
        },
      ]),
    ).toBe(true);
  });
});
