import { describe, expect, it } from "vitest";
import { createSourceRegistry, normalizeRefKey } from "./sources.js";

describe("normalizeRefKey", () => {
  it("makes refs case-insensitive and tolerant of brackets", () => {
    expect(normalizeRefKey("S3")).toBe("s3");
    expect(normalizeRefKey(" [s3] ")).toBe("s3");
    expect(normalizeRefKey("https://Example.com/A")).toBe("https://example.com/a");
  });
});

describe("createSourceRegistry", () => {
  it("assigns search refs S1.. and page refs P1..", () => {
    const registry = createSourceRegistry();
    expect(registry.add({ url: "https://a.com", via: "search", chars: 10 }).ref).toBe("S1");
    expect(registry.add({ url: "https://b.com", via: "search", chars: 10 }).ref).toBe("S2");
    expect(registry.add({ url: "https://c.com", via: "local", chars: 10 }).ref).toBe("P1");
    expect(registry.add({ url: "https://d.com", via: "deepseek", chars: 10 }).ref).toBe("P2");
  });

  it("looks entries up by ref or URL, case-insensitively", () => {
    const registry = createSourceRegistry();
    const entry = registry.add({ url: "https://a.com/x", title: "A", via: "search", chars: 10 });
    expect(registry.get("S1")?.url).toBe("https://a.com/x");
    expect(registry.get("[s1]")?.title).toBe("A");
    expect(registry.get("https://A.com/x")?.ref).toBe(entry.ref);
    expect(registry.get("S9")).toBeUndefined();
  });

  it("keeps the original ref when the same URL is added again", () => {
    const registry = createSourceRegistry();
    const first = registry.add({ url: "https://a.com", via: "search", chars: 10 });
    const second = registry.add({ url: "https://a.com", via: "local", chars: 900 });
    expect(second.ref).toBe(first.ref);
    expect(second.chars).toBe(900); // remembers the larger slice we already saw
    expect(registry.size()).toBe(1);
  });

  it("lists entries oldest-first without duplicates", () => {
    const registry = createSourceRegistry();
    registry.add({ url: "https://a.com", via: "search", chars: 1 });
    registry.add({ url: "https://b.com", via: "search", chars: 1 });
    registry.add({ url: "https://a.com", via: "local", chars: 1 });
    expect(registry.list().map((e) => e.url)).toEqual(["https://b.com", "https://a.com"]);
  });

  it("evicts the oldest entries past the limit", () => {
    const registry = createSourceRegistry({ limit: 2 });
    registry.add({ url: "https://a.com", via: "search", chars: 1 });
    registry.add({ url: "https://b.com", via: "search", chars: 1 });
    registry.add({ url: "https://c.com", via: "search", chars: 1 });
    expect(registry.size()).toBe(2);
    expect(registry.get("https://a.com")).toBeUndefined();
    expect(registry.get("https://c.com")).toBeDefined();
  });

  it("clears completely", () => {
    const registry = createSourceRegistry();
    registry.add({ url: "https://a.com", via: "search", chars: 1 });
    registry.clear();
    expect(registry.size()).toBe(0);
    expect(registry.list()).toEqual([]);
    // Ref counters restart so a fresh session starts at S1.
    expect(registry.add({ url: "https://b.com", via: "search", chars: 1 }).ref).toBe("S1");
  });
});
