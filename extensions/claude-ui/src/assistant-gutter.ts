/**
 * Pure transform that prefixes assistant message lines with a ● gutter.
 *
 * The native `AssistantMessageComponent.render` produces lines where:
 *   - line[0] is a Spacer(1) blank line carrying an OSC 133 zone-start marker,
 *   - content lines come from a Markdown(paddingX=1) child,
 *   - the last line carries OSC 133 zone-end/final markers.
 *
 * We prefix the first visible line with "● " (dot gutter) and every subsequent
 * visible line with two spaces (hanging indent), leaving blank / control-only
 * lines untouched and preserving any leading control sequences at the true
 * start of the line.
 */
import { GLYPH_DOT, HANGING_INDENT } from "./constants.js";
import { isBlankLine, LEADING_CONTROL_PATTERN } from "./ansi.js";

export function applyAssistantGutter(
  lines: string[],
  dotFg: (text: string) => string,
): string[] {
  let placedDot = false;
  return lines.map((line) => {
    if (isBlankLine(line)) {
      return line;
    }
    const match = line.match(LEADING_CONTROL_PATTERN);
    const lead = match ? match[0] : "";
    const rest = line.slice(lead.length);
    if (!placedDot) {
      placedDot = true;
      return `${lead}${dotFg(`${GLYPH_DOT} `)}${rest}`;
    }
    return `${lead}${HANGING_INDENT}${rest}`;
  });
}
