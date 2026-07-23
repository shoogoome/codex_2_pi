import path from "node:path";
import {
  applyMemoryExtraction,
  buildTurnTranscript,
  hasMemorySignal,
  parseMemoryExtraction,
  type AutoMemoryFs,
} from "./auto-memory.js";

function makeAutoFs(initial: Record<string, string> = {}): AutoMemoryFs & { files: Map<string, string> } {
  const files = new Map(Object.entries(initial).map(([name, content]) => [path.resolve(name), content]));
  return {
    files,
    existsSync(name) {
      const resolved = path.resolve(name);
      return files.has(resolved) || [...files.keys()].some((file) => file.startsWith(`${resolved}/`));
    },
    readFileSync(name) {
      const value = files.get(path.resolve(name));
      if (value === undefined) throw new Error(`ENOENT: ${name}`);
      return value;
    },
    readdirSync(name) {
      const prefix = `${path.resolve(name)}/`;
      return [...new Set([...files.keys()]
        .filter((file) => file.startsWith(prefix))
        .map((file) => file.slice(prefix.length).split("/")[0]))];
    },
    writeFileSync(name, data) {
      files.set(path.resolve(name), data);
    },
    unlinkSync(name) {
      files.delete(path.resolve(name));
    },
  };
}

describe("auto memory", () => {
  it("extracts only user and assistant text from a turn", () => {
    const transcript = buildTurnTranscript([
      { role: "user", content: "older turn", timestamp: 0 },
      { role: "assistant", content: "old answer", timestamp: 0 },
      { role: "user", content: "以后请用中文", timestamp: 1 },
      { role: "assistant", content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "好的" }] },
      { role: "toolResult", content: [{ type: "text", text: "secret tool output" }] },
    ]);

    expect(transcript).toContain("user: 以后请用中文");
    expect(transcript).toContain("assistant: 好的");
    expect(transcript).not.toContain("older turn");
    expect(transcript).not.toContain("old answer");
    expect(transcript).not.toContain("hidden");
    expect(transcript).not.toContain("secret tool output");
  });

  it("uses a cheap signal gate before asking a model", () => {
    expect(hasMemorySignal("user: 帮我解释这一行代码")).toBe(false);
    expect(hasMemorySignal("user: 以后请一直用中文交流")).toBe(true);
    expect(hasMemorySignal("user: 这个仓库的测试命令是 npm test")).toBe(true);
  });

  it("parses fenced JSON and rejects invalid entries", () => {
    expect(parseMemoryExtraction('```json\n{"memories":[{"name":"语言偏好","description":"用户语言偏好","type":"user","facts":["使用中文"]},{"name":"bad","description":"bad","type":"temporary","facts":["x"]}],"delete":["old.md"]}\n```')).toEqual({
      memories: [{
        name: "语言偏好",
        description: "用户语言偏好",
        type: "user",
        facts: ["使用中文"],
        replaces: [],
      }],
      delete: ["old.md"],
    });
    expect(parseMemoryExtraction("not json")).toEqual({ memories: [], delete: [] });
  });

  it("creates, merges, replaces, filters secrets, and rebuilds the index", () => {
    const dir = "/repo/.pi/memory";
    const topic = path.join(dir, "language.md");
    const fs = makeAutoFs({
      [path.join(dir, "MEMORY.md")]: "old index",
      [topic]: '---\nname: "language"\ndescription: "old"\ntype: user\n---\n- Use English\n- Keep answers concise\n',
    });

    const result = applyMemoryExtraction(dir, {
      memories: [{
        name: "language",
        description: "Stable language and response preferences",
        type: "user",
        facts: ["Use Chinese", "password=hunter2"],
        replaces: ["Use English"],
      }],
      delete: [],
    }, fs);

    expect(result.changed).toBe(true);
    expect(fs.readFileSync(topic, "utf8")).toContain("- Use Chinese");
    expect(fs.readFileSync(topic, "utf8")).toContain("- Keep answers concise");
    expect(fs.readFileSync(topic, "utf8")).not.toContain("Use English");
    expect(fs.readFileSync(topic, "utf8")).not.toContain("hunter2");
    expect(fs.readFileSync(path.join(dir, "MEMORY.md"), "utf8")).toContain("language.md");
  });

  it("deduplicates facts and rejects traversal deletes", () => {
    const dir = "/repo/.pi/memory";
    const topic = path.join(dir, "prefs.md");
    const outside = "/repo/.pi/outside.md";
    const fs = makeAutoFs({
      [topic]: '---\nname: "prefs"\ndescription: "preferences"\ntype: user\n---\n- Use Chinese\n',
      [outside]: "keep me",
    });

    applyMemoryExtraction(dir, {
      memories: [{
        name: "prefs",
        description: "preferences",
        type: "user",
        facts: ["Use Chinese"],
      }],
      delete: ["../outside.md", "MEMORY.md"],
    }, fs);

    expect(fs.readFileSync(topic, "utf8").match(/Use Chinese/g)).toHaveLength(1);
    expect(fs.readFileSync(outside, "utf8")).toBe("keep me");
  });
});
