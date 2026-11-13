package chalksfu

import (
	"context"
	"fmt"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
)

// retireNodeTimeout bounds one retire call to one node, so a node that swallows the request cannot
// hold up the others.
const retireNodeTimeout = 2 * time.Second

// Retirement outcomes, the label of the retirement metric.
const (
	retireAcknowledged = "acknowledged"
	retireGone         = "gone"
	retirePending      = "pending"
)

var retirements, _ = otel.Meter("github.com/q9labs/chalk/apps/api/internal/adapters/chalksfu").Int64Counter(
	"chalk.sfu.retirements",
	metric.WithDescription("Retire calls to the own-SFU allocations whole-Episode recovery left, by outcome"),
	metric.WithUnit("{retirement}"),
)

// RetireAllocation retires the Episode on one allocation it left, at the binding's generation:
// the node closes the Episode's sessions of lower generations, lapses their source leases, and
// refuses any later create, capture or source grant under one (see the SFU's POST
// /v1/episodes/retire). Retiring is idempotent, so a retry is harmless. It reports settled when
// there is nothing left to do: the node acknowledged, answers with another boot than the
// allocation's and so holds nothing of the Episode, or is no longer configured. Otherwise it
// returns the error and the caller keeps the debt. A node the probes call silent is still asked,
// because silent only means its last probe failed and its HTTP side may be up.
func (f *Fleet) RetireAllocation(ctx context.Context, old mediaplane.Allocation, tenantID, episodeID string, generation int64) (settled bool, err error) {
	adapter, err := f.Node(old.Node)
	if err != nil {
		recordRetirement(ctx, retireGone)
		return true, nil // a node removed from the configuration has no process to clean
	}
	if reason, lost := f.Confirm(ctx, old); lost && reason == LossRestarted {
		recordRetirement(ctx, retireGone)
		return true, nil
	}
	nodeCtx, cancel := context.WithTimeout(ctx, retireNodeTimeout)
	defer cancel()
	err = adapter.call(nodeCtx, "/v1/episodes/retire", wireRetireRequest{TenantID: tenantID, EpisodeID: episodeID, Generation: generation}, nil)
	if err != nil {
		recordRetirement(ctx, retirePending)
		return false, fmt.Errorf("retire the episode on node %q: %w", old.Node, err)
	}
	recordRetirement(ctx, retireAcknowledged)
	return true, nil
}

func recordRetirement(ctx context.Context, outcome string) {
	retirements.Add(ctx, 1, metric.WithAttributes(attribute.String("chalk.sfu.retirement.outcome", outcome)))
}
