import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const SIDE_REQUEST_CHANNEL = "pi.side.open.v1";
export interface SideRequest {
  question: string;
  ctx: ExtensionContext;
}
