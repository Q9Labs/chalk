import type { SpaceClient } from "./types";

/** UI actions read the current public health state, not a render-time or transport snapshot. */
export async function runMediaAction(client: SpaceClient, enabling: boolean, action: () => void | Promise<unknown>): Promise<boolean> {
  if (enabling && client.getSnapshot().connection.status !== "live") return false;
  await action();
  return true;
}
