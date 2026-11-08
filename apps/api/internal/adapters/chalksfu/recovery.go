package chalksfu

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
)

const (
	// recoveryHoldSeconds is how long a recovering Episode's reservation waits for its
	// Participants to rejoin. A hold that nobody uses, such as the loser's of a race or one
	// whose binding commit never happened, expires on its own.
	recoveryHoldSeconds = 60
	// recoveryCameras is the smallest camera count every node accepts. A node reserves each
	// Participant at its own configured camera count whatever the shape says, and the shape's
	// cameras only size capture sessions, which recovery does not reserve (capture is M10's).
	recoveryCameras = 1
	// reserveHoldGeneration is the SFU-side generation of a recovery hold. The binding
	// generation fences recovery in the database; a hold generation would also refuse any
	// Participant whose own generation is lower, and those count per Participant.
	reserveHoldGeneration = 1
)

// LossReason is why a bound allocation counts as lost. It is a bounded metric label.
type LossReason string

const (
	// LossSilent: the node has not answered a probe within the freshness window.
	LossSilent LossReason = "node_silent"
	// LossRestarted: the node answers with another boot incarnation than the binding's, so
	// it holds nothing of the Episode.
	LossRestarted LossReason = "node_restarted"
)

// Recovery outcomes, the second metric label.
const (
	outcomeMoved       = "moved"
	outcomeNoNode      = "refused_no_node"
	outcomeNoRoom      = "refused_no_room"
	outcomeUnreachable = "refused_unreachable"
	outcomeLostRace    = "lost_race"
)

var recoveries, _ = otel.Meter("github.com/q9labs/chalk/apps/api/internal/adapters/chalksfu").Int64Counter(
	"chalk.sfu.episode_recoveries",
	metric.WithDescription("Whole-Episode recoveries of a live Episode whose node was lost or restarted, by reason and outcome"),
	metric.WithUnit("{recovery}"),
)

// RecordRecovery counts one recovery attempt. Both labels are bounded; no Episode or Tenant
// identity is attached.
func RecordRecovery(ctx context.Context, reason LossReason, outcome string) {
	recoveries.Add(ctx, 1, metric.WithAttributes(
		attribute.String("chalk.sfu.recovery.reason", string(reason)),
		attribute.String("chalk.sfu.recovery.outcome", outcome),
	))
}

// RecordLostRace counts a recovery another API replica won.
func RecordLostRace(ctx context.Context, reason LossReason) {
	RecordRecovery(ctx, reason, outcomeLostRace)
}

// RecordMoved counts a recovery whose binding commit won.
func RecordMoved(ctx context.Context, reason LossReason) { RecordRecovery(ctx, reason, outcomeMoved) }

// errStaleIncarnation means a node answered for another boot than the binding's.
var errStaleIncarnation = errors.New("chalk sfu answered for a replaced node incarnation")

// Lost reports whether the allocation an Episode is bound to is gone, from the last probes
// and without I/O. A node that has not answered within the freshness window is silent; one
// failed probe is not enough, because the window runs from the last answer. A
// node that answers with another boot incarnation than the binding's has restarted, and a
// restarted node holds nothing of the Episode. A draining node is not lost: it keeps its
// live Episodes. Before the first probe round nothing is known, and a binding or probe
// without an incarnation cannot show a restart.
func (f *Fleet) Lost(allocation mediaplane.Allocation) (LossReason, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.probed {
		return "", false
	}
	// A node that never answered counts from the end of the first probe round, so a freshly
	// started API does not call every node silent before it has asked.
	seen, answered := f.seen[allocation.Node]
	last := seen.at
	if !answered {
		last = f.firstRound
	}
	switch {
	case time.Since(last) > probeFreshness:
		return LossSilent, true
	case allocation.Incarnation != "" && seen.incarnation != "" && seen.incarnation != allocation.Incarnation:
		return LossRestarted, true
	}
	return "", false
}

// candidate is a node a recovery may reserve on.
type candidate struct {
	adapter *Adapter
	standby bool
}

// recoveryCandidates lists the nodes that may take a recovering Episode, in the order Place
// uses: every primary that answered within the freshness window and is not draining, then the
// same standbys. It does not filter on room or the host guard: the node's reserve knows what
// the Episode already holds there, which a probe's totals do not, so a retry can reach a node
// that kept the room it reserved. It does no I/O and, unlike Place, never offers another
// provider.
func (f *Fleet) recoveryCandidates() []candidate {
	f.mu.Lock()
	defer f.mu.Unlock()
	var candidates []candidate
	for _, standby := range []bool{false, true} {
		for _, node := range f.nodes {
			if f.standbys[node.node] != standby {
				continue
			}
			load, probed := f.loads[node.node]
			if !probed || time.Since(load.at) > probeFreshness || load.Draining {
				continue
			}
			candidates = append(candidates, candidate{adapter: node, standby: standby})
		}
	}
	return candidates
}

// Recover reserves room for a live Episode whose allocation was lost and returns where it
// now goes. It tries the candidates in placement order and takes the first node whose
// atomic reserve accepts the Episode's whole shape; a refusal or an unreachable node moves on
// to the next. When none accepts it returns mediaplane.ErrRecoveryRefused with a bounded
// reason and the binding stays as it was. Nothing here commits: the caller commits the
// binding move after this returns, and a reserve nobody commits expires by its TTL.
//
// The operation ID names the Episode, the generation the move would commit, the node and the
// current hold window. Calls in one window repeat the same operation, so replicas and a retry
// after a crash get one hold. The node replays a finished operation without checking that its
// hold is still alive, so a retry after the hold expired must not repeat it: the window moves
// on every hold lifetime, which gives that retry a new operation and a new hold.
//
// Recover never ends sessions. A node the Episode left earlier, back on the boot it left, may
// still hold the Episode's old sessions at Participant generations above the hold's, and then
// refuses the reserve as stale, so the Episode goes to another node or gets the capacity
// outcome. Ending those sessions here could close the ones a winning replica has since rejoined,
// because the end call carries no allocation fence.
func (f *Fleet) Recover(ctx context.Context, reason LossReason, from mediaplane.Binding, tenantID, episodeID string, participants int) (mediaplane.Placement, error) {
	candidates := f.recoveryCandidates()
	if len(candidates) == 0 {
		RecordRecovery(ctx, reason, outcomeNoNode)
		return mediaplane.Placement{}, fmt.Errorf("%w: %s", mediaplane.ErrRecoveryRefused, outcomeNoNode)
	}
	hold := f.recoveryHoldSeconds()
	window := time.Now().Unix() / int64(hold)
	refusals, failures := 0, 0
	for _, node := range candidates {
		reply, err := node.adapter.reserve(ctx, wireReserveRequest{
			OperationID: fmt.Sprintf("recover-%s-g%d-%s-p%d-w%d", episodeID, from.Generation+1, node.adapter.node, participants, window),
			TenantID:    tenantID, EpisodeID: episodeID, Generation: reserveHoldGeneration,
			Shape:      wireShape{Participants: participants, CamerasPerParticipant: recoveryCameras},
			TTLSeconds: hold,
		})
		switch {
		case err == nil && mediaplane.ValidIncarnation(reply.NodeIncarnation):
			reason := mediaplane.PlacementPrimary
			if node.standby {
				reason = mediaplane.PlacementStandby
			}
			return mediaplane.Placement{Node: node.adapter.node, Incarnation: reply.NodeIncarnation, Reason: reason}, nil
		case err == nil:
			failures++
			f.logRecovery(ctx, "chalk sfu reserve answered without an incarnation", node.adapter.node, nil)
		case errors.Is(err, mediaplane.ErrProviderRateLimited):
			refusals++
			f.logRecovery(ctx, "chalk sfu node refused the recovering episode", node.adapter.node, err)
		default:
			failures++
			f.logRecovery(ctx, "chalk sfu node could not reserve the recovering episode", node.adapter.node, err)
		}
		if ctx.Err() != nil {
			break
		}
	}
	// Only a pool where every node answered and said no is out of room; any other mix may
	// clear on its own, and the metric must not call it capacity.
	outcome := outcomeUnreachable
	if refusals > 0 && failures == 0 {
		outcome = outcomeNoRoom
	}
	RecordRecovery(ctx, reason, outcome)
	return mediaplane.Placement{}, fmt.Errorf("%w: %s", mediaplane.ErrRecoveryRefused, outcome)
}

func (f *Fleet) recoveryHoldSeconds() int {
	if f.holdSeconds > 0 {
		return f.holdSeconds
	}
	return recoveryHoldSeconds
}

// ChargeRecovered counts a recovered Episode against the node until the next probe shows its
// hold, as Place does for a new Episode. Only the caller whose binding commit won charges it,
// so replicas and racing requests that reserved the same Episode charge it once.
func (f *Fleet) ChargeRecovered(node string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.inflight[node] = append(f.inflight[node], time.Now())
}

func (f *Fleet) logRecovery(ctx context.Context, message, node string, err error) {
	if f.log == nil {
		return
	}
	attrs := []any{"event", "chalk_sfu.recovery", "node", node}
	if err != nil {
		attrs = append(attrs, "error", err.Error())
	}
	f.log.Log(ctx, slog.LevelWarn, message, attrs...)
}

// reserve asks the node to hold room for a whole Episode.
func (a *Adapter) reserve(ctx context.Context, request wireReserveRequest) (wireReserveResponse, error) {
	var reply wireReserveResponse
	if err := a.call(ctx, "/v1/episodes/reserve", request, &reply); err != nil {
		return wireReserveResponse{}, err
	}
	return reply, nil
}

// Bound returns the node's adapter for an Episode placed on the given boot incarnation. A
// join that the node answers for another incarnation is refused as stale instead of being
// handed to a client: the node restarted and the binding has not caught up yet.
func (a *Adapter) Bound(incarnation string) *Adapter {
	bound := *a
	bound.incarnation = incarnation
	return &bound
}

// checkIncarnation refuses a node's answer from an incarnation other than the one the
// Episode is bound to.
func (a *Adapter) checkIncarnation(answered string) error {
	if a.incarnation == "" || answered == "" || answered == a.incarnation {
		return nil
	}
	return fmt.Errorf("%w: %w", mediaplane.ErrPlaneUnavailable, errStaleIncarnation)
}

// EndRetired ends the Episode on every allocation its binding left, so a node that comes back
// still holding the Episode's old sessions releases them. It targets the retired allocation
// and never the current one:
//
//   - A retired allocation on the node the Episode is bound to now is skipped. That node
//     restarted, so the old incarnation holds nothing, or it is the current allocation again.
//   - A node that answers with another incarnation than the retired one holds nothing of it.
//   - A node that is silent cannot be reached. It is logged and skipped, because a node that
//     never returns must not keep the Episode's end from confirming.
//
// Ending an Episode that the node does not hold succeeds, so a retry is harmless.
func (f *Fleet) EndRetired(ctx context.Context, binding mediaplane.Binding, tenantID, episodeID string) error {
	var failures []error
	for _, old := range binding.PreviousAllocations {
		if old.Node == binding.Node {
			continue
		}
		adapter, err := f.Node(old.Node)
		if err != nil {
			continue // a node removed from the configuration has no process to clean
		}
		switch reason, lost := f.Lost(old); {
		case lost && reason == LossSilent:
			f.logRecovery(ctx, "chalk sfu retired node is not answering; its old sessions are not ended", old.Node, nil)
		case lost:
		default:
			if err := adapter.call(ctx, "/v1/episodes/end", wireEndRequest{TenantID: tenantID, EpisodeID: episodeID}, nil); err != nil {
				failures = append(failures, fmt.Errorf("end the episode on retired node %q: %w", old.Node, err))
			}
		}
	}
	return errors.Join(failures...)
}
