/**
 * Generic, idempotent prototype-render patch helper. Mirrors compact-ui's
 * `patchUserMessageRenderPrototype` but is parameterized over the marker keys
 * so the assistant and user patches can share one implementation while using
 * distinct markers (and, for the user message, sharing compact-ui's pristine
 * base so the two extensions never double-wrap).
 */

export type RenderFn = (width: number) => string[];

export interface PatchOptions {
  /** Property that stores the pristine (native) render. May be shared with compact-ui. */
  pristineKey: string;
  /** Boolean marker set once this extension has wrapped the render. */
  patchedKey: string;
  /** Property storing the applied patch version. */
  versionKey: string;
  /** Current patch version. */
  version: number;
}

type PatchablePrototype = Record<string, unknown> & { render?: RenderFn };

export function patchRenderPrototype(
  prototype: PatchablePrototype,
  options: PatchOptions,
  buildRender: (originalRender: RenderFn) => RenderFn,
): void {
  if (typeof prototype.render !== "function") {
    return;
  }

  const alreadyPatched =
    prototype[options.patchedKey] === true &&
    prototype[options.versionKey] === options.version &&
    typeof prototype[options.pristineKey] === "function";
  if (alreadyPatched) {
    return;
  }

  if (typeof prototype[options.pristineKey] !== "function") {
    prototype[options.pristineKey] = prototype.render;
  }

  const originalRender = prototype[options.pristineKey] as RenderFn;
  prototype.render = buildRender(originalRender);
  prototype[options.patchedKey] = true;
  prototype[options.versionKey] = options.version;
}
