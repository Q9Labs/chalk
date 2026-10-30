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
		"forced_pause", "local_signaling_failure", "remote_signaling_failure", "dormant_connection", "access_refresh", "receive_stalled",
	}
}

func LogMediaConnectionReplacement(ctx context.Context, cause string) {
	if !slices.Contains(MediaReplacementCauses(), cause) {
		return
	}
	RequestLogger(ctx).InfoContext(ctx, "media connection replacement", "event", "media.connection_replacement", "replacement_cause", cause)
}
