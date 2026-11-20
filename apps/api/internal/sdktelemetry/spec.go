package sdktelemetry

import (
	"maps"
	"slices"

	"github.com/q9labs/chalk/apps/api/internal/captureplane"
)

// spec says which optional fields an event type may and must carry.
type spec struct {
	allowed  []string
	required []string
}

// connectionFields are what the connection observers say about one step of a join,
// a recovery or a media path. Every event of the connection family may carry them.
var connectionFields = []string{
	"state", "step", "outcome", "code", "phase", "mechanism", "attempt", "duration_ms", "outage_ms",
	"heartbeat_gap_ms", "close_code", "http_status", "media_error_kind", "media_error_step",
	"granted_audio", "granted_video", "source", "publication_state", "projection_state",
	"receive_state", "track_state", "element_state", "play_result",
}

func connection(extra ...string) spec {
	return spec{allowed: slices.Concat(connectionFields, extra)}
}

var specs = map[string]spec{
	// Join, state and recovery steps.
	"space_join_span":           {allowed: connectionFields, required: []string{"outcome"}},
	"state_changed":             connection(),
	"connection_failed":         connection(),
	"sync_connect_failed":       connection(),
	"sync_dial_timeout":         connection(),
	"access_refreshed":          connection(),
	"access_refresh_failed":     connection(),
	"recovery_attempt":          connection(),
	"recovery_succeeded":        connection(),
	"recovery_exhausted":        connection(),
	"cleanup_completed":         connection(),
	"cleanup_unconfirmed":       connection(),
	"sync_socket_open":          connection(),
	"sync_socket_close":         connection(),
	"sync_heartbeat_gap":        connection(),
	"media_state":               connection(),
	"media_http_error":          connection(),
	"media_projection_mismatch": connection(),
	"access_retry":              connection(),
	"audio_receive_stuck":       connection(),
	"audio_receive_summary":     connection("receive_counts"),
	"receivers_closed":          connection("receivers_stopped", "bundle_tag_held"),
	"chat_upload_failed":        connection("upload_failure"),

	// The end of a call, and what the platform did to the client around it.
	"call_ended":       {allowed: []string{"end_reason", "episode_end_reason"}, required: []string{"end_reason"}},
	"rejoin_release":   {allowed: []string{"rejoin_release"}, required: []string{"rejoin_release"}},
	"platform_changed": {allowed: []string{"platform_state"}, required: []string{"platform_state"}},

	// One window of stats, or the marker of a window that could not be measured.
	"call_stats": {allowed: []string{"stats"}, required: []string{"stats"}},

	// The outbox could not keep every event and says how many it lost.
	"telemetry_dropped": {allowed: []string{"dropped", "dropped_seqs", "drop_reason", "dropped_source_id"}, required: []string{"dropped"}},

	// Media operations: the click or call that asked for them, and what came of it.
	"media_intent": {allowed: []string{"action", "source", "op_id"}, required: []string{"action", "op_id"}},
	"media_result": {allowed: []string{"action", "source", "op_id", "outcome", "code", "duration_ms", "media_error_kind", "http_status"}, required: []string{"action", "op_id", "outcome"}},

	// A device or a render that failed.
	"device_failed":  {allowed: []string{"error_name", "device_kind", "permission_state", "source"}, required: []string{"error_name", "device_kind"}},
	"render_crashed": {allowed: []string{"render_cause"}, required: []string{"render_cause"}},

	// A person filed a problem report: the report row and these rows share a client session.
	"problem_reported": {},
}

// EventTypes lists every type a client may send, sorted.
func EventTypes() []string {
	return slices.Sorted(maps.Keys(specs))
}

var fieldEnums = map[string][]string{
	"media_error_kind":      {"NotAllowedError", "NotReadableError", "NotFoundError", "OverconstrainedError", "AbortError", "SecurityError", "InvalidStateError", "OperationError", "NotSupportedError", "CloudflareSFUError", "network", "timeout", "unknown"},
	"error_name":            {"NotAllowedError", "NotReadableError", "NotFoundError", "OverconstrainedError", "AbortError", "SecurityError", "InvalidStateError", "OperationError", "NotSupportedError", "TypeError", "unknown"},
	"media_error_step":      {"local_capture", "peer_connection", "access_refresh", "sfu_tracks", "sfu_close_tracks", "sfu_renegotiate", "sfu_publications", "sfu_subscriptions"},
	"granted_audio":         {"granted", "not_granted", "unknown"},
	"granted_video":         {"granted", "not_granted", "unknown"},
	"upload_failure":        {"initiate_failed", "storage_unreachable", "storage_rejected", "finalize_failed"},
	"source":                {"microphone", "camera", "screen_audio", "screen_video"},
	"receive_state":         {"announced", "pull_requested", "pull_failed", "pull_succeeded", "track_received", "bytes_flowing", "element_bound", "playing"},
	"track_state":           {"live", "muted", "ended"},
	"element_state":         {"paused", "playing"},
	"play_result":           {"ok", "NotAllowedError", "AbortError", "unknown"},
	"publication_state":     {"on", "off"},
	"projection_state":      {"on", "off"},
	"state":                 {"idle", "joining", "live", "reconnecting", "leaving", "left", "failed"},
	"step":                  {"join", "acquire_initial_media", "access_initialize", "create_media_client", "create_sync_client", "start_media", "start_sync", "wait_for_sync_live", "confirm_entered"},
	"outcome":               {"started", "succeeded", "failed", "cancelled"},
	"phase":                 {"idle", "connecting", "live", "recovering", "failed", "stopped", "new", "connected", "disconnected", "closed"},
	"mechanism":             {"ice_restart", "media_reconnect", "sync_reconnect", "sync_digest", "access_refresh"},
	"code":                  {"invalid_state", "invalid_access", "access_unavailable", "permission_denied", "device_not_found", "device_busy", "device_constraint_invalid", "media_capture_failed", "sync_start_failed", "state_digest_recovery_failed", "sync_hello_timeout", "media_start_failed", "join_cleanup_unconfirmed", "sync_recovery_exhausted", "media_recovery_exhausted", "command_rejected", "leave_unconfirmed", "episode_ended", "unsupported_environment", "internal_error", "collaboration_unavailable", "chat_cursor_reset_required", "rate_limited", "invalid_payload", "media_timeout", "retry_exhausted", "not_live"},
	"action":                {"mute", "unmute", "publish", "unpublish", "subscribe", "unsubscribe", "share_start", "share_stop"},
	"device_kind":           {"microphone", "camera", "speaker", "screen"},
	"permission_state":      {"granted", "denied", "prompt", "unknown"},
	"render_cause":          {"render_error", "chunk_reload", "unhandled_error", "unhandled_rejection"},
	"end_reason":            {"left", "episode_ended", "time_limit", "removed", "connection_lost", "join_failed", "page_closed"},
	"episode_end_reason":    {"ended_by_participant", "tenant_recovery", "maximum_duration"},
	"rejoin_release":        {"released", "release_failed"},
	"platform_state":        {"online", "offline", "hidden", "visible", "background", "foreground"},
	"gap":                   {"offline", "hidden", "poll_failed", "dropped"},
	"connection_type":       {"udp", "tcp", "turn", "unknown"},
	"local_candidate_type":  {"host", "srflx", "prflx", "relay"},
	"remote_candidate_type": {"host", "srflx", "prflx", "relay"},
	"relay_protocol":        {"udp", "tcp", "tls"},
	"send_layer":            {captureplane.TrackLayerHigh.RID(), captureplane.TrackLayerMedium.RID(), captureplane.TrackLayerLow.RID()},
	"kind":                  {"audio", "video"},
	"drop_reason":           {"queue_full", "credential_expired", "refused"},
	"end":                   {"closed", "abandoned"},
	"playout":               {"playing", "paused", "no_element", "unknown"},
}

// FieldEnum is the closed list of labels a field may carry, or nil if it carries none.
// These are also the OpenAPI enums, so no free text can enter a log row through a
// caller that bypasses the SDK.
func FieldEnum(field string) []string {
	if field == "type" {
		return EventTypes()
	}
	return fieldEnums[field]
}

// FieldRange is the inclusive range of a numeric field, and whether the field is a number
// at all. A stats window longer than MaxWindowMS is a gap window, which Check bounds alone.
func FieldRange(field string) (low, high float64, numeric bool) {
	switch field {
	case "seq", "next_seq", "from", "to", "elapsed_ms", "attempt", "duration_ms", "outage_ms", "heartbeat_gap_ms", "dropped", "audio_energy":
		return 0, MaxMilliseconds, true
	case "window_ms":
		return 1, MaxMilliseconds, true
	case "close_code":
		return 1000, 4999, true
	case "http_status":
		return 400, 599, true
	case "send_loss_pct", "recv_loss_pct":
		return 0, 100, true
	case "send_bitrate_kbps", "recv_bitrate_kbps":
		return 0, 100000, true
	case "rtt_ms", "send_jitter_ms", "recv_jitter_ms":
		return 0, 60000, true
	case "recv_height":
		return 0, 4320, true
	case "freeze_count":
		return 0, 10000, true
	case "freeze_ms":
		return 0, 600000, true
	case "recv_paused_videos", "recv_hidden_videos":
		return 0, 64, true
	case "receivers_stopped", "announced", "pull_requested", "pull_failed", "pull_succeeded",
		"track_received", "bytes_flowing", "element_bound", "playing", "projection_off":
		return 0, MaxReceiveCount, true
	case "packets", "lost":
		return 0, MaxTrackPackets, true
	default:
		return 0, 0, false
	}
}
