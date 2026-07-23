/**
 * Zero-dependency HTML → Markdown converter.
 *
 * Deliberately lightweight: no turndown / DOM library, so the extension bundle
 * stays tiny and has no external runtime deps (avoids packaging risk in the pi
 * extension loader). It is a best-effort transform that handles the common
 * structural tags. It is NOT a spec-compliant HTML parser and does not try to be
 * — the goal is readable markdown for an LLM, not fidelity.
 *
 * SECURITY: the conversion is a strict SINGLE LEFT-TO-RIGHT PASS and every scan
 * is linear in the input length. An earlier regex-pipeline version had
 * catastrophic backtracking (`<!--`…, bare `<`…, `<a href="`… with no close all
 * ran in O(n²) or worse), which let a hostile or merely malformed page freeze
 * the agent's event loop for tens of seconds on a body up to the 10 MB fetch
 * cap. Do not reintroduce global regexes with `[\s\S]*?</tag>` / `[^>]*>` shapes
 * over untrusted input here.
 */

/** Turn a code point into a string, ignoring out-of-range / invalid values. */
function safeFromCodePoint(cp: number): string {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return "";
  try {
    return String.fromCodePoint(cp);
  } catch {
    return "";
  }
}

/** Decode the handful of HTML entities that actually matter for readable text. */
export function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => safeFromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => safeFromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&"); // ampersand last so we never double-decode
}

/**
 * Remove every `<...>` tag in one linear pass, keeping the text between them. A
 * trailing unclosed `<` (e.g. a literal "a < b") is preserved as text rather
 * than swallowing the remainder of the string.
 */
function stripTags(html: string): string {
  const out: string[] = [];
  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      out.push(html.slice(i));
      break;
    }
    if (lt > i) out.push(html.slice(i, lt));
    const gt = html.indexOf(">", lt + 1);
    if (gt === -1) {
      out.push(html.slice(lt)); // no close: keep remainder as literal text
      break;
    }
    i = gt + 1;
  }
  return out.join("");
}

/** Elements whose entire contents are dropped (never useful as prose). */
const RAW_ELEMENTS = new Set(["script", "style", "noscript", "head", "svg", "iframe", "template"]);
/** Block-level tags: an opening tag starts a new line. */
const BLOCK_OPEN = new Set(["p", "div", "section", "article", "ul", "ol", "table", "tr", "header", "footer", "nav", "blockquote"]);
/** Block-level tags: a closing tag inserts a blank line. */
const BLOCK_CLOSE = new Set([...BLOCK_OPEN, "h1", "h2", "h3", "h4", "h5", "h6"]);

/**
 * Find the closing `</name>` for `name` starting at `from`, using a precomputed
 * lowercased view. Returns the index just PAST the `>` and the index of the `<`,
 * or null if there is no close. Once a close is proven absent it never reappears
 * further right, so callers memoise the miss (see {@link convert}) to keep the
 * whole conversion linear even for pathological `<tag><tag>…` with no closes.
 */
function findClose(lower: string, name: string, from: number): { start: number; end: number } | null {
  const needle = `</${name}`;
  let i = from;
  for (;;) {
    const at = lower.indexOf(needle, i);
    if (at === -1) return null;
    const after = lower[at + needle.length];
    // Boundary: `</a>` or `</a >` but not `</abbr>`.
    if (after === ">" || after === " " || after === "\t" || after === "\n" || after === "\r" || after === "\f" || after === "/") {
      const gt = lower.indexOf(">", at + needle.length);
      if (gt === -1) return null;
      return { start: at, end: gt + 1 };
    }
    i = at + needle.length;
  }
}

/** Extract a quoted href value from a single opening `<a …>` tag, or null. */
function extractHref(openTag: string): string | null {
  const m = /href\s*=\s*(["'])(.*?)\1/i.exec(openTag); // safe: bounded to one tag
  return m ? m[2]!.trim() : null;
}

/**
 * Convert HTML to markdown in a single linear pass. Handled: comment / raw-element
 * removal, h1–h6, p/div/section… block breaks, a[href] → [text](url), strong/b →
 * **, em/i → *, ul/ol li → "- ", pre → fenced code, inline code → backticks, br →
 * newline. Everything else is flattened to its text content.
 */
function convert(s: string): string {
  const lower = s.toLowerCase();
  const out: string[] = [];
  // Tag names for which a closing tag has been proven absent from here on.
  const exhausted = new Set<string>();
  let i = 0;
  const n = s.length;

  /** Locate the close for a paired tag, memoising misses to stay linear. */
  const close = (name: string, from: number): { start: number; end: number } | null => {
    if (exhausted.has(name)) return null;
    const found = findClose(lower, name, from);
    if (!found) exhausted.add(name);
    return found;
  };

  while (i < n) {
    const lt = s.indexOf("<", i);
    if (lt === -1) {
      out.push(s.slice(i));
      break;
    }
    if (lt > i) out.push(s.slice(i, lt)); // text run

    // HTML comment.
    if (s.startsWith("<!--", lt)) {
      const end = s.indexOf("-->", lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }

    const gt = s.indexOf(">", lt + 1);
    if (gt === -1) {
      // A stray '<' with no closing '>': keep the remainder as literal text.
      out.push(s.slice(lt));
      break;
    }

    const tag = s.slice(lt, gt + 1);
    const nameMatch = /^<\/?\s*([a-zA-Z][a-zA-Z0-9]*)/.exec(tag); // safe: bounded to one tag
    const isClose = tag[1] === "/";
    const name = nameMatch ? nameMatch[1]!.toLowerCase() : "";
    const contentStart = gt + 1;

    if (name === "") {
      i = contentStart; // `<!doctype …>`, `<?…>` and other non-element tags → drop
      continue;
    }

    if (!isClose && RAW_ELEMENTS.has(name)) {
      const c = close(name, contentStart);
      i = c ? c.end : contentStart; // drop the whole element; unclosed → drop just the open tag
      continue;
    }

    if (!isClose && name === "pre") {
      const c = close("pre", contentStart);
      if (c) {
        const code = stripTags(s.slice(contentStart, c.start)).replace(/^\n+|\n+$/g, "");
        out.push(`\n\n\`\`\`\n${code}\n\`\`\`\n\n`);
        i = c.end;
      } else {
        i = contentStart;
      }
      continue;
    }

    if (!isClose && /^h[1-6]$/.test(name)) {
      const c = close(name, contentStart);
      if (c) {
        const hashes = "#".repeat(Number(name[1]));
        out.push(`\n\n${hashes} ${stripTags(s.slice(contentStart, c.start)).trim()}\n\n`);
        i = c.end;
      } else {
        i = contentStart;
      }
      continue;
    }

    if (!isClose && name === "a") {
      const c = close("a", contentStart);
      if (c) {
        const href = extractHref(tag);
        const text = stripTags(s.slice(contentStart, c.start)).trim();
        if (href !== null) out.push(text ? `[${text}](${href})` : href);
        else out.push(text);
        i = c.end;
      } else {
        i = contentStart;
      }
      continue;
    }

    if (!isClose && (name === "strong" || name === "b" || name === "em" || name === "i" || name === "code")) {
      const c = close(name, contentStart);
      if (c) {
        const inner = stripTags(s.slice(contentStart, c.start)).trim();
        const wrapped =
          name === "code" ? `\`${inner}\`` : name === "strong" || name === "b" ? `**${inner}**` : `*${inner}*`;
        out.push(wrapped);
        i = c.end;
      } else {
        i = contentStart;
      }
      continue;
    }

    if (!isClose && name === "li") {
      const c = close("li", contentStart);
      if (c) {
        out.push(`\n- ${stripTags(s.slice(contentStart, c.start)).trim()}`);
        i = c.end;
      } else {
        i = contentStart;
      }
      continue;
    }

    if (name === "br") {
      out.push("\n");
      i = contentStart;
      continue;
    }

    if (isClose && BLOCK_CLOSE.has(name)) {
      out.push("\n\n");
      i = contentStart;
      continue;
    }
    if (!isClose && BLOCK_OPEN.has(name)) {
      out.push("\n");
      i = contentStart;
      continue;
    }

    // Any other tag is dropped, its text (if any) already/again flows through.
    i = contentStart;
  }

  return out.join("");
}

/**
 * Convert an HTML document/fragment into Markdown text. Whitespace is normalised
 * (trailing spaces trimmed, runs of ≥3 blank lines collapsed to one).
 */
export function htmlToMarkdown(html: string): string {
  let s = convert(html);
  s = decodeEntities(s);
  s = s.replace(/[ \t]+\n/g, "\n"); // trailing spaces
  s = s.replace(/\n{3,}/g, "\n\n"); // collapse blank runs
  return s.trim();
}

/** Cheap heuristic: does this text look like HTML when no content-type is given? */
export function looksLikeHtml(text: string): boolean {
  const head = text.slice(0, 1024).toLowerCase();
  return /<!doctype html|<html[\s>]|<head[\s>]|<body[\s>]/.test(head);
}
