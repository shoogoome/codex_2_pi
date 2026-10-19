import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { dotsAccountProfilePath, loadDotsAccountProfile, saveDotsAccountProfile, validateDotsAccountProfile } from "./dotsAccountProfile.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function root() {
  const value = await mkdtemp(join(tmpdir(), "pi-dots-profile-")); roots.push(value); return value;
}

describe("dots account profile", () => {
  it("has one shared optional connection and persists credentials privately", async () => {
    const agentDir = await root();
    expect(await loadDotsAccountProfile(agentDir)).toBeUndefined();
    await saveDotsAccountProfile(agentDir, { gatewayUrl: "https://dots.example:23457/", deviceToken: "device-secret" });
    expect(await loadDotsAccountProfile(agentDir)).toEqual({ gatewayUrl: "https://dots.example:23457", deviceToken: "device-secret" });
    const filename = dotsAccountProfilePath(agentDir);
    expect((await stat(filename)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(filename))).mode & 0o777).toBe(0o700);
    expect(await readFile(filename, "utf8")).toContain("device-secret");
    await saveDotsAccountProfile(agentDir, { gatewayUrl: "https://dots.example", deviceToken: "new-secret" });
    expect((await loadDotsAccountProfile(agentDir))?.deviceToken).toBe("new-secret");
  });

  it("allows HTTP only to localhost development endpoints", () => {
    for (const gatewayUrl of ["http://localhost:14319", "http://127.0.0.1:14319", "http://[::1]:14319"]) {
      expect(validateDotsAccountProfile({ gatewayUrl, deviceToken: "secret" }).gatewayUrl).toBe(gatewayUrl);
    }
    for (const gatewayUrl of ["http://gateway.example", "http://192.168.1.2", "file:///tmp/gateway", "https://user:pass@gateway.example", "https://gateway.example?", "https://gateway.example/#", "not-a-url"]) {
      expect(() => validateDotsAccountProfile({ gatewayUrl, deviceToken: "do-not-print-me" })).toThrow();
    }
  });

  it("rejects invalid private data without echoing it in errors", async () => {
    for (const deviceToken of ["", "\nsecret", "secret value", "token\r\nheader: bad", "x".repeat(4097)]) {
      expect(() => validateDotsAccountProfile({ gatewayUrl: "https://gateway.example", deviceToken })).toThrow("Invalid dots account device token");
    }
    const agentDir = await root();
    await saveDotsAccountProfile(agentDir, { gatewayUrl: "https://gateway.example", deviceToken: "secret" });
    await writeFile(dotsAccountProfilePath(agentDir), '{"deviceToken": "sensitive", invalid');
    await expect(loadDotsAccountProfile(agentDir)).rejects.toThrow("Invalid dots account profile JSON");
    await writeFile(dotsAccountProfilePath(agentDir), "x".repeat(64 * 1024 + 1));
    await expect(loadDotsAccountProfile(agentDir)).rejects.toThrow("size limit");
  });
});
