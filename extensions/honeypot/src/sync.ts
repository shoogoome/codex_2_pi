import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { HONEYPOT_SOURCES } from "./sources.js";

export interface SyncResult {
  ok: boolean;
  dir: string;
  message: string;
}

function runGit(args: string[], cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

export async function syncJailbreakPrompts(targetDir: string, signal?: AbortSignal): Promise<SyncResult> {
  if (signal?.aborted) {
    return { ok: false, dir: targetDir, message: "aborted" };
  }

  const meta = HONEYPOT_SOURCES.find((s) => s.id === "jailbreak-prompts");
  const cloneUrl = meta?.cloneUrl;
  if (!cloneUrl) {
    return { ok: false, dir: targetDir, message: "missing clone URL" };
  }

  if (existsSync(targetDir)) {
    const pull = await runGit(["pull", "--ff-only"], targetDir);
    if (pull.code === 0) {
      return { ok: true, dir: targetDir, message: "updated (git pull)" };
    }
    return {
      ok: false,
      dir: targetDir,
      message: `git pull failed: ${pull.stderr.trim() || pull.stdout.trim()}`,
    };
  }

  const parent = targetDir.replace(/[/\\][^/\\]+$/, "");
  const clone = await runGit(["clone", "--depth", "1", cloneUrl, targetDir], parent);
  if (clone.code === 0) {
    return { ok: true, dir: targetDir, message: "cloned" };
  }
  return {
    ok: false,
    dir: targetDir,
    message: `git clone failed: ${clone.stderr.trim() || clone.stdout.trim()}`,
  };
}
