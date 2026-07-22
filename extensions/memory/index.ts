/**
 * memory extension entry point. This is the ONLY file that touches the pi
 * ExtensionAPI and node:fs; all real logic lives in ./src as pure, unit-tested
 * helpers over an injected FsLike.
 *
 * What it does:
 *   session_start        -> locate/create memory dir, load index + topics, arm latch
 *   before_agent_start   -> inject rules+index (once, re-armed after compaction)
 *                           + query-time recalled topic bodies (display:false)
 *   session_compact      -> reset latch so the index re-injects post-compaction
 *   /memory list|show|init, /remember <text>  -> user-facing commands
 *   turn_end / session_shutdown               -> documented no-op stubs (phase 2:
 *                           background fork extraction / autoDream — out of MVP)
 *
 * Division of labor: the harness injects the index + recall + rules and scaffolds
 * the dir; the MODEL maintains the memory files with ordinary write/edit.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { MemorySession } from "./src/session.js";
import {
  buildRememberPlan,
  entriesFromTopics,
  formatList,
  resolveShow,
} from "./src/commands.js";
import { buildIndex, defaultIndexTemplate, parseIndex } from "./src/index-md.js";
import { CUSTOM_TYPE, FLAG, type FsLike } from "./src/types.js";

/** node:fs-backed FsLike used by all src helpers. */
const realFs: FsLike = {
  readFile: (p) => readFileSync(p, "utf8"),
  writeFile: (p, c) => {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, c, "utf8");
  },
  mkdir: (p) => {
    mkdirSync(p, { recursive: true });
  },
  exists: (p) => existsSync(p),
  readdir: (p) =>
    readdirSync(p, { withFileTypes: true }).map((d) => ({
      name: d.name,
      isDirectory: d.isDirectory(),
    })),
};

export default function memoryExtension(pi: ExtensionAPI): void {
  pi.registerFlag(FLAG, {
    type: "boolean",
    default: true,
    description:
      "Claude-style long-term memory: inject a git-root-scoped MEMORY.md index + recalled topics, and expose /memory and /remember. Disable with --no-memory or PI_MEMORY=0.",
  });

  // Per-session state machine; rebuilt on every session_start.
  let session: MemorySession | null = null;

  const enabled = (): boolean => {
    try {
      if (pi.getFlag(FLAG) === false) return false;
      if (process.env.PI_MEMORY === "0") return false;
      return true;
    } catch {
      return true;
    }
  };

  const freshSession = (ctx: ExtensionContext): MemorySession => {
    const cwd = ctx.cwd ?? process.cwd();
    const s = new MemorySession({ fs: realFs, cwd, home: homedir() });
    s.start();
    return s;
  };

  // session_start: locate dir, load index + topics, arm the latch.
  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    if (!enabled()) {
      session = null;
      return;
    }
    try {
      session = freshSession(ctx);
    } catch {
      session = null;
    }
  });

  // before_agent_start: inject the memory block (rules+index once, recall each
  // turn) as a display:false CustomMessage. Never touches systemPrompt so we
  // compose cleanly with other extensions.
  pi.on("before_agent_start", async (event, _ctx: ExtensionContext) => {
    if (!enabled() || !session) return;
    try {
      const content = session.build(event.prompt ?? "");
      if (!content) return;
      return {
        message: {
          customType: CUSTOM_TYPE,
          content,
          display: false,
        },
      };
    } catch {
      return;
    }
  });

  // session_compact: compaction drops injected messages, so re-arm the latch to
  // force the index to re-inject on the next turn (spec ④).
  pi.on("session_compact", async () => {
    session?.resetInjectionLatch();
  });

  // --- phase-2 stubs (documented no-ops in MVP) -------------------------
  // Auto-extraction (fork a sub-agent to distill new memories) and idle
  // consolidation / autoDream are explicitly out of MVP scope. These handlers
  // are wired but intentionally inert — they must NOT fork sub-agents here.
  pi.on("turn_end", async () => {
    /* phase 2: background extraction — no-op in MVP. */
  });
  pi.on("session_shutdown", async () => {
    /* phase 2: end-of-session consolidation — no-op in MVP. */
  });

  // --- /memory list | show <name> | init -------------------------------
  pi.registerCommand("memory", {
    description: "Inspect long-term memory: /memory list | show <name> | init",
    getArgumentCompletions: (prefix) => {
      const subs = ["list", "show", "init"];
      const p = prefix.trim().toLowerCase();
      return subs
        .filter((s) => s.startsWith(p))
        .map((s) => ({ value: s, label: s }));
    },
    handler: async (args, ctx: ExtensionCommandContext) => {
      if (!enabled()) {
        ctx.ui.notify("Memory is disabled.", "warning");
        return;
      }
      const [sub, ...rest] = args.trim().split(/\s+/);
      const s = freshSession(ctx);
      const memoryDir = s.getMemoryDir();
      const entries = deriveEntries(s);

      const emit = (title: string, body: string): void => {
        if (ctx.hasUI) ctx.ui.notify(`${title}\n${body}`, "info");
        else ctx.ui.notify(`${title}: ${body.replace(/\n/g, " ")}`, "info");
      };

      switch ((sub || "list").toLowerCase()) {
        case "list": {
          emit("Memory topics", formatList(entries));
          return;
        }
        case "show": {
          const res = resolveShow(rest.join(" "), entries);
          if (!res.ok) {
            ctx.ui.notify(res.error, "warning");
            return;
          }
          const topic = s
            .getTopics()
            .find((t) => t.path.endsWith(res.path) || t.name === res.name);
          if (!topic) {
            ctx.ui.notify(`Could not read topic "${res.name}".`, "error");
            return;
          }
          emit(`Memory: ${topic.name} (${topic.type})`, topic.body.trim());
          return;
        }
        case "init": {
          try {
            realFs.mkdir(memoryDir);
            const indexPath = s.getIndexPath();
            if (!realFs.exists(indexPath)) {
              realFs.writeFile(indexPath, defaultIndexTemplate());
              ctx.ui.notify(`Initialized memory at ${memoryDir}`, "info");
            } else {
              ctx.ui.notify(`Memory already exists at ${memoryDir}`, "info");
            }
          } catch (err) {
            ctx.ui.notify(
              `Failed to init memory: ${(err as Error).message}`,
              "error",
            );
          }
          return;
        }
        default: {
          ctx.ui.notify(
            "Usage: /memory list | show <name> | init",
            "warning",
          );
        }
      }
    },
  });

  // --- /remember <text> -------------------------------------------------
  pi.registerCommand("remember", {
    description: "Append a timestamped fact to long-term memory (General notes).",
    handler: async (args, ctx: ExtensionCommandContext) => {
      if (!enabled()) {
        ctx.ui.notify("Memory is disabled.", "warning");
        return;
      }
      const text = args.trim();
      if (text === "") {
        ctx.ui.notify("Usage: /remember <text>", "warning");
        return;
      }
      // Guard mutation on idle so we never race the agent's own file writes.
      if (!ctx.isIdle()) {
        ctx.ui.notify("Busy — try /remember again once the agent is idle.", "warning");
        return;
      }
      try {
        const s = freshSession(ctx);
        const memoryDir = s.getMemoryDir();
        const plan = buildRememberPlan(text, s.getTopics(), memoryDir);
        realFs.writeFile(plan.path, plan.content);
        syncIndexAfterWrite(s, plan.entry.path, plan.entry, plan.isNew);
        ctx.ui.notify(
          plan.isNew
            ? `Remembered (new topic "${plan.entry.name}").`
            : `Remembered in "${plan.entry.name}".`,
          "info",
        );
      } catch (err) {
        ctx.ui.notify(
          `Failed to remember: ${(err as Error).message}`,
          "error",
        );
      }
    },
  });

  // Render the (hidden-by-default) injected block as plain text if the host
  // ever surfaces it (e.g. an expanded transcript view).
  pi.registerMessageRenderer(CUSTOM_TYPE, (message) => {
    const content = typeof message.content === "string" ? message.content : "";
    if (!content.trim()) return undefined;
    return new Text(content);
  });
}

/** Derive index entries for a loaded session (from MEMORY.md, else from topics). */
function deriveEntries(s: MemorySession) {
  const raw = s.getIndexRaw();
  const parsed = raw ? parseIndex(raw) : [];
  if (parsed.length > 0) return parsed;
  return entriesFromTopics(s.getTopics(), s.getMemoryDir());
}

/**
 * Keep MEMORY.md in sync after a topic write. Merges the (possibly new) entry
 * into the parsed index and rewrites the file. Best-effort: index drift is
 * recoverable by the model, so failures are swallowed by the caller's try.
 */
function syncIndexAfterWrite(
  s: MemorySession,
  relPath: string,
  entry: { name: string; description: string; type: import("./src/types.js").MemoryType; path: string },
  isNew: boolean,
): void {
  const indexPath = s.getIndexPath();
  const raw = s.getIndexRaw();
  const entries = raw ? parseIndex(raw) : [];
  const idx = entries.findIndex((e) => e.path === relPath);
  if (idx >= 0) {
    if (!isNew) return; // entry already present, description unchanged
    entries[idx] = entry;
  } else {
    entries.push(entry);
  }
  realFs.writeFile(indexPath, buildIndex(entries));
}
