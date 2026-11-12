package providerbridge

import (
	"context"
	"log/slog"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// The own SFU forwards a granted source only while its lease lasts (60 s by
// default). Renewing every 5 s keeps a live grant many renewals clear of expiry,
// so an API restart that answers again within the lease never stops a call.
const (
	SourceLeaseRenewInterval = 5 * time.Second
	sourceLeasePageSize      = 512
	sourceLeaseCallTimeout   = 2 * time.Second
)

// SourceGrant is a confirmed grant whose durable authorization still stands: the
// Episode is live on the own SFU, the Participant is present with the source's
// capability, and no stop was decided at or after the grant's revision.
type SourceGrant struct {
	TenantID      utilities.ID
	EpisodeID     utilities.ID
	Node          string
	Generation    int64 // the Episode's binding generation
	ParticipantID utilities.ID
	Source        string
	Revision      int64
}

// RenewableGrants pages the standing grants in (tenant, Episode, Participant,
// source) order, starting after the key of the given grant.
type RenewableGrants interface {
	ListRenewableSourceGrants(ctx context.Context, after SourceGrant, limit int) ([]SourceGrant, error)
}

// SourceLeases re-sends every standing grant to its node at the grant's own
// revision. It reads authorization from Postgres rather than from what was
// delivered, so a revoke the node never received still stops renewal, and the
// node drops the source once its lease runs out. A renewal can never undo a newer
// revoke, because the node ignores a control older than the one it holds.
type SourceLeases struct {
	grants   RenewableGrants
	nodes    ChalkNodes
	interval time.Duration
	pageSize int
}

func NewSourceLeases(grants RenewableGrants, nodes ChalkNodes) SourceLeases {
	return SourceLeases{grants: grants, nodes: nodes, interval: SourceLeaseRenewInterval, pageSize: sourceLeasePageSize}
}

// Run renews at once and then on every interval until ctx ends.
func (l SourceLeases) Run(ctx context.Context) {
	ticker := time.NewTicker(l.interval)
	defer ticker.Stop()
	for {
		if err := l.Renew(ctx); err != nil && ctx.Err() == nil {
			slog.WarnContext(ctx, "Source lease renewal failed", "event", "sfu.source_lease_renewal_failed", "error", err.Error())
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// Renew sends one grant for every standing source, one request per Episode and
// node. A node that fails is skipped for the rest of the pass, so one dead node
// cannot stall renewal for the others.
func (l SourceLeases) Renew(ctx context.Context) error {
	failed := map[string]bool{}
	after := SourceGrant{}
	for {
		page, err := l.grants.ListRenewableSourceGrants(ctx, after, l.pageSize)
		if err != nil {
			return err
		}
		for start := 0; start < len(page); {
			end := start + 1
			for end < len(page) && sameEpisode(page[start], page[end]) {
				end++
			}
			l.renewEpisode(ctx, page[start:end], failed)
			start = end
		}
		if len(page) < l.pageSize {
			return nil
		}
		after = page[len(page)-1]
	}
}

func (l SourceLeases) renewEpisode(ctx context.Context, grants []SourceGrant, failed map[string]bool) {
	first := grants[0]
	if failed[first.Node] {
		return
	}
	controls := make([]mediaplane.SourceControl, 0, len(grants)+1)
	for _, grant := range grants {
		controls = append(controls, mediaplane.SourceControl{ParticipantID: grant.ParticipantID.String(), Source: grant.Source, Action: mediaplane.SourceGrant, Revision: grant.Revision})
		// Tab audio is published with the screen and follows its grant.
		if grant.Source == "screen" {
			controls = append(controls, mediaplane.SourceControl{ParticipantID: grant.ParticipantID.String(), Source: "screen_audio", Action: mediaplane.SourceGrant, Revision: grant.Revision})
		}
	}
	node, err := l.nodes(first.Node, first.Generation)
	if err == nil {
		callCtx, cancel := context.WithTimeout(ctx, sourceLeaseCallTimeout)
		_, err = node.ControlSources(callCtx, mediaplane.ControlSourcesInput{TenantID: first.TenantID.String(), EpisodeID: first.EpisodeID.String(), Controls: controls})
		cancel()
	}
	if err != nil && ctx.Err() == nil {
		failed[first.Node] = true
		slog.WarnContext(ctx, "Source lease renewal skipped a node", "event", "sfu.source_lease_node_failed", "node", first.Node, "error", err.Error())
	}
}

func sameEpisode(a, b SourceGrant) bool {
	return a.TenantID == b.TenantID && a.EpisodeID == b.EpisodeID && a.Node == b.Node
}
