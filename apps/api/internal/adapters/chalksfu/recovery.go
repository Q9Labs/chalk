package chalksfu

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"github.com/q9labs/chalk/features/media/sfu/protocol"
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
	// An Episode's reservation already assumes a screen share may run, so the reserve asks for
	// one: the node then checks that the Episode's mandatory media fits its ceiling with a screen
	// share, and a share that is live now cannot be refused after the Participants rejoin.
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

// Confirm is Lost with one fresh probe before it reports a restart. A replica's last probe can
// predate a restart that another replica already recovered from, and then the binding's
// incarnation is the newer one; asking the node settles which side is stale, so a healthy
// allocation is never recovered a second time.
func (f *Fleet) Confirm(ctx context.Context, allocation mediaplane.Allocation) (LossReason, bool) {
	reason, lost := f.Lost(allocation)
	if !lost || reason != LossRestarted {
		return reason, lost
	}
	if node, err := f.Node(allocation.Node); err == nil {
		f.probeNode(ctx, node)
	}
	return f.Lost(allocation)
}

// candidate is a node a recovery may reserve on.
type candidate struct {
	adapter *Adapter
	standby bool
}

// recoveryCandidates lists the nodes that may take a recovering Episode, in the order Place
// uses: every primary that answered within the freshness window, is not draining and speaks a wire protocol this API can send, then the
// same standbys. It does not guess at capacity from the probe: the probe's totals do not show
// what the Episode already holds on a node, and a standby's degraded budget is enforced by the
// node's own reserve (see protocol.ReserveEpisodeRequest.PacketCeiling), so the node's answer decides. It
// does no I/O and, unlike Place, never offers another provider.
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
			if !probed || time.Since(load.at) > probeFreshness || load.Draining || f.verdicts[node.node] != verdictCompatible {
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
	committed := from.Generation + 1
	refusals, failures := 0, 0
	for _, node := range candidates {
		ceiling := 0
		if node.standby && f.standbyBudget > 0 {
			ceiling = f.standbyBudget
		}
		request := protocol.ReserveEpisodeRequest{
			OperationID:   recoveryOperationID(episodeID, committed, node.adapter.node, participants, ceiling, window),
			PacketCeiling: ceiling, AllocationGeneration: &committed,
			TenantID: tenantID, EpisodeID: episodeID, Generation: reserveHoldGeneration,
			// A recovered Episode may have a screen share live, and a share the node cannot carry
			// would be refused after its Participants rejoined, so the reserve always holds room for
			// one. A node that cannot carry the Episode with a share refuses, and that is the
			// capacity outcome.
			Shape:      protocol.EpisodeShape{Participants: participants, CamerasPerParticipant: recoveryCameras, ScreenShare: true},
			TTLSeconds: hold,
		}
		reply, err := node.adapter.reserve(ctx, request)
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

// recoveryOperationID names one reserve by the Episode, the generation the move would commit, the
// node, the participant count, the packet ceiling and the hold window. The node compares a replayed
// operation's whole body, so replicas that send another ceiling (a rolling change to the standby
// budget) must not share an ID. The tuple is hashed, because a long node ID and an Episode
// ID together exceed the 128 characters the SFU accepts.
func recoveryOperationID(episodeID string, generation int64, node string, participants, packetCeiling int, window int64) string {
	digest := sha256.Sum256(fmt.Appendf(nil, "%s\x00%d\x00%s\x00%d\x00%d\x00%d", episodeID, generation, node, participants, packetCeiling, window))
	return "recover-" + hex.EncodeToString(digest[:16])
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
func (a *Adapter) reserve(ctx context.Context, request protocol.ReserveEpisodeRequest) (protocol.ReserveEpisodeResponse, error) {
	var reply protocol.ReserveEpisodeResponse
	if err := a.call(ctx, protocol.RouteEpisodesReserve, request, &reply); err != nil {
		return protocol.ReserveEpisodeResponse{}, err
	}
	return reply, nil
}

// Bound returns the node's adapter for an Episode placed on the given boot incarnation and
// binding generation. Every create, capture and source control it sends names that generation, so
// the node refuses it once the Episode is retired above it (see Retire). A
// join that the node answers for another incarnation is refused as stale instead of being
// handed to a client: the node restarted and the binding has not caught up yet.
func (a *Adapter) Bound(incarnation string, generation int64) *Adapter {
	bound := *a
	bound.incarnation = incarnation
	bound.allocation = &generation
	return &bound
}

// WithFence returns an adapter that checks a join against the Episode's durable binding once
// the node has created the session. A replica that resolved the binding before another one moved
// it would otherwise create a second live allocation on the node the Episode left, and the
// incarnation check cannot see that, because it compares against the replica's own stale
// binding. When the fence fails, the join closes its session on the node it was issued to and
// returns the fence's error, which the caller retries under the current binding.
func (a *Adapter) WithFence(fence func(context.Context) error) *Adapter {
	fenced := *a
	fenced.fence = fence
	return &fenced
}

// checkIncarnation refuses a node's answer from an incarnation other than the one the
// Episode is bound to.
func (a *Adapter) checkIncarnation(answered string) error {
	if a.incarnation == "" || answered == "" || answered == a.incarnation {
		return nil
	}
	return fmt.Errorf("%w: %w", mediaplane.ErrPlaneUnavailable, errStaleIncarnation)
}

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
	metric.WithDescription("Retire calls to the Chalk SFU allocations whole-Episode recovery left, by outcome"),
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
	err = adapter.call(nodeCtx, protocol.RouteEpisodesRetire, protocol.RetireEpisodeRequest{TenantID: tenantID, EpisodeID: episodeID, Generation: generation}, nil)
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
