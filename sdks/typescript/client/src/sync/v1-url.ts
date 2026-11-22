import { SYNC_PATH } from "../urls";
import { V1SyncError } from "./v1-error";

export function assertV1Url(value: string): void {
  const url = new URL(value);
  if (url.pathname !== SYNC_PATH) throw new V1SyncError("SyncEngine v1 websocket URL must use /v1/sync", "invalid_url");
}

export { syncEntryUrl } from "./entry-url";
