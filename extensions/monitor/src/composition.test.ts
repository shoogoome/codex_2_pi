// extensions/monitor/src/composition.test.ts
import { describe, it, expect } from "vitest";
import {
  classifyMessages,
  composeReport,
  estimateChars,
  estimateStr,
  estimateSystemDomain,
} from "./composition.js";
import type { AnyMessage } from "./types.js";

describe("classifyMessages block-level splitting", () => {
  it("splits assistant text / thinking / toolCall separately (not merged)", () => {
    const msgs: AnyMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "x".repeat(40) }, // 10 tokens
          { type: "thinking", thinking: "y".repeat(80) }, // 20 tokens
          { type: "toolCall", name: "read", arguments: { path: "a" } }, // name+json
        ],
      },
    ];
    const b = classifyMessages(msgs);
    expect(b.assistantText).toBe(10);
    expect(b.thinking).toBe(20);
    // "read".length(4) + JSON.stringify({path:"a"}) length
    const argChars = JSON.stringify({ path: "a" }).length;
    expect(b.toolCall).toBe(estimateChars(4 + argChars));
  });

  it("classifies user string, tool results by name, images and summaries", () => {
    const msgs: AnyMessage[] = [
      { role: "user", content: "u".repeat(20) }, // 5 tokens
      {
        role: "toolResult",
        toolName: "Read",
        content: [{ type: "text", text: "r".repeat(400) }], // 100 tokens
      },
      {
        role: "toolResult",
        toolName: "Bash",
        content: [{ type: "text", text: "b".repeat(40) }, { type: "image", data: "..." }],
      },
      { role: "compactionSummary", summary: "s".repeat(40) }, // 10 tokens
      { role: "user", content: [{ type: "image", data: "z" }] },
    ];
    const b = classifyMessages(msgs);
    expect(b.user).toBe(5);
    expect(b.toolResultByName["Read"]).toBe(100);
    // Bash: 40 chars/4=10 tokens + 1 image(1200)
    expect(b.toolResultByName["Bash"]).toBe(10 + 1200);
    expect(b.summary).toBe(10);
    expect(b.imageCount).toBe(2);
    expect(b.image).toBe(2400);
  });
});

describe("estimateSystemDomain", () => {
  it("sums contextFiles / skills / tools and derives base", () => {
    const contextFileContent = "c".repeat(400); // ~100+ tokens with wrapper
    const systemPrompt = "p".repeat(4000); // 1000 tokens
    const sd = estimateSystemDomain({
      systemPrompt,
      contextFiles: [{ path: "dir/AGENTS.md", content: contextFileContent }],
      skills: [{ name: "s", description: "d" }],
      tools: [{ name: "read", description: "reads", parameters: { type: "object" } }],
    });
    expect(sd.contextFiles).toBeGreaterThan(0);
    expect(sd.tools).toBeGreaterThan(0);
    expect(sd.contextFileDetail[0].path).toBe("dir/AGENTS.md");
    // base = promptTokens - contextFiles - skills, clamped >= 0
    expect(sd.base).toBe(Math.max(0, estimateStr(systemPrompt) - sd.contextFiles - sd.skills));
    expect(sd.total).toBe(sd.base + sd.contextFiles + sd.skills + sd.tools);
  });
});

describe("composeReport residual bucket", () => {
  it("residual = promptTotal - sum(known); rows sum to 100%", () => {
    const b = classifyMessages([
      { role: "user", content: "u".repeat(400) }, // 100
    ]);
    const sd = { total: 200, base: 150, contextFiles: 0, contextFileDetail: [], skills: 0, tools: 50 };
    const report = composeReport(b, sd, 1000);
    expect(report.grounded).toBe(true);
    expect(report.total).toBe(1000);
    const sumRows = report.rows.reduce((s, r) => s + r.tokens, 0);
    expect(sumRows).toBe(1000); // residual makes it exact
    const sumPct = report.rows.reduce((s, r) => s + r.pct, 0);
    expect(sumPct).toBeCloseTo(100, 3);
    const residualRow = report.rows.find((r) => r.label === "residual(fmt)");
    expect(residualRow?.tokens).toBe(report.residual);
    expect(report.residual).toBeGreaterThanOrEqual(0);
  });

  it("clamps to sum-of-known when estimates overshoot ground truth", () => {
    const b = classifyMessages([{ role: "user", content: "u".repeat(4000) }]); // 1000
    const sd = { total: 500, base: 500, contextFiles: 0, contextFileDetail: [], skills: 0, tools: 0 };
    const report = composeReport(b, sd, 100); // promptTotal smaller than estimates
    expect(report.residual).toBe(0);
    expect(report.total).toBe(1000 + 500); // sumKnown
  });

  it("ungrounded when promptTotal is 0", () => {
    const b = classifyMessages([{ role: "user", content: "u".repeat(40) }]);
    const sd = { total: 0, base: 0, contextFiles: 0, contextFileDetail: [], skills: 0, tools: 0 };
    const report = composeReport(b, sd, 0);
    expect(report.grounded).toBe(false);
    expect(report.residual).toBe(0);
  });
});
