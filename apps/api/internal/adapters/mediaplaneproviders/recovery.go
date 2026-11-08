package mediaplaneproviders

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

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
	reason, lost := r.chalk.Lost(binding.Current())
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
		slog.InfoContext(ctx, "chalk sfu episode recovered", "event", "chalk_sfu.recovered", "episode_id", episodeID.String(),
			"from_node", binding.Node, "to_node", current.Node, "reason", string(reason), "generation", current.Generation)
		return current, nil
	case errors.Is(err, mediaplane.ErrBindingStale):
		chalksfu.RecordLostRace(ctx, reason)
		return current, nil
	}
	return binding, fmt.Errorf("%w: commit the episode's binding move: %v", mediaplane.ErrPlaneUnavailable, err)
}

// EndRetiredAllocations ends a finished Episode on the allocations its binding left, so a node
// that returns holding its old sessions releases them. It is idempotent and never touches the
// Episode's current allocation (see chalksfu.Fleet.EndRetired).
func (r Registry) EndRetiredAllocations(ctx context.Context, tenantID, episodeID utilities.ID) error {
	if r.chalk == nil || r.recovery == nil {
		return nil
	}
	binding, err := r.recovery.Binding(ctx, tenantID, episodeID)
	if err != nil || binding == nil || len(binding.PreviousAllocations) == 0 {
		return err
	}
	return r.chalk.EndRetired(ctx, *binding, tenantID.String(), episodeID.String())
}
