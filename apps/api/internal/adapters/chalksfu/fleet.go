package chalksfu

import (
	"context"
	"errors"
	"fmt"
	"github.com/q9labs/chalk/features/media/sfu/protocol"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	runtimeconfig "github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

const (
	probeInterval = 2 * time.Second
	probeTimeout  = time.Second
	// A probe older than this no longer counts, so a node that stops answering
	// leaves placement within a few intervals.
	probeFreshness = 3 * probeInterval
	// An Episode this process placed on a node counts against that node's room for
	// this long. The SFU reserves packets only at the Episode's first join, so a probe
	// taken before the join does not show it. The counter is a burst guard: the SFU's
	// admission at first join stays the authority.
	inflightTTL = 30 * time.Second
	// minNodeProtocol is the lowest SFU wire protocol this API can send to. The API puts
	// allocationGeneration in its create, reserve, move and source-control bodies, and a node
	// below protocol 2 refuses a body with a field it does not know (400 invalid_request). The
	// API places no Episode on such a node, so deploying the API before the SFU degrades
	// placement visibly and fails no call.
	minNodeProtocol = 2
)

// ErrUnknownNode means an Episode's binding names a node this process does not
// configure. The Episode is never moved to another node: its sessions live there.
var ErrUnknownNode = errors.New("chalk sfu node is not configured")

// Fleet is the SFU pool: every configured node in configuration order. A new
// Episode is placed on one node and its binding records it, so every later call
// for that Episode, cleanup included, goes to that node.
type Fleet struct {
	applicationID string
	overflow      bool
	nodes         []*Adapter
	standbys      map[string]bool // node IDs with the standby role
	standbyBudget int             // packets/s a standby admits for new Episodes
	log           *slog.Logger

	mu          sync.Mutex
	loads       map[string]nodeLoad
	seen        map[string]sighting    // when each node last answered a probe; a failed probe leaves it alone
	verdicts    map[string]verdict     // what each node's last answer said about its wire protocol; a failed probe leaves it alone
	inflight    map[string][]time.Time // when this process placed each recent Episode, by node; a probe leaves it alone
	probed      bool                   // a probe round has finished, so a node without a load record has none
	firstRound  time.Time              // when the first probe round finished
	holdSeconds int                    // how long a recovery's reservation waits for rejoins; zero means recoveryHoldSeconds
}

// sighting is a node's last answered probe. Unlike its load record, which a failed probe
// deletes so placement skips the node, it survives a failed probe, so one lost probe does not
// make a live node look lost.
type sighting struct {
	at          time.Time
	incarnation string
}

// verdict is whether a node can take this API's requests, learned from the protocol in its last
// answered /readyz. It is a fact about the node's build and survives a failed probe, unlike its
// load, so a node that falls silent stays known as compatible or as too old. A node with no
// verdict has never answered.
type verdict int

const (
	verdictUnknown verdict = iota
	verdictCompatible
	verdictTooOld
)

func verdictOf(version int) verdict {
	if version < minNodeProtocol {
		return verdictTooOld
	}
	return verdictCompatible
}

// nodeLoad is a node's last answered probe. A silent node has none. A draining node has one with
// Draining set, so placement skips it, and is told apart from a silent node.
type nodeLoad struct {
	room        int  // packets/s of budget left at the probe, below the standby cap on a standby
	episode     int  // packets/s a new Episode reserves
	hostGuard   bool // the node's host guard refuses new Episodes, whatever budget is left
	incarnation string
	NodeHealth
	at time.Time
}

// fits reports whether the room left holds one more new Episode after the in-flight
// ones, which the probe may not include yet.
func (l nodeLoad) fits(inflight int) bool { return l.room >= (inflight+1)*l.episode }

// NodeHealth is what a node's last answered probe said about its drain.
type NodeHealth struct {
	// Draining means the node refuses new Episodes and keeps its live ones.
	Draining bool
	// Allocations is what the node holds for live Episodes. A restart without interruption
	// waits for it and CleanupDebt to reach zero.
	Allocations int
	CleanupDebt int
}

// NewFleet builds one adapter per node. They share one mTLS client.
func NewFleet(config runtimeconfig.ChalkSFUConfig, log *slog.Logger) (*Fleet, error) {
	if len(config.Nodes) == 0 {
		return nil, fmt.Errorf("%w: no nodes", ErrMissingConfig)
	}
	if !slices.ContainsFunc(config.Nodes, func(node runtimeconfig.ChalkSFUNode) bool { return node.Role != runtimeconfig.ChalkSFURoleStandby }) {
		return nil, fmt.Errorf("%w: no primary node", ErrMissingConfig)
	}
	client, err := newClient(config)
	if err != nil {
		return nil, err
	}
	fleet := &Fleet{
		applicationID: config.ApplicationID,
		overflow:      config.CloudflareOverflow,
		standbys:      map[string]bool{},
		standbyBudget: config.StandbyPacketBudget,
		log:           log,
		loads:         map[string]nodeLoad{},
		seen:          map[string]sighting{},
		verdicts:      map[string]verdict{},
		inflight:      map[string][]time.Time{},
	}
	for _, node := range config.Nodes {
		adapter, err := newAdapter(config, node, client)
		if err != nil {
			return nil, err
		}
		fleet.nodes = append(fleet.nodes, adapter)
		if node.Role == runtimeconfig.ChalkSFURoleStandby {
			fleet.standbys[node.ID] = true
		}
	}
	return fleet, nil
}

// ApplicationID names the SFU pool for the Episode binding. It stays the same
// when nodes, hosts or certificates change.
func (f *Fleet) ApplicationID() string { return f.applicationID }

// CloudflareOverflow reports whether a new Episode may start on Cloudflare when
// no node has room.
func (f *Fleet) CloudflareOverflow() bool { return f.overflow }

// Node returns the adapter of the node an Episode is bound to.
func (f *Fleet) Node(id string) (*Adapter, error) {
	for _, node := range f.nodes {
		if node.node == id {
			return node, nil
		}
	}
	return nil, fmt.Errorf("%w: %w: node %q", mediaplane.ErrPlaneUnavailable, ErrUnknownNode, id)
}

// Allocation returns the adapter of the node an Episode is bound to, issued under the binding's
// boot incarnation (empty when the caller has none) and generation. Every create, source control
// and capture it sends names that generation, so the node refuses it once the Episode is retired
// above it. Production code reaches a node through here and not through Node, so no caller omits
// the generation.
func (f *Fleet) Allocation(id, incarnation string, generation int64) (*Adapter, error) {
	node, err := f.Node(id)
	if err != nil {
		return nil, err
	}
	return node.Bound(incarnation, generation), nil
}

// CapturePlane returns the recorder-facing plane of the allocation an Episode is bound to. The
// node refuses a capture once the Episode is retired above the generation, and the plane refuses
// an answer from another boot than the incarnation.
func (f *Fleet) CapturePlane(id, incarnation string, generation int64) (captureplane.CapturePlane, error) {
	return f.Allocation(id, incarnation, generation)
}

// Place picks the node for a new Episode. Primaries are tried first, in
// configuration order, and a standby only when no primary can take it (silent,
// draining, host-guard closed or out of budget). Only a node whose last answer showed a wire
// protocol of at least minNodeProtocol is eligible, so no Episode is bound to a node that is old
// or has not answered yet. A node qualifies when that holds, its last probe is fresh and ready,
// and it has packet budget left for a new Episode, after the Episodes this process placed there
// in the last inflightTTL, so concurrent creations do not all pin to the last slot, even across
// a probe that does not show them yet. A standby counts only the degraded budget it is configured
// with. The first qualifying node wins and room is true. The placement then records the node,
// its boot incarnation from that probe and whether it is a primary or a standby.
//
// A node whose protocol is below minNodeProtocol, or that has not yet answered a probe, never
// takes a new Episode. When no node qualifies, every node would refuse the Episode, so room is
// false, no node is named, and the caller starts the Episode on another provider or refuses it.
// The reason says why: a node that takes new Episodes was full, else a node's host guard refused
// them (spare budget or not), else every answering node was draining, else
// overflow_node_protocol_too_old when some node is known to be old, else overflow_node_unavailable.
//
// It reads the last probes and does no I/O, because Episode creation calls it inside a database
// transaction.
func (f *Fleet) Place() (placement mediaplane.Placement, room bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var answering, full, guarded, tooOld bool // a compatible node answered; one was full; one's host guard refused; some node is known to be old
	for _, standby := range []bool{false, true} {
		for _, node := range f.nodes {
			if f.standbys[node.node] != standby {
				continue
			}
			switch f.verdicts[node.node] {
			case verdictTooOld:
				tooOld = true
				continue
			case verdictUnknown:
				continue
			}
			load, probed := f.loads[node.node]
			if !probed || time.Since(load.at) > probeFreshness {
				continue
			}
			answering = true
			switch {
			case load.Draining:
			case load.hostGuard:
				guarded = true
			case !load.fits(len(f.inflightOn(node.node))):
				full = true
			default:
				f.inflight[node.node] = append(f.inflight[node.node], time.Now())
				reason := mediaplane.PlacementPrimary
				if standby {
					reason = mediaplane.PlacementStandby
				}
				return mediaplane.Placement{Node: node.node, Incarnation: load.incarnation, Reason: reason}, true
			}
		}
	}
	none := mediaplane.Placement{Reason: mediaplane.PlacementOverflowNodeUnavailable}
	switch {
	case full:
		none.Reason = mediaplane.PlacementOverflowNoRoom
	case guarded:
		none.Reason = mediaplane.PlacementOverflowHostGuard
	case answering:
		none.Reason = mediaplane.PlacementOverflowDraining
	case tooOld:
		none.Reason = mediaplane.PlacementOverflowNodeProtocol
	}
	return none, false
}

// inflightOn returns the Episodes placed on a node less than inflightTTL ago and
// forgets older ones. It holds f.mu.
func (f *Fleet) inflightOn(node string) []time.Time {
	live := slices.DeleteFunc(f.inflight[node], func(at time.Time) bool { return time.Since(at) > inflightTTL })
	f.inflight[node] = live
	return live
}

// Watch probes every node's readiness until ctx ends.
func (f *Fleet) Watch(ctx context.Context) {
	ticker := time.NewTicker(probeInterval)
	defer ticker.Stop()
	for {
		f.Probe(ctx)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// Health reports a node's drain state from its last probe. It reports false when the node did
// not answer recently, so a silent node reads as unknown rather than as serving.
func (f *Fleet) Health(node string) (NodeHealth, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	load, probed := f.loads[node]
	if !probed || time.Since(load.at) > probeFreshness {
		return NodeHealth{}, false
	}
	return load.NodeHealth, true
}

// Probe reads every node's readiness once, concurrently. A node that does not
// answer loses its load record and with it its place in placement. A draining
// node keeps a record that says so, and it too is out of placement.
func (f *Fleet) Probe(ctx context.Context) {
	var wg sync.WaitGroup
	for _, node := range f.nodes {
		wg.Go(func() { f.probeNode(ctx, node) })
	}
	wg.Wait()
	f.mu.Lock()
	if !f.probed {
		f.firstRound = time.Now()
	}
	f.probed = true
	f.mu.Unlock()
}

// probeNode asks one node for its readiness and records the answer.
func (f *Fleet) probeNode(ctx context.Context, node *Adapter) {
	probeCtx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	ready, err := node.ready(probeCtx)
	f.mu.Lock()
	defer f.mu.Unlock()
	before, known := f.loads[node.node]
	if err != nil {
		// A missed probe keeps the last sample: it stays usable until probeFreshness
		// passes, so one lost probe neither removes a working node from placement nor
		// forgets whether it speaks the protocol. Only the first misses are logged.
		if known && time.Since(before.at) <= probeFreshness {
			if before.Draining {
				f.logTransition(ctx, slog.LevelInfo, "chalk sfu draining node stopped answering", node.node)
			} else {
				f.logTransition(ctx, slog.LevelWarn, "chalk sfu node missed a probe", node.node)
			}
		}
		return
	}
	switch {
	case ready.Draining && !(known && before.Draining):
		f.logTransition(ctx, slog.LevelInfo, "chalk sfu node draining", node.node, "allocations", ready.Allocations, "cleanupDebt", ready.CleanupDebt)
	case !ready.Draining && known && before.Draining:
		f.logTransition(ctx, slog.LevelInfo, "chalk sfu node no longer draining", node.node)
	}
	now := time.Now()
	load := f.loadOf(node.node, ready, now)
	seen := verdictOf(ready.Protocol)
	if seen == verdictTooOld && f.verdicts[node.node] != verdictTooOld {
		f.logTransition(ctx, slog.LevelWarn, "chalk sfu node is out of placement", node.node, "reason", NodeProtocolTooOld, "protocol", ready.Protocol, "minProtocol", minNodeProtocol, "revision", boundedRevision(ready.Revision))
	}
	f.verdicts[node.node] = seen
	f.loads[node.node] = load
	f.seen[node.node] = sighting{at: now, incarnation: load.incarnation}
}

// loadOf turns a node's ready answer into its load record, with no placed
// Episodes. A standby's budget is capped at the degraded budget the Fleet is
// configured with.
func (f *Fleet) loadOf(node string, ready protocol.ReadyResponse, at time.Time) nodeLoad {
	budget := ready.PacketBudget
	if f.standbys[node] {
		budget = min(budget, f.standbyBudget)
	}
	incarnation := ready.NodeIncarnation
	if !mediaplane.ValidIncarnation(incarnation) {
		incarnation = "" // a malformed value must not fail Episode creation
	}
	return nodeLoad{
		room:        budget - ready.ReservedPackets,
		episode:     ready.NewEpisodePackets,
		hostGuard:   ready.Host.AdmissionReason != "",
		incarnation: incarnation,
		NodeHealth:  NodeHealth{Draining: ready.Draining, Allocations: ready.Allocations, CleanupDebt: ready.CleanupDebt},
		at:          at,
	}
}

// NodeProtocolTooOld is the bounded reason a node is out of placement: it decodes an older wire
// protocol than this API sends. The same words name the placement reason overflow_node_protocol_too_old.
const NodeProtocolTooOld = "node_protocol_too_old"

// boundedRevision keeps a node-reported value out of the log unless it is a commit id.
func boundedRevision(revision string) string {
	if len(revision) != 40 || strings.Trim(revision, "0123456789abcdef") != "" {
		return ""
	}
	return revision
}

func (f *Fleet) logTransition(ctx context.Context, level slog.Level, message, node string, attrs ...any) {
	if f.log != nil {
		f.log.Log(ctx, level, message, append([]any{"node", node}, attrs...)...)
	}
}
