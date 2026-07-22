/**
 * Shared types for the agents-context extension. Type-only so tests can inject
 * a fake filesystem without importing node:fs.
 */

/** Which merge segment a discovered file belongs to. Injection order is
 * user -> project -> local. */
export type Layer = "user" | "project" | "local";

/** A single markdown context file discovered on disk (already @include-expanded
 * and frontmatter-parsed). */
export interface DiscoveredFile {
  /** Absolute path of the origin file (used for provenance + dedup against the
   * paths pi already loaded). */
  path: string;
  /** Fully expanded content (parent + any @included children), frontmatter
   * stripped. */
  content: string;
  layer: Layer;
  /** When present, this block is a conditional rule: only inject it when a
   * touched path matches one of these globs. When undefined the block is
   * unconditional. */
  globs?: string[];
  /** Whether content was truncated to fit the byte budget. */
  truncated?: boolean;
}

/**
 * Minimal filesystem surface used by discovery + include expansion. The real
 * runtime binds these to node:fs; tests pass in-memory fakes.
 */
export interface FsLike {
  /** Read a UTF-8 file. Should throw (ENOENT-style) when missing. */
  readFile(path: string): string;
  /** Whether a path exists (file or directory). */
  exists(path: string): boolean;
  /** List immediate entries of a directory as { name, isDirectory }. */
  readdir(path: string): Array<{ name: string; isDirectory: boolean }>;
}
