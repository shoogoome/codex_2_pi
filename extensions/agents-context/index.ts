/**
 * agents-context extension entry point. This is the ONLY file that touches the
 * pi ExtensionAPI; all real logic lives in ./src as pure, unit-tested helpers.
 *
 * What it does (net-new over pi's native context loading):
 *   session_start        -> discover + cache supplemental context files, reset latch
 *   tool_call            -> record read/edit/write target paths (touched set)
 *   before_agent_start   -> dedup against pi-loaded files, inject a display:false
 *                           message once (unconditional) + conditional rules on match
 *   session_compact      -> reset latch so the block is re-injected next turn
 *
 * The session state machine (discover -> touch -> dedup -> inject -> re-arm)
 * lives in ./src/session.ts as AgentsContextSession, unit-tested against an
 * in-memory filesystem; this file only binds it to node:fs and the pi event bus.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { AgentsContextSession, extractPiLoadedPaths } from "./src/session.js";
import type { FsLike } from "./src/types.js";

const FLAG = "agents-context";
const CUSTOM_TYPE = "agents-context";

/** node:fs-backed implementation of the FsLike surface used by src helpers. */
const realFs: FsLike = {
  readFile: (p) => readFileSync(p, "utf8"),
  exists: (p) => existsSync(p),
  readdir: (p) =>
    readdirSync(p, { withFileTypes: true }).map((d) => ({
      name: d.name,
      isDirectory: d.isDirectory(),
    })),
};

export default function agentsContextExtension(pi: ExtensionAPI): void {
  pi.registerFlag(FLAG, {
    type: "boolean",
    default: true,
    description:
      "Load supplemental AGENTS.md/CLAUDE.md context pi does not load natively (rules, @includes, conditional path rules, user + local layers).",
  });

  // Per-session state machine; rebuilt on every session_start.
  let session: AgentsContextSession | null = null;

  const enabled = (): boolean => {
    try {
      const v = pi.getFlag(FLAG);
      // default true: only disabled when explicitly false.
      if (v === false) return false;
      if (process.env.PI_AGENTS_CONTEXT === "0") return false;
      return true;
    } catch {
      return true;
    }
  };

  // session_start: discover + cache, reset all latches. Dedup can only happen
  // later (before_agent_start), so we cache everything now.
  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    if (!enabled()) {
      session = null;
      return;
    }
    try {
      const cwd = ctx.cwd ?? process.cwd();
      session = new AgentsContextSession({ fs: realFs, cwd, home: homedir() });
      session.start();
    } catch {
      session = null;
    }
  });

  // tool_call: track paths the model touches, to drive conditional rules.
  pi.on("tool_call", async (event, ctx: ExtensionContext) => {
    if (!enabled() || !session) return;
    if (
      event.toolName === "read" ||
      event.toolName === "edit" ||
      event.toolName === "write"
    ) {
      const input = event.input as { path?: unknown };
      if (typeof input.path === "string" && input.path.length > 0) {
        try {
          const cwd = ctx.cwd ?? process.cwd();
          session.touch(resolve(cwd, input.path));
        } catch {
          // ignore malformed paths
        }
      }
    }
  });

  // before_agent_start: this is where pi tells us what it already loaded, so we
  // dedup here and inject only the net-new supplemental block.
  pi.on("before_agent_start", async (event, _ctx: ExtensionContext) => {
    if (!enabled() || !session || !session.hasLayers()) return;
    try {
      const piLoadedPaths = extractPiLoadedPaths(event.systemPromptOptions);
      const content = session.build(piLoadedPaths);
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

  // session_compact: the compaction drops previously injected messages, so
  // reset the latch and let the next before_agent_start re-inject.
  pi.on("session_compact", async () => {
    session?.resetInjectionLatch();
  });

  // Optional: render the (hidden-by-default) injection block as plain text if
  // the host ever surfaces it.
  pi.registerMessageRenderer(CUSTOM_TYPE, (message) => {
    const content = typeof message.content === "string" ? message.content : "";
    if (!content.trim()) return undefined;
    return new Text(content);
  });
}
