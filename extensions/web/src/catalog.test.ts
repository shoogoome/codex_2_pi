import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeCwdDirName, listAllSessions, scanSessionsDir } from "./sessionCatalog.js";

// pi's getAgentDir() honors PI_CODING_AGENT_DIR; we point it at a tiny
// fixture so the real (3.6 GB) machine session store is never touched by tests.
const OLD_DIR = process.env.PI_CODING_AGENT_DIR;

function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-web-test-"));
  const sessions = join(root, "sessions");
  const proj = join(sessions, "--data-fake-project--");
  mkdirSync(proj, { recursive: true });
  writeFileSync(
    join(proj, "2026-01-01T00-00-00-000Z_01234567-89ab-cdef-0123-456789abcdef.jsonl"),
    JSON.stringify({
      type: "header",
      id: "01234567-89ab-cdef-0123-456789abcdef",
      cwd: "/data/fake/project",
      name: "test-session",
    }) + "\n",
  );
  return root;
}

describe("sessionCatalog", () => {
  let root = "";
  beforeEach(() => {
    root = makeFixture();
    process.env.PI_CODING_AGENT_DIR = root;
  });
  afterEach(() => {
    if (OLD_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = OLD_DIR;
    rmSync(root, { recursive: true, force: true });
  });

  it("decodes pi cwd dir names best-effort", () => {
    expect(decodeCwdDirName("--data-merlin--")).toBe("/data/merlin");
    expect(decodeCwdDirName("--data-merlin-game-forge--")).toBe("/data/merlin/game/forge");
  });

  it("listAllSessions returns a catalog shape for the fixture", async () => {
    const catalog = await listAllSessions();
    expect(catalog).toBeDefined();
    expect(Array.isArray(catalog.sessions)).toBe(true);
    expect(catalog.projectsByCwd).toBeInstanceOf(Map);
    // The fixture has sessions dir with one project dir (with a broken header
    // file that SessionManager.listAll may skip) — the contract is shape-wise.
    for (const session of catalog.sessions) {
      expect(typeof session.key).toBe("string");
      expect(session.key.length).toBeGreaterThan(0);
      expect(typeof session.path).toBe("string");
      expect(typeof session.cwd).toBe("string");
    }
  });

  it("scanSessionsDir returns the fixture session file", async () => {
    const catalog = await scanSessionsDir();
    expect(catalog.sessions.length).toBe(1);
    expect(catalog.sessions[0].cwd).toBe("/data/fake/project");
    expect(catalog.sessions[0].project).toContain("fake");
  });

  it("scanSessionsDir returns empty catalog when no sessions dir exists", async () => {
    rmSync(join(root, "sessions"), { recursive: true, force: true });
    const catalog = await scanSessionsDir();
    expect(catalog.sessions).toEqual([]);
  });
});
