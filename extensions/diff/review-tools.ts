import { isAbsolute, relative, resolve, sep } from "node:path";

export interface ReviewOperation {
  /** undefined = observe the whole worktree during this operation. */
  paths?: string[];
}

const PATH_TOOLS = new Set(["write", "edit", "cursor_write", "cursor_edit"]);
const WINDOW_TOOLS = new Set([
  "bash", "powershell", "task_bash", "async_bash", "task_agent", "spawn_agent",
  "team_create", "send_message", "teammate_interrupt", "apply_patch",
]);

/** Keep raw filenames intact; only their presentation is escaped by the panel. */
export function reviewRelativePath(root: string, cwd: string, file: string): string | undefined {
  const path = relative(root, resolve(cwd, file));
  if (!path || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) return undefined;
  return path.split(sep).join("/");
}

/** Explicit write paths avoid attributing unrelated concurrent editor writes. */
export function reviewOperationForTool(
  name: string,
  input: unknown,
  root: string,
  cwd: string,
): ReviewOperation | undefined {
  const tool = name.split(".").at(-1) ?? name;
  const params = input && typeof input === "object" ? input as Record<string, unknown> : {};
  if (PATH_TOOLS.has(tool)) {
    const file = params.path ?? params.file_path ?? params.filePath;
    if (typeof file !== "string") return undefined;
    const path = reviewRelativePath(root, cwd, file);
    return path === undefined ? undefined : { paths: [path] };
  }
  if (tool === "parallel" && Array.isArray(params.tool_uses)) {
    const operations = params.tool_uses.flatMap((entry: unknown) => {
      if (!entry || typeof entry !== "object") return [];
      const call = entry as Record<string, unknown>;
      if (typeof call.recipient_name !== "string") return [];
      const operation = reviewOperationForTool(call.recipient_name, call.parameters, root, cwd);
      return operation ? [operation] : [];
    });
    if (!operations.length) return undefined;
    return operations.some((operation) => !operation.paths)
      ? {}
      : { paths: [...new Set(operations.flatMap((operation) => operation.paths ?? []))] };
  }
  return WINDOW_TOOLS.has(tool) ? {} : undefined;
}
