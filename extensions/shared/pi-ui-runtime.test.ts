import { loadPiUiRuntime, resolvePresentationRenderers } from "./pi-ui-runtime.js";
import { AssistantMessageComponent, CustomEditor } from "@earendil-works/pi-coding-agent";
import { ScrollView } from "@earendil-works/pi-tui";

it("loads SDK and TUI from one explicit runtime instead of project resolution", async () => {
  const C = class {};
  const sdk = { AssistantMessageComponent: C, ToolExecutionComponent: C, UserMessageComponent: C, CustomEditor: C };
  const tui = { ScrollView: C };
  const imported: string[] = [];
  const runtime = await loadPiUiRuntime({
    entry: "/test/active/dist/index.js",
    resolveTui: (entry) => { expect(entry).toBe("/test/active/dist/index.js"); return "/test/active/node_modules/tui/index.js"; },
    importModule: async (entry) => { imported.push(entry); return entry.includes("node_modules") ? tui : sdk; },
  });
  expect(runtime.sdk.AssistantMessageComponent).toBe(C);
  expect(imported).toEqual(["file:///test/active/dist/index.js", "file:///test/active/node_modules/tui/index.js"]);
});

it("keeps custom renderers and passes unknown tools to the native generic fallback", () => {
  const builtIn = vi.fn((name, definition) => ({ name, ...definition }));
  const custom = { renderCall: vi.fn() };
  const runtime = { builtIn } as never;
  expect(resolvePresentationRenderers(runtime, "read", () => custom)).toEqual({ name: "read", ...custom });
  expect(resolvePresentationRenderers(runtime, "unknown")).toEqual({ name: "unknown" });
});

it("rejects unsupported runtime capabilities explicitly", async () => {
  await expect(loadPiUiRuntime({ entry: "/test/active/dist/index.js", resolveTui: () => "/test/tui.js", importModule: async () => ({}) })).rejects.toThrow(/缺少/);
});


it("uses the host-mapped UI graph by default so active skin patches are preserved", async () => {
  const runtime = await loadPiUiRuntime();
  expect(runtime.sdk.AssistantMessageComponent).toBe(AssistantMessageComponent);
  expect(runtime.sdk.CustomEditor).toBe(CustomEditor);
  expect(runtime.tui.ScrollView).toBe(ScrollView);
});
