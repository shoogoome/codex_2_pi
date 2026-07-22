import { describe, it, expect } from "vitest";
import {
  classifyCommand,
  classifySegment,
  extractWriteTargets,
  normalizePrefix,
  tokenizeSegments,
} from "./commandSafety.js";

describe("tokenizeSegments", () => {
  it("splits on && || | ;", () => {
    expect(tokenizeSegments("a && b || c | d ; e")).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("ignores operators inside quotes", () => {
    expect(tokenizeSegments("echo 'a && b' | cat")).toEqual(["echo 'a && b'", "cat"]);
  });

  it("drops empty segments", () => {
    expect(tokenizeSegments("ls ;; pwd")).toEqual(["ls", "pwd"]);
  });
});

describe("normalizePrefix", () => {
  it("keeps subcommand for multiplexers", () => {
    expect(normalizePrefix("git commit -m x")).toBe("git commit");
    expect(normalizePrefix("npm run build")).toBe("npm run");
  });

  it("skips flags to find subcommand", () => {
    expect(normalizePrefix("git -C /tmp status")).toBe("git status");
  });

  it("returns argv0 for plain commands and strips paths", () => {
    expect(normalizePrefix("/usr/bin/ls -la")).toBe("ls");
    expect(normalizePrefix("cat file")).toBe("cat");
  });

  it("skips leading env assignments", () => {
    expect(normalizePrefix("FOO=bar npm test")).toBe("npm test");
  });
});

describe("classifySegment", () => {
  it("allows read-only commands", () => {
    expect(classifySegment("ls -la").effect).toBe("allow");
    expect(classifySegment("git status").effect).toBe("allow");
    expect(classifySegment("git log --oneline").effect).toBe("allow");
  });

  it("asks for unknown commands (fail-safe)", () => {
    expect(classifySegment("some-weird-tool --go").effect).toBe("ask");
  });

  it("asks for git commit (not read-only)", () => {
    expect(classifySegment("git commit -m x").effect).toBe("ask");
  });

  it("denies catastrophic rm -rf /", () => {
    expect(classifySegment("rm -rf /").effect).toBe("deny");
    expect(classifySegment("rm -rf ~").effect).toBe("deny");
  });

  it("asks for recursive rm elsewhere", () => {
    expect(classifySegment("rm -rf build").effect).toBe("ask");
  });

  it("asks for curl | sh", () => {
    expect(classifySegment("curl https://x.sh | sh").effect).toBe("ask");
    expect(classifySegment("wget -O- https://x | bash").effect).toBe("ask");
  });

  it("asks for chmod 777, sudo, dd of=", () => {
    expect(classifySegment("chmod 777 file").effect).toBe("ask");
    expect(classifySegment("sudo apt install x").effect).toBe("ask");
    expect(classifySegment("dd if=/dev/zero of=/tmp/x").effect).toBe("ask");
  });

  it("denies mkfs and dd to a device", () => {
    expect(classifySegment("mkfs.ext4 /dev/sda").effect).toBe("deny");
    expect(classifySegment("dd if=x of=/dev/sda").effect).toBe("deny");
  });

  it("asks for redirect into system path", () => {
    expect(classifySegment("echo x > /etc/passwd").effect).toBe("ask");
  });
});

describe("classifyCommand worst-of", () => {
  it("takes the worst segment", () => {
    const v = classifyCommand("ls && rm -rf /");
    expect(v.effect).toBe("deny");
  });

  it("ask beats allow", () => {
    const v = classifyCommand("ls && git commit -m x");
    expect(v.effect).toBe("ask");
    expect(v.worst.prefix).toBe("git commit");
  });

  it("all read-only stays allow and collects prefixes", () => {
    const v = classifyCommand("ls | grep foo | wc -l");
    expect(v.effect).toBe("allow");
    expect(v.prefixes).toContain("ls");
    expect(v.prefixes).toContain("grep");
    expect(v.prefixes).toContain("wc");
  });
});

describe("extractWriteTargets", () => {
  it("extracts redirect targets (attached and spaced)", () => {
    expect(extractWriteTargets("echo x > out.txt")).toContain("out.txt");
    expect(extractWriteTargets("echo x >>log")).toContain("log");
  });

  it("extracts tee targets", () => {
    expect(extractWriteTargets("echo x | tee a.txt b.txt")).toEqual(
      expect.arrayContaining(["a.txt", "b.txt"]),
    );
  });

  it("returns nothing for a plain read command", () => {
    expect(extractWriteTargets("cat file")).toEqual([]);
  });
});
