// Pure argument parsing + autocomplete for the /agents command.

export type AgentsSub = "list" | "show" | "use" | "";

export interface ParsedAgentsArgs {
  sub: AgentsSub;
  /** The role name argument for show/use, if present. */
  name?: string;
  /** The raw first token as typed (for "unknown subcommand" messages). */
  rawSub: string;
}

const KNOWN_SUBS = new Set<string>(["list", "show", "use"]);

/** Parse the raw argument string of `/agents ...` into a subcommand + name. */
export function parseAgentsArgs(args: string): ParsedAgentsArgs {
  const tokens = (args ?? "").trim().split(/\s+/).filter((t) => t.length > 0);
  const rawSub = tokens[0] ?? "";
  const sub = rawSub.toLowerCase();
  if (sub === "" || sub === "list") {
    return { sub: sub as AgentsSub, name: undefined, rawSub };
  }
  if (sub === "show" || sub === "use") {
    return { sub, name: tokens[1], rawSub };
  }
  return { sub: "", name: undefined, rawSub };
}

/** Minimal structural shape of a pi-tui AutocompleteItem (avoids importing it). */
export interface CompletionItem {
  value: string;
  label: string;
  description?: string;
}

/**
 * Autocomplete for `/agents`: complete sub-commands, then role names for
 * `show <name>` / `use <name>`. Filtered by the current argument prefix.
 */
export function completeAgentsArgs(roleNames: string[], prefix: string): CompletionItem[] {
  const raw = prefix ?? "";
  const spaceIdx = raw.indexOf(" ");

  if (spaceIdx >= 0) {
    const sub = raw.slice(0, spaceIdx).trim().toLowerCase();
    const nameToken = raw.slice(spaceIdx + 1).trimStart().toLowerCase();
    if (sub === "show" || sub === "use") {
      return roleNames
        .filter((n) => n.toLowerCase().startsWith(nameToken))
        .map((n) => ({ value: n, label: n, description: `${sub} role ${n}` }));
    }
    return [];
  }

  const lower = raw.trim().toLowerCase();
  const subs: CompletionItem[] = ["list", "show", "use"]
    .filter((s) => s.startsWith(lower))
    .map((s) => ({ value: s, label: s, description: `agents ${s}` }));
  return subs;
}

export { KNOWN_SUBS };
