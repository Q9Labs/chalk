import { observeOperation } from "../telemetry/operation";
import type { MediaOperationResult, MediaOperationStart, TelemetrySink } from "../telemetry/types";
import { V1SyncError } from "./v1-error";

type LiveTargetName = "set_microphone_enabled" | "set_camera_enabled" | "set_screen_share_enabled";

/** What each live target asks for, in the words of the `action` field: off first, then on. */
const TARGETS: Record<LiveTargetName, { readonly source: MediaOperationStart["source"]; readonly actions: readonly [NonNullable<MediaOperationStart["action"]>, NonNullable<MediaOperationStart["action"]>] }> = {
  set_microphone_enabled: { source: "microphone", actions: ["mute", "unmute"] },
  set_camera_enabled: { source: "camera", actions: ["unpublish", "publish"] },
  set_screen_share_enabled: { source: "screen_video", actions: ["share_stop", "share_start"] },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Tells the outbox what a live target asked for and how it ended. The operation id is the one on the Sync frame, so the
 * client's two events and Sync's `sync.media.intent` line for the same click share one id. A custom request id that is
 * not a UUID is not a valid telemetry id, so that click gets a fresh one and the join to Sync is lost.
 */
export function reportLiveTarget<T>(sink: TelemetrySink | undefined, name: LiveTargetName, enabled: boolean, requestId: string, send: () => Promise<T>): Promise<T> {
  const target = TARGETS[name];
  return observeOperation(sink, { action: target.actions[enabled ? 1 : 0], source: target.source, ...(UUID.test(requestId) ? { op_id: requestId } : {}) }, send, (error) => ({ code: failureCode(error) }));
}

function failureCode(error: unknown): MediaOperationResult["code"] {
  switch (error instanceof V1SyncError ? error.code : undefined) {
    case "media_timeout":
    case "signaling_timeout":
    case "negotiation_timeout":
      return "media_timeout";
    case "retry_exhausted":
      return "retry_exhausted";
    case "not_live":
    case "media_plane_unavailable":
      return "not_live";
    default:
      return "command_rejected";
  }
}
