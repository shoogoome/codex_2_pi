import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { builtinPet } from "../catalog/catalog.js";
import { type PetManifest, parsePetManifest } from "./pet-manifest.js";

const CATALOG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "catalog");

export interface LoadedPet {
  manifest: PetManifest;
  /** Absolute path to the spritesheet image on disk. */
  spritesheetAbsPath: string;
  id: string;
}

export interface LoadOptions {
  agentDir: string;
}

export type LoadResult =
  | { kind: "ok"; pet: LoadedPet }
  | { kind: "fallback"; pet: LoadedPet; reason: string };

export function loadPet(id: string, options: LoadOptions): LoadResult {
  try {
    const pet = resolvePet(id, options);
    return { kind: "ok", pet };
  } catch (error) {
    if (id === "default") {
      throw error;
    }
    const reason = `failed to load pet "${id}": ${error instanceof Error ? error.message : String(error)}`;
    const fallback = resolvePet("default", options);
    return { kind: "fallback", pet: fallback, reason };
  }
}

function resolvePet(id: string, options: LoadOptions): LoadedPet {
  const builtin = builtinPet(id);
  if (builtin) {
    const manifestPath = join(CATALOG_DIR, builtin.manifestRelPath);
    return parseAndAttach(manifestPath);
  }

  const userManifestPath = join(options.agentDir, "pets", id, "pet.json");
  if (!existsSync(userManifestPath)) {
    throw new Error(`pet "${id}" not found in agent dir`);
  }
  return parseAndAttach(userManifestPath);
}

function parseAndAttach(manifestPath: string): LoadedPet {
  const text = readFileSync(manifestPath, "utf8");
  const manifest = parsePetManifest(text, manifestPath);
  const spritesheetAbsPath = resolve(dirname(manifestPath), manifest.spritesheetPath);
  if (!existsSync(spritesheetAbsPath)) {
    throw new Error(`spritesheet missing at ${spritesheetAbsPath}`);
  }
  return {
    id: manifest.id,
    manifest,
    spritesheetAbsPath,
  };
}
