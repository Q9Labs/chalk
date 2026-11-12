package observability

import (
	"context"
	"slices"
)

// MediaReplacementCauses is shared by the wire contract and the log boundary.
// Unknown values are ignored so diagnostics cannot interrupt media negotiation.
func MediaReplacementCauses() []string {
	return []string{
		"user_pause", "moderation_pause", "sync_recovery_loss", "discovery_absent",
		"capture_cleanup", "consent_revoked", "publish_failure", "enable_failure", "projection_mismatch",
		"forced_pause", "local_signaling_failure", "remote_signaling_failure", "dormant_connection", "access_refresh", "receive_stalled", "section_budget",
	}
}

// MediaCloseReasons says why a client closes tracks: the user muted, unpublished a source,
// a newer connection or receiver replaced them, the Participant left, or something failed.
func MediaCloseReasons() []string {
	return []string{"user_mute", "unpublish", "replacement", "leave", "error"}
}

// LogMediaTrackClose records why a close-tracks request arrived. A missing or unknown reason logs as
// "unspecified", so an older client stays countable and a free-text value never reaches the log.
func LogMediaTrackClose(ctx context.Context, reason string, trackCount int, receiveOnly, force bool) {
	if !slices.Contains(MediaCloseReasons(), reason) {
		reason = "unspecified"
	}
	attrs := append([]any{"event", "media.track_close", "close_reason", reason, "track_count", trackCount, "receive_only", receiveOnly, "force", force}, requestMediaAttrs(ctx)...)
	RequestLogger(ctx).InfoContext(ctx, "media tracks closed", attrs...)
}

func LogMediaConnectionReplacement(ctx context.Context, cause string) {
	if !slices.Contains(MediaReplacementCauses(), cause) {
		return
	}
	attrs := append([]any{"event", "media.connection_replacement", "replacement_cause", cause}, requestMediaAttrs(ctx)...)
	RequestLogger(ctx).InfoContext(ctx, "media connection replacement", attrs...)
}
