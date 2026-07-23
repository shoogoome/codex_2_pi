import { describe, it } from "vitest";
import { htmlToMarkdown } from "./html.js";
function bench(name: string, s: string) {
  const t0 = Date.now();
  const out = htmlToMarkdown(s);
  const dt = Date.now() - t0;
  console.log(`${name}: inLen=${s.length} outLen=${out.length} ${dt}ms`);
}
describe("bench", () => {
  it("pathological", () => {
    const N = 2_000_000;
    bench("unterminated <!--", "<!--".repeat(N / 4));
    bench("many <", "<".repeat(N));
    bench("unterminated <pre>", "<pre>" + "x".repeat(N));
    bench("unterminated <a href=", '<a href="x'.repeat(N / 10));
    bench("nested divs", "<div>".repeat(N / 5));
    bench("many <a> pairs", '<a href="u">t</a>'.repeat(N / 17));
    bench("entity soup", "&#x10ffff;".repeat(N / 10));
  }, 60000);
});
