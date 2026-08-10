import { describe, expect, it } from "vitest";
import {
	computeReadOnlyTools,
	EXIT_TOOL_NAME,
	isWriteBashCommand,
	isWriteTool,
	sanitizeToolNames,
	WRITE_TOOL_NAMES,
} from "./guard.js";

describe("isWriteTool", () => {
	it("is true for file-mutating tools and task_agent boundary escapes", () => {
		expect(isWriteTool("write")).toBe(true);
		expect(isWriteTool("edit")).toBe(true);
		expect(isWriteTool("apply_patch")).toBe(true);
		expect(isWriteTool("task_agent")).toBe(true);
	});

	it("is false for read-only tools and bash", () => {
		expect(isWriteTool("read")).toBe(false);
		expect(isWriteTool("grep")).toBe(false);
		expect(isWriteTool("find")).toBe(false);
		expect(isWriteTool("ls")).toBe(false);
		expect(isWriteTool("glob")).toBe(false);
		expect(isWriteTool("bash")).toBe(false);
	});

	it("exposes the blocked tool name set", () => {
		expect([...WRITE_TOOL_NAMES].sort()).toEqual(["apply_patch", "edit", "task_agent", "write"]);
	});
});

describe("computeReadOnlyTools", () => {
	it("removes write/delegation tools, keeps read-only + bash, adds the exit tool", () => {
		const result = computeReadOnlyTools(["read", "grep", "bash", "write", "edit", "apply_patch", "task_agent"]);
		expect(result).toContain("read");
		expect(result).toContain("grep");
		expect(result).toContain("bash");
		expect(result).toContain(EXIT_TOOL_NAME);
		expect(result).not.toContain("write");
		expect(result).not.toContain("edit");
		expect(result).not.toContain("apply_patch");
		expect(result).not.toContain("task_agent");
	});

	it("adds the exit tool even when the pre-plan set is empty", () => {
		expect(computeReadOnlyTools([])).toEqual([EXIT_TOOL_NAME]);
	});

	it("does not duplicate the exit tool if already present", () => {
		const result = computeReadOnlyTools(["read", EXIT_TOOL_NAME]);
		expect(result.filter((n) => n === EXIT_TOOL_NAME)).toHaveLength(1);
	});

	it("de-dupes repeated names", () => {
		expect(computeReadOnlyTools(["read", "read", "grep"])).toEqual(["read", "grep", EXIT_TOOL_NAME]);
	});
});

describe("sanitizeToolNames", () => {
	it("keeps only available names and de-dupes, preserving order", () => {
		expect(sanitizeToolNames(["read", "ghost", "grep", "read"], ["read", "grep", "bash"])).toEqual(["read", "grep"]);
	});

	it("returns empty when none are available", () => {
		expect(sanitizeToolNames(["a", "b"], ["c"])).toEqual([]);
	});
});

describe("isWriteBashCommand", () => {
	it("flags mutating commands as writes", () => {
		expect(isWriteBashCommand("rm -rf x")).toBe(true);
		expect(isWriteBashCommand("echo x > f")).toBe(true);
		expect(isWriteBashCommand("echo x >> f")).toBe(true);
		expect(isWriteBashCommand("git commit -m hi")).toBe(true);
		expect(isWriteBashCommand("npm install lodash")).toBe(true);
		expect(isWriteBashCommand("sed -i 's/a/b/' f")).toBe(true);
		expect(isWriteBashCommand("mv a b")).toBe(true);
		expect(isWriteBashCommand("mkdir dir")).toBe(true);
		expect(isWriteBashCommand("touch f")).toBe(true);
		expect(isWriteBashCommand("chmod +x f")).toBe(true);
		expect(isWriteBashCommand("sudo apt-get install foo")).toBe(true);
		expect(isWriteBashCommand("vim f")).toBe(true);
	});

	it("treats read-only commands as non-writes", () => {
		expect(isWriteBashCommand("cat f")).toBe(false);
		expect(isWriteBashCommand("grep x f")).toBe(false);
		expect(isWriteBashCommand("git status")).toBe(false);
		expect(isWriteBashCommand("git diff")).toBe(false);
		expect(isWriteBashCommand("ls -la")).toBe(false);
		expect(isWriteBashCommand("head -n 5 f")).toBe(false);
		expect(isWriteBashCommand("echo hello")).toBe(false);
		expect(isWriteBashCommand("cat a << b")).toBe(false);
	});

	it("returns false for empty / non-string input", () => {
		expect(isWriteBashCommand("")).toBe(false);
		expect(isWriteBashCommand("   ")).toBe(false);
		expect(isWriteBashCommand(undefined as unknown as string)).toBe(false);
	});
});
