/**
 * Structural theme shape used by the Claude UI renderers. The pi `Theme` class
 * (captured from `ctx.ui.theme`) is structurally compatible with this. Kept as
 * a narrow interface so pure helpers stay testable with light fakes.
 */
export interface ClaudeUiTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
  italic?(text: string): string;
  bg?(color: string, text: string): string;
  getBgAnsi?(color: string): string;
}
