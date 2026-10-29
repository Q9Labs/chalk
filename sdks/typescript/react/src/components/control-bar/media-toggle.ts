import type { LocalMedia } from "@q9labsai/chalk-client";

export function mediaToggleTarget(state: LocalMedia["state"], live: boolean): boolean | undefined {
  if (state === "enabled" || state === "requesting") return false;
  return live ? true : undefined;
}
