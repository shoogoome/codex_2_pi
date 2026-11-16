import { patchThinkingStyle } from "./patch.js";

const ITALIC = "\x1b[2;3mthinking\x1b[23m";
const BODY = "\x1b[44mnormal \x1b[3mitalic\x1b[23m\x1b[49m";

describe("thinking component render patch", () => {
  function setup(mouseRegion: boolean) {
    const thinking = { defaultTextStyle: { italic: true }, render: vi.fn(() => [ITALIC]) };
    const body = { render: vi.fn(() => [BODY]) };
    const hidden = { text: "\x1b[3mThinking...\x1b[23m", render: vi.fn(() => ["\x1b[3mThinking...\x1b[23m"]) };
    const click = vi.fn();
    const region = { child: thinking, onMouse: click };
    const children = mouseRegion ? [region, body, { child: hidden }] : [thinking, body, hidden];
    const original = vi.fn();
    class Assistant {
      contentContainer = { children };
      hiddenThinkingLabel = "Thinking...";
      updateContent(message: unknown, streaming?: boolean) { original(message, streaming); }
    }
    return { Assistant, thinking, body, hidden, children, region, click, original };
  }

  it.each([true, false])("only wraps thinking and hidden labels (MouseRegion=%s)", (mouseRegion) => {
    const { Assistant, thinking, body, hidden, region, click, original } = setup(mouseRegion);
    patchThinkingStyle(Assistant.prototype);
    const assistant = new Assistant();
    const message = { content: "unchanged" };
    assistant.updateContent(message, true);
    expect(original).toHaveBeenCalledWith(message, true);
    expect(thinking.render()).toEqual(["\x1b[2;23mthinking\x1b[23m"]);
    expect(hidden.render()).toEqual(["\x1b[23mThinking...\x1b[23m"]);
    expect(body.render()).toEqual([BODY]);
    expect(region.child).toBe(thinking);
    expect(region.onMouse).toBe(click);
  });

  it("reinstalls from the native method without stacking wrappers on reload", () => {
    const { Assistant, thinking, original } = setup(true);
    const assistant = new Assistant();
    patchThinkingStyle(Assistant.prototype);
    assistant.updateContent({});
    const firstRender = thinking.render;
    patchThinkingStyle(Assistant.prototype);
    assistant.updateContent({});
    expect(original).toHaveBeenCalledTimes(2);
    expect(thinking.render).toBe(firstRender);
    expect(thinking.render()).toEqual(["\x1b[2;23mthinking\x1b[23m"]);
  });

  it("leaves unrelated wrapped Markdown, notices and unknown component shapes alone", () => {
    const ordinary = { defaultTextStyle: {}, render: () => [BODY] };
    const notice = { text: "Error", render: () => [ITALIC] };
    const wrappedBody = { child: ordinary };
    class Assistant {
      contentContainer = { children: [wrappedBody, notice, {}] };
      updateContent() {}
    }
    patchThinkingStyle(Assistant.prototype);
    const assistant = new Assistant();
    assistant.updateContent();
    expect(ordinary.render()).toEqual([BODY]);
    expect(notice.render()).toEqual([ITALIC]);
    const empty = { updateContent() {} };
    patchThinkingStyle(empty);
    expect(() => empty.updateContent()).not.toThrow();
  });
});
