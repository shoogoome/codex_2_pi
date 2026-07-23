import { describe, expect, it } from "vitest";
import { decodeEntities, htmlToMarkdown, looksLikeHtml } from "./html.js";

describe("decodeEntities", () => {
  it("decodes named and numeric entities without double-decoding", () => {
    expect(decodeEntities("a &amp; b")).toBe("a & b");
    expect(decodeEntities("&lt;div&gt;")).toBe("<div>");
    expect(decodeEntities("&quot;hi&quot; &#39;yo&#39;")).toBe('"hi" \'yo\'');
    expect(decodeEntities("&#x41;&#66;")).toBe("AB");
    expect(decodeEntities("a&nbsp;b")).toBe("a b");
  });
});

describe("htmlToMarkdown", () => {
  it("converts headings and paragraphs", () => {
    const md = htmlToMarkdown("<h1>Title</h1><p>Hello world</p>");
    expect(md).toContain("# Title");
    expect(md).toContain("Hello world");
  });

  it("converts links to markdown", () => {
    const md = htmlToMarkdown('<a href="https://x.com/a">click</a>');
    expect(md).toContain("[click](https://x.com/a)");
  });

  it("converts list items to bullets", () => {
    const md = htmlToMarkdown("<ul><li>one</li><li>two</li></ul>");
    expect(md).toContain("- one");
    expect(md).toContain("- two");
  });

  it("preserves preformatted code in a fence", () => {
    const md = htmlToMarkdown("<pre>const x = 1;\nconst y = 2;</pre>");
    expect(md).toContain("```");
    expect(md).toContain("const x = 1;");
  });

  it("converts emphasis and inline code", () => {
    const md = htmlToMarkdown("<p><strong>bold</strong> and <em>em</em> and <code>x()</code></p>");
    expect(md).toContain("**bold**");
    expect(md).toContain("*em*");
    expect(md).toContain("`x()`");
  });

  it("drops script and style content", () => {
    const md = htmlToMarkdown("<style>.a{color:red}</style><script>evil()</script><p>keep</p>");
    expect(md).not.toContain("evil");
    expect(md).not.toContain("color:red");
    expect(md).toContain("keep");
  });

  it("collapses excessive blank lines", () => {
    const md = htmlToMarkdown("<p>a</p><p></p><p></p><p>b</p>");
    expect(md).not.toMatch(/\n{3,}/);
  });
});

describe("looksLikeHtml", () => {
  it("detects html documents", () => {
    expect(looksLikeHtml("<!DOCTYPE html><html><body>x</body></html>")).toBe(true);
    expect(looksLikeHtml('{"json": true}')).toBe(false);
    expect(looksLikeHtml("plain text")).toBe(false);
  });
});
