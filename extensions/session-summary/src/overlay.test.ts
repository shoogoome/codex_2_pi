import { visibleWidth } from "@earendil-works/pi-tui";
import { formatSummaryOverlayLines, SessionSummaryOverlay } from "./overlay.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

const entries = [
  { id: "1", role: "user" as const, summary: "第一个需求", createdAt: 1 },
  { id: "2", role: "agent" as const, summary: "第一次完成", createdAt: 2 },
  { id: "3", role: "user" as const, summary: "第二个需求", createdAt: 3, pending: true },
];

describe("session summary overlay", () => {
  it("renders a bordered fixed viewport that follows the newest summaries", () => {
    const lines = formatSummaryOverlayLines({
      modelLabel: "small/model",
      maxRows: 2,
      entries,
    }, theme, 80);

    expect(lines[0]).toMatch(/^╭─ .*summary · small\/model · 3 条.*╮$/);
    expect(lines[1]).toMatch(/^│.*AI.*第一次完成.*│$/);
    expect(lines[2]).toMatch(/^│.*第二个需求.*◌.*│$/);
    expect(lines[3]).toMatch(/^╰─ .*2-3\/3.*↑1.*Alt\+↑\/↓ 滚动.*╯$/);
    for (const line of lines) expect(visibleWidth(line)).toBe(80);
  });

  it("scrolls toward older rows and reports newer rows below the viewport", () => {
    const lines = formatSummaryOverlayLines({
      modelLabel: "small/model",
      maxRows: 2,
      entries,
    }, theme, 72, { scrollOffset: 1 });

    expect(lines[1]).toContain("第一个需求");
    expect(lines[2]).toContain("第一次完成");
    expect(lines[3]).toContain("1-2/3");
    expect(lines[3]).toContain("↓1");
  });

  it("renders title, role labels and summary text with the subdued dim color", () => {
    const calls: Array<{ color: string; text: string }> = [];
    const bold = vi.fn((text: string) => text);
    const recordingTheme = {
      fg: (color: string, text: string) => {
        calls.push({ color, text });
        return text;
      },
      bold,
    };
    formatSummaryOverlayLines({ modelLabel: "small/model", maxRows: 2, entries, error: "boom" }, recordingTheme, 80);

    expect(calls).toContainEqual(expect.objectContaining({ color: "dim", text: expect.stringContaining("summary") }));
    expect(calls).toContainEqual({ color: "dim", text: "第一次完成" });
    expect(calls).toContainEqual({ color: "dim", text: "第二个需求" });
    expect(calls.some((call) => ["accent", "success", "text", "warning"].includes(call.color))).toBe(false);
    expect(bold).not.toHaveBeenCalled();
  });

  it("keeps a historical window stable when new rows arrive, then scrolls back to latest", () => {
    let liveEntries = [...entries];
    const setWidget = vi.fn();
    const requestRender = vi.fn();
    const overlay = new SessionSummaryOverlay(() => ({
      entries: liveEntries,
      modelLabel: "small/model",
      maxRows: 2,
    }));
    overlay.setUI({ setWidget } as any);
    overlay.show();
    const component = setWidget.mock.calls[0][1]({ requestRender }, theme);

    overlay.scrollOlder();
    expect(component.render(72).join("\n")).toContain("第一个需求");

    const previousCount = liveEntries.length;
    liveEntries = [...liveEntries, { id: "4", role: "agent", summary: "第二次完成", createdAt: 4 }];
    overlay.onEntriesChanged(previousCount, liveEntries.length);
    const held = component.render(72).join("\n");
    expect(held).toContain("第一个需求");
    expect(held).not.toContain("第二次完成");

    overlay.scrollNewer(2);
    const latest = component.render(72).join("\n");
    expect(latest).toContain("第二个需求");
    expect(latest).toContain("第二次完成");
    expect(requestRender).toHaveBeenCalled();
  });

  it("keeps the empty state framed and never exceeds CJK terminal width", () => {
    const empty = formatSummaryOverlayLines({ entries: [], modelLabel: "随主模型", maxRows: 8 }, theme, 20);
    expect(empty).toHaveLength(3);
    expect(empty[0]).toMatch(/^╭.*╮$/);
    expect(empty[1]).toContain("等待首轮");
    expect(empty[2]).toMatch(/^╰.*╯$/);

    const narrow = formatSummaryOverlayLines({
      modelLabel: "很长的模型名称",
      maxRows: 8,
      entries: [{ id: "1", role: "user", summary: "中文内容".repeat(20), createdAt: 1 }],
    }, theme, 24);
    for (const line of narrow) expect(visibleWidth(line)).toBeLessThanOrEqual(24);
  });
});
