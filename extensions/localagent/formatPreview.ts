// Shared truncate/preview helpers used by outputTranslator.ts and spawnLocalAgent.ts
// for emitting tasks/progress messages.
//
// Kept tiny on purpose — pure functions, no logger / no I/O.

const ARGS_PREVIEW_MAX = 60;
const RESULT_PREVIEW_MAX = 60;
const ERROR_PREVIEW_MAX = 100;

export function shorten(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "...";
}

export function previewJson(v: unknown, max: number): string {
  let s: string;
  try {
    s = JSON.stringify(v);
  } catch {
    s = String(v);
  }
  if (typeof s !== "string") s = String(s);
  return shorten(s, max);
}

export function previewToolStart(toolName: string, args: unknown): string {
  return `${toolName}(${previewJson(args, ARGS_PREVIEW_MAX)})`;
}

export function previewToolEnd(
  toolName: string,
  result: unknown,
  isError: boolean,
): string {
  if (isError) {
    return `[err] ${toolName}: ${shorten(String(result), ERROR_PREVIEW_MAX)}`;
  }
  return `[ok] ${toolName} → ${previewJson(result, RESULT_PREVIEW_MAX)}`;
}
