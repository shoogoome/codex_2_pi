import { visibleWidth } from "@earendil-works/pi-tui";
import { formatRepoBranchBoxLines, REPO_BRANCH_WIDGET_KEY, RepoBranchOverlay } from "./overlay.js";

describe("repo-branch overlay", () => {
  it("renders a compact right-aligned box instead of spanning the full terminal width", () => {
    const emptyLines = formatRepoBranchBoxLines({ records: [] }, undefined, 80);
    expect(emptyLines).toHaveLength(3);
    expect(emptyLines[0]).toContain("仓库分支 · 0");
    expect(emptyLines[1]).toContain("暂无记录");
    expect(emptyLines[0]!.startsWith(" ".repeat(40))).toBe(true);
    expect(emptyLines[0]!.endsWith("╮")).toBe(true);
    expect(emptyLines[2]!.endsWith("╯")).toBe(true);
    for (const line of emptyLines) expect(visibleWidth(line)).toBe(80);

    const lines = formatRepoBranchBoxLines({
      records: [
        { key: "/a/frontend", name: "frontend", path: "/a/frontend", branch: "feat/ui", updatedAt: 1 },
        { key: "/b/backend", name: "backend", path: "/b/backend", branch: "main", updatedAt: 2 },
      ],
    }, undefined, 100);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("仓库分支 · 2");
    expect(lines[1]).toContain("frontend");
    expect(lines[1]).toContain("feat/ui");
    expect(lines[2]).toContain("backend");
    expect(lines[2]).toContain("main");

    // Box stays compact and flush-right instead of stretching across all 100 columns.
    const boxLeftMargin = lines[0]!.indexOf("╭");
    expect(boxLeftMargin).toBeGreaterThan(60);
    expect(lines[1]!.indexOf("│")).toBe(boxLeftMargin);
    expect(lines[2]!.indexOf("│")).toBe(boxLeftMargin);
    expect(lines[3]!.indexOf("╰")).toBe(boxLeftMargin);
    expect(lines[0]!.endsWith("╮")).toBe(true);
    expect(lines[1]!.endsWith("│")).toBe(true);
    expect(lines[3]!.endsWith("╯")).toBe(true);
    for (const line of lines) expect(visibleWidth(line)).toBe(100);
  });

  it("caps visible rows by maxRows and obeys strict width constraints on narrow terminals", () => {
    const records = Array.from({ length: 8 }, (_, index) => ({
      key: `/work/repo-${index}`,
      name: `very-long-repository-name-${index}`,
      path: `/work/repo-${index}`,
      branch: `feature/long-branch-name-${index}`,
      updatedAt: index,
    }));

    const capped = formatRepoBranchBoxLines({ records, maxRows: 4 }, undefined, 36);
    // 1 top border + 4 rows + 1 bottom border
    expect(capped).toHaveLength(6);
    expect(capped[5]).toContain("还有 4 个");
    for (const line of capped) expect(visibleWidth(line)).toBeLessThanOrEqual(36);

    const tiny = formatRepoBranchBoxLines({ records }, undefined, 3);
    expect(tiny).toHaveLength(1);
    expect(visibleWidth(tiny[0]!)).toBeLessThanOrEqual(3);
  });

  it("mounts aboveEditor widget once, requests renders on updates, and cleans up on hide/dispose", () => {
    let records = [{ key: "/a", name: "repo-a", path: "/a", branch: "main", updatedAt: 1 }];
    const overlay = new RepoBranchOverlay(() => ({ records }));
    const requestRender = vi.fn();
    let mountedFactory: ((tui: any, theme: any) => any) | undefined;
    const setWidget = vi.fn((_key, factory) => {
      mountedFactory = factory;
    });
    const ui: any = { setWidget };

    overlay.setUI(ui);
    overlay.show();
    expect(setWidget).toHaveBeenCalledTimes(1);
    expect(setWidget).toHaveBeenCalledWith(REPO_BRANCH_WIDGET_KEY, expect.any(Function), { placement: "aboveEditor" });

    const component = mountedFactory!({ requestRender }, { fg: (_c: string, t: string) => t });
    expect(component.render(60).join("\n")).toContain("repo-a");

    records = [{ key: "/a", name: "repo-a", path: "/a", branch: "feat/x", updatedAt: 2 }];
    overlay.show();
    expect(setWidget).toHaveBeenCalledTimes(1);
    expect(requestRender).toHaveBeenCalledTimes(1);
    expect(component.render(60).join("\n")).toContain("feat/x");

    overlay.dispose();
    expect(setWidget).toHaveBeenLastCalledWith(REPO_BRANCH_WIDGET_KEY, undefined, { placement: "aboveEditor" });
  });
});
