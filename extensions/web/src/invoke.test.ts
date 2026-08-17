import { it, expect } from "vitest";
import { getFrontendHtml } from "./frontend.js";

it("served HTML actually invokes bootWebUi (not just declares it)", () => {
  const html = getFrontendHtml({ token: "", host: "0.0.0.0", port: 8600 });
  const i = html.indexOf("<script>") + "<script>".length;
  const j = html.lastIndexOf("</script>");
  const body = html.slice(i, j).trim();
  // Whole thing must be an IIFE call expression, not a bare declaration:
  expect(body.startsWith("(function bootWebUi() {")).toBe(true);
  expect(body.endsWith("();")).toBe(true);
  expect(body.includes("document.addEventListener")).toBe(true);
});
