import type { PetStateName } from "../../loader/pet-manifest.js";

export const FALLBACK_ASCII: Record<PetStateName, string[]> = {
  idle:    ["  /\\_/\\", "  (o.o)", "  ( - )"],
  running: ["  /\\_/\\", "  (^.^)", "  ( ~ )"],
  waiting: ["  /\\_/\\", "  (o.O)", "  ( ? )"],
  review:  ["  /\\_/\\", "  (^_^)", "  ( v )"],
  failed:  ["  /\\_/\\", "  (x.x)", "  ( ! )"],
};
