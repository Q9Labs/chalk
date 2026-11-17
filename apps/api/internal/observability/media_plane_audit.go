package observability

import (
	"context"
	"log/slog"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const (
	// MediaPlaneChangedEvent is the event of one row of media_plane_changes.
	MediaPlaneChangedEvent = "media_plane.changed"
	// MediaPlaneSelectedEvent is the plane decision of one new Episode.
	MediaPlaneSelectedEvent = "media_plane.selected"

	mediaPlaneChangeInterval = 10 * time.Second
	mediaPlaneChangeBatch    = 100
)

// LogMediaPlaneSelected announces why a new Episode got its plane, once its creation
// committed. The same value is stored in the Episode's binding as selected_by, so the
// event and the Episode never disagree.
func LogMediaPlaneSelected(ctx context.Context, tenantID, spaceID, episodeID utilities.ID, binding mediaplane.Binding) {
	selectedBy := string(binding.Selector)
	if selectedBy == "" {
		selectedBy = "unknown"
	}
	RequestLogger(ctx).InfoContext(ctx, "media plane selected for a new episode",
		"event", MediaPlaneSelectedEvent,
		"episode_id", episodeID.String(), "tenant_id", tenantID.String(), "space_id", spaceID.String(),
		"provider", binding.Provider, "selected_by", selectedBy, "configuration_source", binding.ConfigurationSource,
		"placement_reason", string(binding.PlacementReason), "node", binding.Node)
}

// LogMediaPlaneChange announces one plane change. change_trace_id is the trace of the
// writer, which is not the trace of the relay that announces it.
func LogMediaPlaneChange(ctx context.Context, change mediaplane.Change) {
	attributes := []any{
		"event", MediaPlaneChangedEvent, "change_id", change.ID, "scope", string(change.Scope),
		"old_plane", change.OldPlane, "new_plane", change.NewPlane, "actor", change.Actor, "reason", change.Reason,
		"changed_at", change.ChangedAt.UTC().Format(time.RFC3339Nano), "change_trace_id", change.TraceID,
	}
	if !change.TenantID.IsZero() {
		attributes = append(attributes, "tenant_id", change.TenantID.String())
	}
	if !change.SpaceID.IsZero() {
		attributes = append(attributes, "space_id", change.SpaceID.String())
	}
	slog.Default().InfoContext(ctx, "media plane changed", attributes...)
}

// RunMediaPlaneChangeRelay announces the changes in the ledger until ctx ends. The database
// wrote each one in the transaction of the change, so a change is announced within one
// interval even when the writer was a command with no telemetry. A failed pass is logged
// and tried again at the next tick.
func RunMediaPlaneChangeRelay(ctx context.Context, ledger mediaplane.ChangeLedger) {
	ticker := time.NewTicker(mediaPlaneChangeInterval)
	defer ticker.Stop()
	for {
		relayMediaPlaneChanges(ctx, ledger)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func relayMediaPlaneChanges(ctx context.Context, ledger mediaplane.ChangeLedger) {
	for {
		announced, err := ledger.AnnounceChanges(ctx, mediaPlaneChangeBatch, func(change mediaplane.Change) { LogMediaPlaneChange(ctx, change) })
		if err != nil {
			if ctx.Err() == nil {
				slog.Default().WarnContext(ctx, "media plane changes not announced", "event", "media_plane.changes_unannounced", "error", err.Error())
			}
			return
		}
		if announced < mediaPlaneChangeBatch {
			return
		}
	}
}
