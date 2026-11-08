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
		r.retireLeft(ctx, tenantID, episodeID, current)
		slog.InfoContext(ctx, "chalk sfu episode recovered", "event", "chalk_sfu.recovered", "episode_id", episodeID.String(),
			"from_node", binding.Node, "to_node", current.Node, "reason", string(reason), "generation", current.Generation)
		return current, nil
	case errors.Is(err, mediaplane.ErrBindingStale):
		chalksfu.RecordLostRace(ctx, reason)
		return current, nil
	}
	return binding, fmt.Errorf("%w: commit the episode's binding move: %v", mediaplane.ErrPlaneUnavailable, err)
}

const (
	// retireRetryAfter spaces the retries of a retire the old node has not acknowledged, per
	// Episode and per process, so a node that stays silent does not slow every call.
	retireRetryAfter = 30 * time.Second
	// retireLedgerLimit bounds the Episodes the ledger remembers; the oldest goes first.
	retireLedgerLimit = 1 << 12
)

// retireLedger remembers, per Episode in this process, the generation whose retire every old node
// has acknowledged and when it last tried. It only saves calls: retiring is idempotent, a restart
// of the process forgets it and the next resolve retires once more.
type retireLedger struct {
	mu       sync.Mutex
	episodes map[utilities.ID]retireEntry
	order    []utilities.ID
}

type retireEntry struct {
	generation   int64
	acknowledged bool
	tried        time.Time
}

func newRetireLedger() *retireLedger {
	return &retireLedger{episodes: map[utilities.ID]retireEntry{}}
}

// due reports whether the Episode's retire at the generation needs a call now.
func (l *retireLedger) due(episode utilities.ID, generation int64, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	entry, known := l.episodes[episode]
	switch {
	case !known || entry.generation < generation:
		return true
	case entry.generation > generation || entry.acknowledged:
		return false
	}
	return now.Sub(entry.tried) >= retireRetryAfter
}

func (l *retireLedger) record(episode utilities.ID, generation int64, acknowledged bool, now time.Time) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if _, known := l.episodes[episode]; !known {
		if len(l.order) >= retireLedgerLimit {
			delete(l.episodes, l.order[0])
			l.order = l.order[1:]
		}
		l.order = append(l.order, episode)
	}
	l.episodes[episode] = retireEntry{generation: generation, acknowledged: acknowledged, tried: now}
}

// retireLeft retires the Episode on the allocations the binding left. A failure is logged and not
// returned: the move is committed. A node that does not acknowledge is asked again by later
// resolves (see reconcileRetirement), by a join's fence that sees the move, and when the Episode
// ends.
func (r Registry) retireLeft(ctx context.Context, tenantID, episodeID utilities.ID, binding mediaplane.Binding) {
	// The retire does not end with the request that triggered it, so a client that gives up
	// cannot leave the old node unretired. The fleet bounds each node's call.
	ctx = context.WithoutCancel(ctx)
	acknowledged, err := r.chalk.Retire(ctx, binding, tenantID.String(), episodeID.String())
	if err != nil {
		slog.WarnContext(ctx, "chalk sfu retired allocation not retired yet", "event", "chalk_sfu.retire_pending", "episode_id", episodeID.String(), "generation", binding.Generation, "error", err.Error())
	}
	r.retired.record(episodeID, binding.Generation, acknowledged && err == nil, time.Now())
}

// reconcileRetirement asks the old nodes of a moved Episode to retire again when an earlier call
// did not reach them, so a healthy resolve does not leave the old allocation live for good. It
// runs in the background, because a node that swallows the call would otherwise hold up the media
// operation that happened to resolve the Episode; the ledger lets one round start per interval.
func (r Registry) reconcileRetirement(ctx context.Context, tenantID, episodeID utilities.ID, binding mediaplane.Binding) {
	if r.chalk == nil || r.recovery == nil || len(binding.PreviousAllocations) == 0 || !r.retired.due(episodeID, binding.Generation, time.Now()) {
		return
	}
	r.retired.record(episodeID, binding.Generation, false, time.Now())
	go r.retireLeft(ctx, tenantID, episodeID, binding)
}

// EndRetiredAllocations retires a finished Episode on the allocations its binding left, so a node
// that returns holding its old sessions releases them. It is idempotent and never touches the
// Episode's current allocation (see chalksfu.Fleet.Retire). A node that does not answer fails it,
// and the Episode's end retries, unless the probes call the node silent.
func (r Registry) EndRetiredAllocations(ctx context.Context, tenantID, episodeID utilities.ID) error {
	if r.chalk == nil || r.recovery == nil {
		return nil
	}
	binding, err := r.recovery.Binding(ctx, tenantID, episodeID)
	if err != nil || binding == nil || len(binding.PreviousAllocations) == 0 {
		return err
	}
	_, err = r.chalk.Retire(ctx, *binding, tenantID.String(), episodeID.String())
	return err
}

// bindingFence returns the check a join runs after the node created its session: the Episode's
// durable binding must still be the one the join was issued under, with the same generation,
// node and incarnation. It is a fast path. A read can pass just before a move commits, so what
// stops a stale join is the node refusing the old generation once it is retired. Without recovery configured nothing moves a binding, so there is
// nothing to check.
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
			if current != nil && current.Generation > issued.Generation {
				// The read-back is the fast path. The node's retirement is the guarantee, and this
				// replica saw the move first, so it makes sure the old node has it.
				r.retireLeft(ctx, tenantID, episodeID, *current)
			}
			return fmt.Errorf("%w: %w", mediaplane.ErrPlaneUnavailable, mediaplane.ErrBindingStale)
		}
		return nil
	}
}
