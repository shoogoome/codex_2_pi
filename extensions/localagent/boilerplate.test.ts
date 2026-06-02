import { describe, it, expect } from "vitest";
import {
  FORK_BOILERPLATE_TAG,
  FORK_PLACEHOLDER_RESULT,
  buildChildDirective,
} from "./boilerplate.js";

describe("FORK_BOILERPLATE_TAG", () => {
  it("是固定常量字符串", () => {
    expect(FORK_BOILERPLATE_TAG).toBe("fork_boilerplate");
  });
});

describe("FORK_PLACEHOLDER_RESULT", () => {
  it("是固定字符串(全 fork child 共享 → prompt cache 友好)", () => {
    expect(FORK_PLACEHOLDER_RESULT).toBe("Subagent forked — running in background");
  });
});

describe("buildChildDirective", () => {
  it("把 boilerplate 包到 prompt 前面", () => {
    const out = buildChildDirective("explore the auth module");
    expect(out).toContain(`<${FORK_BOILERPLATE_TAG}>`);
    expect(out).toContain(`</${FORK_BOILERPLATE_TAG}>`);
    expect(out).toContain("explore the auth module");
  });

  it("boilerplate 包含核心规则文字", () => {
    const out = buildChildDirective("hi");
    expect(out).toContain("STOP");
    expect(out).toContain("Do NOT spawn sub-agents");
    expect(out).toContain("Use your tools directly");
    expect(out).toContain("Begin your final response");
  });

  it("不同 prompt 拼出来除最后 prompt 部分外字节相同(cache 友好性)", () => {
    const a = buildChildDirective("AAA");
    const b = buildChildDirective("BBB");
    expect(a.slice(0, a.lastIndexOf("AAA"))).toBe(b.slice(0, b.lastIndexOf("BBB")));
  });
});
