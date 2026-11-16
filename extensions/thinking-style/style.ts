import type { MarkdownTransformer } from "@earendil-works/pi-coding-agent";

// Match SGR only; leave OSC links, Markdown, and unrelated control sequences alone.
const SGR = /(?:\x1b\[|\u009b)([0-9;:]*)m/g;

function cleanThinkingSgr(text: string, removeItalic: boolean): string {
  return text.replace(SGR, (sequence, parameters: string) => {
    const parts = parameters.split(";");
    const next: string[] = [];
    let changed = false;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      const code = Number(part.split(":")[0]);
      if (code === 38 || code === 48 || code === 58) {
        // Extended foreground/background/underline colors contain numeric
        // channels that must not be mistaken for standalone SGR attributes.
        let end = i;
        if (!part.includes(":")) {
          const mode = parts[i + 1];
          if (mode === "5") end = Math.min(parts.length - 1, i + 2);
          else if (mode === "2") end = Math.min(parts.length - 1, i + 4);
        }
        if (code === 48) {
          next.push("49");
          changed = true;
        } else {
          next.push(...parts.slice(i, end + 1));
        }
        i = end;
      } else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
        next.push("49");
        changed = true;
      } else if (code === 3 && removeItalic) {
        // screen/screen-256color define ESC[3m as standout, not italic.
        next.push("23");
        changed = true;
      } else if (code === 7) {
        next.push("27");
        changed = true;
      } else {
        next.push(part);
      }
    }
    return changed ? `\x1b[${next.join(";")}m` : sequence;
  });
}

/** Clean source content without changing its ordinary text attributes. */
export function transparentThinking(text: string): string {
  return cleanThinkingSgr(text, false);
}

/** Also remove renderer-generated italics, which can become a white standout band. */
export function transparentThinkingLine(text: string): string {
  return cleanThinkingSgr(text, true);
}

export const transformThinkingStyle: MarkdownTransformer = (markdown, context) =>
  context.messageType === "assistant-thinking" ? transparentThinking(markdown) : markdown;
