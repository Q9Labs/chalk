import type { ParticipantDeviceKind } from "./device-kind";

/**
 * The URL a Sync client dials. The query asks for features and carries no credential: the token goes in the hello frame.
 * `deviceKind` declares what this client runs on; a warmed socket is adopted only by a dial of the same URL, so the browser
 * code that warms one and the client that dials it must pass the same kind.
 */
export function syncEntryUrl(value: string, generation: number | null, confirmation: boolean, deviceKind?: ParticipantDeviceKind): string {
  const url = new URL(value);
  url.searchParams.set("participant_devices", "1");
  // Previous Sync ignores both and sends presence items without `device_kind`, which means "no declared device".
  url.searchParams.set("participant_device_kinds", "1");
  if (deviceKind) url.searchParams.set("device_kind", deviceKind);
  url.searchParams.set("participant_device_admissions", "2");
  // Previous Sync ignores this query and sends the earlier item shape, which means "no evidence".
  url.searchParams.set("media_off_reason", "1");
  // Previous Sync ignores this query, never echoes it in the welcome, and never gets a quality frame.
  url.searchParams.set("connection_quality", "1");
  url.searchParams.set("app_state", "1");
  url.searchParams.set("screen_annotation", "1");
  url.searchParams.set("screen_annotation_burn_in", "1");
  url.searchParams.set("presenting", "1");
  url.searchParams.set("entry_generation", generation === null ? "new" : String(generation));
  if (confirmation) url.searchParams.set("entry_confirmation", "1");
  return url.toString();
}
