import { describe, expect, it } from "vitest";
import { BUILTIN_PET_IDS, builtinPet } from "./catalog.js";

describe("pets catalog", () => {
  it("knows the bundled default pet", () => {
    expect(BUILTIN_PET_IDS).toEqual(["default"]);
    const entry = builtinPet("default");
    expect(entry).toBeDefined();
    expect(entry?.displayName).toBe("Default");
    expect(entry?.manifestRelPath).toBe("default/pet.json");
  });

  it("returns undefined for unknown ids", () => {
    expect(builtinPet("does-not-exist")).toBeUndefined();
  });
});
