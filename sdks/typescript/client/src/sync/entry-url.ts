import { SYNC_PATH } from "../urls";
import { V1SyncError } from "./v1-error";

/** The URL a Sync client dials. The query asks for features and carries no credential: the token goes in the hello frame. */
export function syncEntryUrl(value: string, generation: number | null, confirmation: boolean): string {
  const url = new URL(value);
  url.searchParams.set("participant_devices", "1");
  url.searchParams.set("participant_device_admissions", "2");
  // Previous Sync ignores this query and sends the earlier item shape, which means "no evidence".
  url.searchParams.set("media_off_reason", "1");
  // Previous Sync ignores this query, never echoes it in the welcome, and never gets a quality frame.
  url.searchParams.set("connection_quality", "1");
  url.searchParams.set("screen_annotation", "1");
  url.searchParams.set("entry_generation", generation === null ? "new" : String(generation));
  if (confirmation) url.searchParams.set("entry_confirmation", "1");
  return url.toString();
}

export function assertV1Url(value: string): void {
  const url = new URL(value);
  if (url.pathname !== SYNC_PATH) throw new V1SyncError("SyncEngine v1 websocket URL must use /v1/sync", "invalid_url");
}
