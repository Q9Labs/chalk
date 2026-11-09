package mediaplaneproviders

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/adapters/chalksfu"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// recoverBinding returns the binding a call on a live own-SFU Episode should use. It is the
// binding it was given while the bound allocation is healthy. When the node is silent or has
// restarted, the Episode moves through one durable, generation-fenced transition:
//
//  1. The Fleet picks the target by placement rules (primaries first, a standby only when no
//     primary takes it) and asks it for an atomic hold of the Episode's whole shape.
//  2. Only then the binding is replaced, with the generation advanced by one, and only if
//     the stored generation is still the one read here.
//
// A refused or unreachable target leaves the binding untouched and returns the capacity
// error. Losing the compare-and-set to another API replica returns the winner's binding, so
// every replica follows one move. A crash between the two steps leaves an expiring hold and
// the old binding, and the next call repeats the same reserve and commits. The Episode never
// leaves the own SFU here: only a new Episode may overflow to Cloudflare. Participants then
// rejoin through their normal join, with fresh generations.
func (r Registry) recoverBinding(ctx context.Context, tenantID, episodeID utilities.ID, binding mediaplane.Binding) (mediaplane.Binding, error) {
	if r.chalk == nil || r.recovery == nil || binding.Provider != string(mediaplane.ProviderChalkSFU) || binding.Node == "" {
		return binding, nil
	}
	reason, lost := r.chalk.Confirm(ctx, binding.Current())
	if !lost {
		return binding, nil
	}
	participants, err := r.recovery.LiveParticipants(ctx, tenantID, episodeID)
	if err != nil {
		return binding, fmt.Errorf("%w: %w: read the episode's shape: %v", mediaplane.ErrPlaneUnavailable, mediaplane.ErrProviderRateLimited, err)
	}
	placement, err := r.chalk.Recover(ctx, reason, binding, tenantID.String(), episodeID.String(), max(participants, 1))
	if err != nil {
		slog.WarnContext(ctx, "chalk sfu episode recovery refused", "event", "chalk_sfu.recovery_refused", "episode_id", episodeID.String(), "node", binding.Node, "reason", string(reason), "error", err.Error())
		return binding, fmt.Errorf("%w: %w: %w", mediaplane.ErrPlaneUnavailable, mediaplane.ErrProviderRateLimited, err)
	}
	next, err := binding.Moved(placement)
	if err != nil {
		return binding, fmt.Errorf("%w: %v", mediaplane.ErrPlaneUnavailable, err)
	}
	current, err := r.recovery.MoveBinding(ctx, tenantID, episodeID, binding.Generation, next)
	switch {
	case err == nil:
		r.chalk.ChargeRecovered(placement.Node)
		chalksfu.RecordMoved(ctx, reason)
		r.retireLeft(ctx, retirementDebts(tenantID, episodeID, current))
		slog.InfoContext(ctx, "chalk sfu episode recovered", "event", "chalk_sfu.recovered", "episode_id", episodeID.String(),
			"from_node", binding.Node, "to_node", current.Node, "reason", string(reason), "generation", current.Generation)
		return current, nil
	case errors.Is(err, mediaplane.ErrBindingStale):
		chalksfu.RecordLostRace(ctx, reason)
		return current, nil
	}
	return binding, fmt.Errorf("%w: commit the episode's binding move: %v", mediaplane.ErrPlaneUnavailable, err)
}

// retirementDebts lists what the binding owes: a retire at its generation for each allocation the
// Episode left.
func retirementDebts(tenantID, episodeID utilities.ID, binding mediaplane.Binding) []mediaplane.RetirementDebt {
	var debts []mediaplane.RetirementDebt
	for _, old := range binding.Retirements() {
		debts = append(debts, mediaplane.RetirementDebt{TenantID: tenantID, EpisodeID: episodeID, Allocation: old, Generation: binding.Generation})
	}
	return debts
}

// retireLeft asks each node the Episode left to retire it now, as a first try after the move.
// The move wrote the debts in its own transaction, so a node that does not answer is not forgotten:
// the retirement worker (RunRetirements) keeps asking.
func (r Registry) retireLeft(ctx context.Context, debts []mediaplane.RetirementDebt) {
	// The retire does not end with the request that triggered it, so a client that gives up
	// cannot leave the old node unretired. The fleet bounds each node's call.
	ctx = context.WithoutCancel(ctx)
	for _, debt := range debts {
		r.settle(ctx, debt)
	}
}

// settle makes one retire attempt and deletes the debt when it is done. An unanswered node keeps
// its debt and is logged without the request's content.
func (r Registry) settle(ctx context.Context, debt mediaplane.RetirementDebt) {
	settled, err := r.chalk.RetireAllocation(ctx, debt.Allocation, debt.TenantID.String(), debt.EpisodeID.String(), debt.Generation)
	if !settled {
		slog.WarnContext(ctx, "chalk sfu retired allocation not retired yet", "event", "chalk_sfu.retire_pending",
			"tenant_id", debt.TenantID.String(), "episode_id", debt.EpisodeID.String(), "node", debt.Allocation.Node, "generation", debt.Generation, "error", err.Error())
		return
	}
	if err := r.recovery.SettleRetirementDebt(ctx, debt); err != nil {
		slog.WarnContext(ctx, "chalk sfu retirement debt not cleared", "event", "chalk_sfu.retire_debt_unsettled",
			"tenant_id", debt.TenantID.String(), "episode_id", debt.EpisodeID.String(), "node", debt.Allocation.Node, "error", err.Error())
	}
}

const (
	// retirementTick is how often the worker looks for debts that are due.
	retirementTick = 5 * time.Second
	// retirementBatch bounds the debts one pass takes.
	retirementBatch = 32
)

// RunRetirements pays the retirement debts until ctx ends. Each pass claims the debts that are
// due, which also moves their next attempt out by a bounded backoff (5s doubling to 5 minutes), so
// a node that stays silent costs one call per backoff, and replicas share the work without
// asking the same node twice. A debt is deleted when the node acknowledges, answers with a new
// boot, or leaves the configuration. It does not depend on any request, and it runs for Episodes that have ended.
func (r Registry) RunRetirements(ctx context.Context) {
	if r.chalk == nil || r.recovery == nil {
		return
	}
	r.observeBacklog(ctx)
	ticker := time.NewTicker(retirementTick)
	defer ticker.Stop()
	for {
		r.PayRetirements(ctx)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// PayRetirements runs one pass of the retirement worker: it claims the debts that are due and
// settles each one. RunRetirements calls it on a timer.
func (r Registry) PayRetirements(ctx context.Context) {
	defer r.readBacklog(ctx)
	debts, err := r.recovery.ClaimRetirementDebts(ctx, retirementBatch)
	if err != nil {
		if ctx.Err() == nil {
			slog.WarnContext(ctx, "chalk sfu retirement debts not read", "event", "chalk_sfu.retire_debts_unread", "error", err.Error())
		}
		return
	}
	var wg sync.WaitGroup
	for _, debt := range debts {
		wg.Go(func() { r.settle(ctx, debt) })
	}
	wg.Wait()
}

// EndRetiredAllocations retires a finished Episode on the allocations its binding left, so a node
// that returns holding its old sessions releases them. It writes the debts first and then tries
// each node once.
//
// The Episode's end is confirmed on durable ownership, not on the node's acknowledgement: once the
// debt rows are committed, the RunRetirements worker owns the cleanup and retries it until the node
// acknowledges, comes back as a new boot, or is no longer configured. A node that is silent on the
// control path therefore does not hold the end. The cost is that a node that stays silent for good
// keeps the old sessions until it restarts or its 24 hour floor tombstone expires. Those sessions
// cannot publish for longer than the source lease TTL, because the API stops renewing a lease once
// the Episode ends. An unpaid debt is visible as chalk.sfu.retirement_debts and its oldest age.
//
// It is idempotent and never touches the Episode's current allocation.
func (r Registry) EndRetiredAllocations(ctx context.Context, tenantID, episodeID utilities.ID) error {
	if r.chalk == nil || r.recovery == nil {
		return nil
	}
	binding, err := r.recovery.Binding(ctx, tenantID, episodeID)
	if err != nil || binding == nil {
		return err
	}
	debts := retirementDebts(tenantID, episodeID, *binding)
	if len(debts) == 0 {
		return nil
	}
	if err := r.recovery.RecordRetirementDebts(ctx, debts); err != nil {
		return fmt.Errorf("%w: record the episode's retirement debts: %v", mediaplane.ErrPlaneUnavailable, err)
	}
	r.retireLeft(ctx, debts)
	return nil
}

// bindingFence returns the check a join runs after the node created its session: the Episode's
// durable binding must still be the one the join was issued under, with the same generation,
// node and incarnation. It is a fast path. A read can pass just before a move commits, so what
// stops a stale join is the node refusing the old generation once it is retired (the move records
// the debt, and the retirement worker pays it). Without recovery configured nothing moves a binding,
// so there is nothing to check.
func (r Registry) bindingFence(tenantID, episodeID utilities.ID, issued mediaplane.Binding) func(context.Context) error {
	if r.chalk == nil || r.recovery == nil || issued.Provider != string(mediaplane.ProviderChalkSFU) {
		return nil
	}
	return func(ctx context.Context) error {
		current, err := r.recovery.Binding(ctx, tenantID, episodeID)
		if err != nil {
			return fmt.Errorf("%w: confirm the episode's binding after the join: %v", mediaplane.ErrPlaneUnavailable, err)
		}
		if current == nil || current.Generation != issued.Generation || current.Current() != issued.Current() {
			return fmt.Errorf("%w: %w", mediaplane.ErrPlaneUnavailable, mediaplane.ErrBindingStale)
		}
		return nil
	}
}
